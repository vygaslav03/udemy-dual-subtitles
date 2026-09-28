/**
 * Decides whether a downloaded VTT file is the one the player is showing right now,
 * by comparing its cues with the caption text currently rendered in the DOM.
 * This works regardless of language labels or URL formats.
 */
import type { TimedText } from './SentenceAssembler';

/** Seconds of tolerance between the DOM caption and the cue timing */
const TIME_TOLERANCE_SEC = 2;
/** A full caption file must cover at least this share of the video (rejects HLS segments) */
const MIN_COVERAGE = 0.5;
/** Substring matches are only trusted for reasonably long captions */
const MIN_PARTIAL_MATCH_CHARS = 15;

export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function cueMatchesText(cueText: string, domText: string): boolean {
  const cue = normalizeForMatch(cueText);
  const dom = normalizeForMatch(domText);
  if (!cue || !dom) return false;
  if (cue === dom) return true;
  return dom.length >= MIN_PARTIAL_MATCH_CHARS && (cue.includes(dom) || dom.includes(cue));
}

/**
 * True if `cues` contain the caption `domText` near `currentTime` and plausibly cover the whole video.
 */
export function isMatchingCaptionFile(
  cues: TimedText[],
  domText: string,
  currentTime: number,
  videoDuration: number
): boolean {
  if (cues.length === 0 || !domText.trim()) return false;

  if (Number.isFinite(videoDuration) && videoDuration > 0) {
    const lastEnd = cues[cues.length - 1].endTime;
    if (lastEnd < videoDuration * MIN_COVERAGE) return false;
  }

  return cues.some(
    (cue) =>
      currentTime >= cue.startTime - TIME_TOLERANCE_SEC &&
      currentTime <= cue.endTime + TIME_TOLERANCE_SEC &&
      cueMatchesText(cue.text, domText)
  );
}

/** Subtitle files, not thumbnail sprites or HLS playlists. */
export function isVttResourceUrl(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    const udemyHost = hostname.endsWith('udemycdn.com') || hostname.endsWith('udemy.com');
    return udemyHost && /\.(web)?vtt$/i.test(pathname) && !/thumb|sprite|storyboard/i.test(pathname);
  } catch {
    return false;
  }
}
