/**
 * VTTPreFetcher — subtitle timeline source and pre-fetcher.
 *
 * Discovers the source-language WebVTT track of the Udemy player, parses it, builds the
 * display timeline (sentence units, or raw cues when sentence mode is off) and pre-translates
 * upcoming units into the TranslationClient memory cache.
 */
import type { LanguageCode, BatchTranslationRequest } from '../shared/types';
import type { TranslationClient } from '../translation/TranslationClient';
import { CueGrouper } from './CueGrouper';
import {
  PREFETCH_BATCH_MAX_SEC,
  PREFETCH_BATCH_MAX_SEGMENTS,
  PREFETCH_BATCH_MIN_SEC,
  PREFETCH_MAX_BATCHES,
  PREFETCH_WINDOW_SEC,
  VTT_LOAD_RETRY_MS,
} from '../shared/constants';
import { cleanCueText, log, logError } from '../shared/utils';
import { MessageError, sendToBackground } from '../shared/messages';
import { parseWebVTT } from '../subtitles/VttParser';
import { assembleUnits, findActiveIndex, findUpcomingIndex, type TimedText } from '../subtitles/SentenceAssembler';
import { pickSourceTrack } from '../subtitles/trackSelection';
import { isMatchingCaptionFile } from '../subtitles/vttMatching';

/** Caption files seen on the page (kept across lesson changes: the next lesson's file may arrive first) */
const MAX_CANDIDATES = 10;

export type ParsedCue = TimedText;

export class VTTPreFetcher {
  private cues: TimedText[] = [];
  private units: TimedText[] = [];
  private sentenceMode = true;
  /** Identifies the loaded track (src URL, or label/lang/count for TextTrack cues) */
  private loadedTrackId = '';
  private loading: Promise<boolean> | null = null;
  private lastAttemptAt = 0;
  private preFetchedTexts = new Set<string>();
  /** url → parsed cues of caption files downloaded by the player (null while loading/failed) */
  private candidates = new Map<string, TimedText[] | null>();

  /**
   * Resets state (e.g. on lecture navigation). Candidates are kept on purpose.
   */
  reset(): void {
    this.cues = [];
    this.units = [];
    this.loadedTrackId = '';
    this.loading = null;
    this.lastAttemptAt = 0;
    this.preFetchedTexts.clear();
  }

  /** Merge cues into sentence units (true) or display raw cues (false). */
  setSentenceMode(enabled: boolean): void {
    if (this.sentenceMode === enabled) return;
    this.sentenceMode = enabled;
    this.rebuildUnits();
    this.preFetchedTexts.clear();
  }

  private setCues(cues: TimedText[], trackId: string): void {
    this.cues = cues;
    this.loadedTrackId = trackId;
    this.rebuildUnits();
    this.preFetchedTexts.clear();
  }

  private rebuildUnits(): void {
    this.units = this.sentenceMode ? assembleUnits(this.cues) : this.cues.slice();
  }

  /**
   * Discovers and loads the source-language cues. Concurrent calls share one attempt, and
   * attempts are throttled unless `force` is set (track added/changed).
   */
  loadFromVideo(video: HTMLVideoElement, sourceLang: string, force = false): Promise<boolean> {
    if (this.loading) return this.loading;
    if (!force && Date.now() - this.lastAttemptAt < VTT_LOAD_RETRY_MS) {
      return Promise.resolve(this.hasCues());
    }
    this.lastAttemptAt = Date.now();
    this.loading = this.discover(video, sourceLang).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async discover(video: HTMLVideoElement, sourceLang: string): Promise<boolean> {
    // 1. <track src> elements
    const trackElements = Array.from(video.querySelectorAll('track'));
    const trackIndex = pickSourceTrack(
      trackElements.map((el) => ({ kind: el.kind, language: el.srclang, label: el.label })),
      sourceLang
    );
    const trackEl = trackIndex >= 0 ? trackElements[trackIndex] : null;

    if (trackEl?.src) {
      if (trackEl.src === this.loadedTrackId && this.hasCues()) return true;
      try {
        const vttText = await this.fetchVtt(trackEl.src);
        const parsed = vttText ? parseWebVTT(vttText) : [];
        if (parsed.length > 0) {
          this.setCues(parsed, trackEl.src);
          log(`VTTPreFetcher: loaded ${parsed.length} cues from track src`);
          return true;
        }
      } catch (err) {
        logError('VTTPreFetcher: failed to fetch track src:', err);
      }
    }

    // 2. video.textTracks (cues are only available while the track is not disabled)
    const tracks = Array.from(video.textTracks || []);
    const textTrackIndex = pickSourceTrack(
      tracks.map((t) => ({ kind: t.kind, language: t.language, label: t.label })),
      sourceLang
    );
    const track = textTrackIndex >= 0 ? tracks[textTrackIndex] : null;
    if (track?.cues && track.cues.length > 0) {
      const trackId = `${track.label}|${track.language}|${track.cues.length}`;
      if (trackId === this.loadedTrackId && this.hasCues()) return true;

      const parsed: TimedText[] = [];
      for (let j = 0; j < track.cues.length; j++) {
        const cue = track.cues[j] as VTTCue;
        const text = cleanCueText(cue.text || '');
        if (text) parsed.push({ startTime: cue.startTime, endTime: cue.endTime, text });
      }
      if (parsed.length > 0) {
        parsed.sort((a, b) => a.startTime - b.startTime);
        this.setCues(parsed, trackId);
        log(`VTTPreFetcher: loaded ${parsed.length} cues from TextTrack API`);
        return true;
      }
    }

    return this.hasCues();
  }

  /**
   * Fetches VTT text directly, or through the background worker if CORS blocks the content script.
   */
  private async fetchVtt(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        return await resp.text();
      }
    } catch {
      // Content script fetch restricted by CORS, fallback to background service worker
    }

    try {
      return await sendToBackground('FETCH_VTT', { url });
    } catch {
      return null;
    }
  }

  /**
   * Downloads a caption file the player fetched (seen via resource timing / webRequest).
   * It becomes the timeline only after it matches the caption on screen (tryMatchDomText).
   */
  async addCandidateUrl(url: string): Promise<void> {
    if (this.candidates.has(url)) return;
    if (this.candidates.size >= MAX_CANDIDATES) {
      const oldest = this.candidates.keys().next().value;
      if (oldest) this.candidates.delete(oldest);
    }
    this.candidates.set(url, null);
    try {
      const vttText = await this.fetchVtt(url);
      const parsed = vttText ? parseWebVTT(vttText) : [];
      this.candidates.set(url, parsed);
      log(`VTTPreFetcher: caption file candidate with ${parsed.length} cues`);
    } catch (err) {
      logError('VTTPreFetcher: failed to fetch caption file candidate:', err);
    }
  }

  /**
   * Uses the newest candidate whose cues contain the caption currently shown by the player.
   */
  tryMatchDomText(domText: string, currentTime: number, videoDuration: number): boolean {
    if (this.hasCues()) return true;
    for (const [url, cues] of Array.from(this.candidates).reverse()) {
      if (cues && isMatchingCaptionFile(cues, domText, currentTime, videoDuration)) {
        this.setCues(cues, url);
        log(`VTTPreFetcher: loaded ${cues.length} cues from the player's caption file`);
        return true;
      }
    }
    return false;
  }

  /** Display timeline (sentence units or cues) */
  getUnits(): TimedText[] {
    return this.units;
  }

  findUnitAt(currentTime: number): TimedText | undefined {
    const index = findActiveIndex(this.units, currentTime);
    return index >= 0 ? this.units[index] : undefined;
  }

  getUpcomingUnit(currentTime: number): TimedText | undefined {
    const index = findUpcomingIndex(this.units, currentTime);
    return index >= 0 ? this.units[index] : undefined;
  }

  /**
   * Clears in-flight tracking (e.g. on seek, or when cached translations became invalid).
   */
  clearInFlight(): void {
    this.preFetchedTexts.clear();
  }

  /**
   * Pre-translates the units of the next PREFETCH_WINDOW_SEC in large low-priority batches.
   */
  preFetchUpcoming(currentTime: number, source: LanguageCode, target: LanguageCode, client: TranslationClient): void {
    if (this.units.length === 0) return;

    const maxTime = currentTime + PREFETCH_WINDOW_SEC;
    const groups = CueGrouper.groupAll(
      this.units,
      PREFETCH_BATCH_MIN_SEC,
      PREFETCH_BATCH_MAX_SEC,
      PREFETCH_BATCH_MAX_SEGMENTS
    ).filter((g) => g.endTime > currentTime && g.startTime <= maxTime);

    let batchesScheduled = 0;
    for (const group of groups) {
      if (batchesScheduled >= PREFETCH_MAX_BATCHES) break;

      const needsTranslation = group.segments.some(
        (seg) =>
          !client.getCached(seg.text, source, target) &&
          !client.getPending(seg.text, source, target) &&
          !this.preFetchedTexts.has(seg.text)
      );
      if (!needsTranslation) continue;

      for (const seg of group.segments) this.preFetchedTexts.add(seg.text);
      batchesScheduled++;

      const request: BatchTranslationRequest = {
        segments: group.segments,
        previousContext: group.previousContext,
        previousTranslations: previousTranslationsFor(group.previousContext, source, target, client),
        nextContext: group.nextContext,
        source,
        target,
        priority: 'low',
      };

      client.translateBatch(request).then(
        (res) => {
          // Segments that came back empty may be requested again later.
          for (const seg of res.segments) if (!seg.text) this.preFetchedTexts.delete(request.segments[seg.id - 1]?.text);
        },
        (err) => {
          if (!(err instanceof MessageError && err.cancelled)) logError('VTTPreFetcher: pre-fetch batch failed:', err);
          for (const seg of group.segments) this.preFetchedTexts.delete(seg.text);
        }
      );
    }
  }

  hasCues(): boolean {
    return this.units.length > 0;
  }
}

/** Already-known translations of the context segments, for consistent terminology across batches. */
export function previousTranslationsFor(
  previousContext: string[] | undefined,
  source: LanguageCode,
  target: LanguageCode,
  client: Pick<TranslationClient, 'getCached'>
): string[] {
  return (previousContext || [])
    .map((text) => client.getCached(text, source, target)?.translatedText || '')
    .filter(Boolean);
}
