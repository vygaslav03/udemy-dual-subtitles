/**
 * Content Script Entry Point — Udemy Dual Subtitles.
 *
 * This is the main orchestrator that initializes all content script modules.
 * It runs only on udemy.com pages.
 *
 * Flow:
 * 1. Load settings
 * 2. Start SubtitleDetector (with retries & container awareness)
 * 3. Per detected player, start a session: all listeners/loops are bound to one AbortController
 * 4. Timeline source: VTT cues (merged into sentence units) driven by the video clock;
 *    the DOM caption observer is used only while no VTT timeline is available
 * 5. Mount SubtitleRenderer (handles dual display + native subtitle hiding)
 * 6. NavigationWatcher + URL_CHANGED from background → re-initialize on lesson change
 * 7. SelectionTranslator + WordTooltip with TranslationClient
 */
import { SubtitleDetector, type DetectionResult } from './SubtitleDetector';
import { SubtitleObserver } from './SubtitleObserver';
import { SubtitleRenderer } from './SubtitleRenderer';
import { NavigationWatcher } from './NavigationWatcher';
import { SelectionTranslator } from './SelectionTranslator';
import { WordTooltip } from './WordTooltip';
import { SentenceSegmenter } from './SentenceSegmenter';
import { VTTPreFetcher, previousTranslationsFor } from './VTTPreFetcher';
import { CueGrouper } from './CueGrouper';
import { TranslationClient, TranslationRequestError } from '../translation/TranslationClient';
import { getProviderConfig, loadSettings, onCacheCleared, onSettingsChanged, saveDictionaryWord } from '../shared/storage';
import type { ExtensionSettings } from '../shared/types';
import { debounce, isUdemyCoursePage, lessonKey, log, logError, logWarn } from '../shared/utils';
import { REINIT_DELAY_MS, SUBTITLE_DEBOUNCE_MS } from '../shared/constants';
import { isVttResourceUrl } from '../subtitles/vttMatching';

const DETECTION_MAX_RETRIES = 30;
const PREFETCH_THROTTLE_MS = 3000;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

class UdemyDualSubtitles {
  private settings!: ExtensionSettings;
  private detector = new SubtitleDetector();
  private observer!: SubtitleObserver;
  private renderer!: SubtitleRenderer;
  private navigationWatcher!: NavigationWatcher;
  private selectionTranslator!: SelectionTranslator;
  private wordTooltip!: WordTooltip;
  private translationClient = new TranslationClient();
  private segmenter = new SentenceSegmenter();
  private vtt = new VTTPreFetcher();

  private detectionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Everything bound to the current player (listeners, frame loop) is released through this */
  private session: AbortController | null = null;
  private video: HTMLVideoElement | null = null;
  private currentLesson = lessonKey(window.location.href);

  private lastSubtitleText = '';
  /** Last caption text rendered by the Udemy player (used to identify its caption file) */
  private lastDomText = '';
  private previousText = '';
  private activeTranslationId = 0;
  private lastPrefetchAt = 0;

  async init(): Promise<void> {
    log('Initializing Udemy Dual Subtitles...');

    try {
      // 1. Load settings
      this.settings = await loadSettings();
      this.vtt.setSentenceMode(this.settings.smartSentenceMode);
      log(`Settings loaded. Enabled: ${this.settings.enabled}, Provider: ${this.settings.translationProvider}`);

      // 2. Initialize SubtitleRenderer
      this.renderer = new SubtitleRenderer(this.settings);
      this.renderer.onRetry(() => this.refreshCurrent());

      // 3. DOM caption observer (fallback source when no VTT timeline is available)
      this.observer = new SubtitleObserver(
        debounce((text: string) => this.onDomSubtitle(text), SUBTITLE_DEBOUNCE_MS)
      );

      // 4. SPA navigation (lesson changes)
      this.navigationWatcher = new NavigationWatcher((url) => this.handleNavigation(url));
      this.navigationWatcher.start();

      // 5. Initialize SelectionTranslator
      this.selectionTranslator = new SelectionTranslator(this.translationClient, this.settings);
      this.selectionTranslator.onSaveWord((word, translation) => {
        this.saveWord(word, translation, '', '');
      });
      this.selectionTranslator.init();

      // 6. Initialize WordTooltip (QA Learning Mode)
      this.wordTooltip = new WordTooltip(this.translationClient, this.settings);
      this.wordTooltip.onSaveWord((word, translation, qaMeaning, example) => {
        this.saveWord(word, translation, qaMeaning, example);
      });
      if (this.settings.qaLearningMode) {
        this.wordTooltip.enable();
      }

      // 7. Listen for settings changes and cache clears
      onSettingsChanged((newSettings, oldSettings) => this.onSettingsChanged(newSettings, oldSettings));
      onCacheCleared(() => {
        this.translationClient.clearMemCache();
        this.vtt.clearInFlight();
      });

      // 8. Listen for messages from popup/background
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        this.handleMessage(message, sendResponse);
        return false; // responses are sent synchronously
      });

      // 9. Caption files downloaded by the player (Udemy renders captions itself, without <track>)
      this.watchCaptionFiles();

      // 10. Start subtitle detection
      this.startDetection();

      log('Udemy Dual Subtitles initialized successfully');
    } catch (err) {
      logError('Initialization failed:', err);
    }
  }

  // ============================================================
  // Detection & session lifecycle
  // ============================================================

  /**
   * Starts subtitle detection with retry logic.
   * Udemy loads video player asynchronously, so we wait until <video> is mounted.
   */
  private startDetection(retryCount = 0): void {
    this.detectionTimer = null;
    if (!isUdemyCoursePage()) {
      log('Not a Udemy course page, waiting for navigation...');
      return;
    }

    const result = this.detector.detect();

    // Ensure we have a video player to attach to
    if (
      (result.subtitleElement || result.strategy === 'TextTrack API') &&
      (result.playerContainer || result.videoElement)
    ) {
      this.onDetectionSuccess(result);
    } else if (retryCount < DETECTION_MAX_RETRIES) {
      const delay = Math.min(800 + retryCount * 200, 2000);
      this.detectionTimer = setTimeout(() => this.startDetection(retryCount + 1), delay);
    } else {
      log('Subtitle detection waiting for video playback...');
    }
  }

  /**
   * Called when video player & subtitles are ready. Starts a new session.
   */
  private onDetectionSuccess(result: DetectionResult): void {
    log(`Subtitles initialized via: ${result.strategy}`);
    this.endSession();
    const session = new AbortController();
    this.session = session;

    // Mount renderer to player container (guaranteed non-null)
    const mountTarget =
      result.playerContainer ||
      this.findBestMountTarget(result.videoElement) ||
      result.videoElement?.parentElement ||
      document.body;

    this.renderer.mount(mountTarget);

    // DOM observer: fallback source (ignored while the VTT timeline is loaded)
    if (result.subtitleElement) {
      this.observer.observeElement(result.subtitleElement);
    } else if (result.videoElement && result.strategy === 'TextTrack API') {
      this.observer.observeTextTracks(result.videoElement);
    }

    if (result.videoElement) {
      this.attachVideo(result.videoElement, session.signal);
    }
  }

  /**
   * Binds the video clock to the subtitle timeline. All listeners are removed when the session ends.
   */
  private attachVideo(video: HTMLVideoElement, signal: AbortSignal): void {
    this.video = video;

    const loadTimeline = (force = false) => {
      this.vtt.loadFromVideo(video, this.settings.sourceLanguage, force).then((loaded) => {
        if (loaded && !signal.aborted) {
          this.syncToTime(video.currentTime);
          this.preFetchUpcoming(true);
        }
      });
    };

    // Frame-accurate clock while playing (timeupdate alone lags up to ~250 ms).
    let frameLoopPending = false;
    const frameVideo = video as VideoWithFrameCallback;
    const startFrameLoop = () => {
      if (frameLoopPending || !frameVideo.requestVideoFrameCallback) return;
      const step = () => {
        frameLoopPending = false;
        if (signal.aborted || video.paused) return;
        if (this.vtt.hasCues()) this.syncToTime(video.currentTime);
        frameLoopPending = true;
        frameVideo.requestVideoFrameCallback!(step);
      };
      frameLoopPending = true;
      frameVideo.requestVideoFrameCallback(step);
    };

    video.addEventListener(
      'seeked',
      () => {
        this.previousText = '';
        this.vtt.clearInFlight();
        this.translationClient.cancelPrefetch();
        this.syncToTime(video.currentTime);
        this.preFetchUpcoming(true);
      },
      { signal }
    );

    video.addEventListener(
      'playing',
      () => {
        if (!this.vtt.hasCues()) loadTimeline();
        startFrameLoop();
        this.preFetchUpcoming(true);
      },
      { signal }
    );

    video.addEventListener(
      'timeupdate',
      () => {
        if (this.vtt.hasCues()) {
          this.syncToTime(video.currentTime);
          this.preFetchUpcoming();
        } else {
          loadTimeline(); // throttled inside VTTPreFetcher
        }
      },
      { signal }
    );

    // Subtitle track added or switched in the Udemy player → reload the source-language timeline.
    video.textTracks?.addEventListener('addtrack', () => loadTimeline(true), { signal });
    video.textTracks?.addEventListener('change', () => loadTimeline(true), { signal });

    loadTimeline(true);
    if (!video.paused) startFrameLoop();
  }

  private endSession(): void {
    this.session?.abort();
    this.session = null;
    this.video = null;
    this.observer?.disconnect();
  }

  /**
   * Finds the best element to mount the subtitle renderer.
   */
  private findBestMountTarget(videoEl: HTMLVideoElement | null): HTMLElement | null {
    if (videoEl) {
      let parent = videoEl.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        if (style.position !== 'static') return parent;
        parent = parent.parentElement;
      }
      return videoEl.parentElement;
    }
    return null;
  }

  /**
   * Lesson changes only: hash/query changes (lecture tabs, `?start=`) are ignored.
   * Both NavigationWatcher and the background's URL_CHANGED land here, so one change
   * triggers exactly one re-initialization.
   */
  private handleNavigation(url: string): void {
    const key = lessonKey(url);
    if (key === this.currentLesson) return;
    this.currentLesson = key;
    log(`Navigation to: ${url}`);
    this.reinitialize();
  }

  /**
   * Re-initializes after navigation (lesson change).
   */
  private reinitialize(): void {
    log('Re-initializing after navigation...');
    this.endSession();
    this.renderer.cleanup();
    this.detector.reset();
    this.vtt.reset();
    this.translationClient.cancelPrefetch();
    this.previousText = '';
    this.lastSubtitleText = '';
    this.lastDomText = '';
    this.activeTranslationId++;

    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer);
    }
    // Wait for new page elements to load
    this.detectionTimer = setTimeout(() => this.startDetection(), REINIT_DELAY_MS);
  }

  // ============================================================
  // Subtitle flow
  // ============================================================

  /** VTT timeline: show the unit active at `time`. */
  private syncToTime(time: number, force = false): void {
    const unit = this.vtt.findUnitAt(time);
    this.onSubtitleChange(unit ? unit.text : '', force);
  }

  /** DOM caption text — only used while no VTT timeline is loaded (single source of truth). */
  private onDomSubtitle(text: string): void {
    if (this.vtt.hasCues()) return;
    if (text.trim()) {
      this.lastDomText = text;
      if (this.tryCaptionFileMatch()) return;
    }
    this.onSubtitleChange(text);
  }

  /**
   * Watches the caption files the page downloads: Resource Timing (also entries loaded before this
   * script started) plus VTT_RESOURCE messages from the background (webRequest).
   */
  private watchCaptionFiles(): void {
    const onUrl = (url: string) => {
      if (!isVttResourceUrl(url)) return;
      this.vtt.addCandidateUrl(url).then(() => this.tryCaptionFileMatch());
    };

    try {
      for (const entry of performance.getEntriesByType('resource')) onUrl(entry.name);
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onUrl(entry.name);
      }).observe({ type: 'resource', buffered: true });
    } catch (err) {
      logWarn('Resource timing unavailable:', err);
    }

    this.onCaptionFileUrl = onUrl;
  }

  private onCaptionFileUrl: (url: string) => void = () => {};

  /** Switches from DOM mode to the VTT timeline once a caption file matches the caption on screen. */
  private tryCaptionFileMatch(): boolean {
    if (this.vtt.hasCues()) return true;
    if (!this.lastDomText || !this.video) return false;
    if (!this.vtt.tryMatchDomText(this.lastDomText, this.video.currentTime, this.video.duration)) return false;

    log('Switched to the VTT timeline (sentence mode + prefetch)');
    this.syncToTime(this.video.currentTime, true);
    this.preFetchUpcoming(true);
    return true;
  }

  /** Re-renders the current subtitle, bypassing the "text unchanged" check (retry, settings change). */
  private refreshCurrent(): void {
    if (this.vtt.hasCues() && this.video) {
      this.syncToTime(this.video.currentTime, true);
    } else {
      this.onSubtitleChange(this.lastSubtitleText, true);
    }
  }

  /**
   * Called when subtitle text changes.
   */
  private onSubtitleChange(text: string, force = false): void {
    if (!force && text === this.lastSubtitleText) return;
    this.lastSubtitleText = text;

    if (!this.settings.enabled || !text.trim()) {
      this.activeTranslationId++;
      this.renderer.hide();
      return;
    }

    // DOM-only mode: optional light punctuation clean-up of the text sent for translation.
    // The displayed original is never modified.
    const textToTranslate =
      !this.vtt.hasCues() && this.settings.restorePunctuation
        ? this.segmenter.restorePunctuation(text) || text
        : text;

    this.requestTranslation(text, textToTranslate);
  }

  /**
   * Shows the cached translation immediately, otherwise waits for in-flight prefetch,
   * then a small high-priority batch around the playback position, then a single request.
   */
  private async requestTranslation(displayText: string, textToTranslate: string): Promise<void> {
    const translationId = ++this.activeTranslationId;
    const { sourceLanguage: source, targetLanguage: target } = this.settings;

    const cached = this.translationClient.getCached(textToTranslate, source, target);
    if (cached) {
      this.renderer.update({ originalText: displayText, translatedText: cached.translatedText, status: 'done' });
      this.previousText = textToTranslate;
      return;
    }

    // Cache miss: update immediately so previous subtitles don't linger on screen
    this.renderer.update({ originalText: displayText, translatedText: '', status: 'translating' });

    try {
      let translatedText = '';

      // 1. A prefetch batch already translating this text
      const pending = this.translationClient.getPending(textToTranslate, source, target);
      if (pending) translatedText = await pending;

      // 2. High-priority batch around the playback position (keeps sentence context)
      if (!translatedText && this.vtt.hasCues() && this.video && translationId === this.activeTranslationId) {
        const batchReq = CueGrouper.createBatchAtTime(this.vtt.getUnits(), this.video.currentTime, source, target, 'high');
        if (batchReq) {
          batchReq.previousTranslations = previousTranslationsFor(batchReq.previousContext, source, target, this.translationClient);
          try {
            await this.translationClient.translateBatch(batchReq);
            translatedText = this.translationClient.getCached(textToTranslate, source, target)?.translatedText || '';
          } catch (batchErr) {
            if (!(batchErr instanceof TranslationRequestError && batchErr.cancelled)) {
              logWarn('Batch translation failed, falling back to single translation:', batchErr);
            }
          }
        }
      }

      // 3. Single request with neighbouring context
      if (!translatedText && translationId === this.activeTranslationId) {
        const upcoming = this.video ? this.vtt.getUpcomingUnit(this.video.currentTime)?.text : undefined;
        const result = await this.translationClient.translate(textToTranslate, source, target, {
          previous: this.previousText,
          upcoming,
        });
        translatedText = result.translatedText;
      }

      if (translationId !== this.activeTranslationId) return;

      this.previousText = textToTranslate;
      this.renderer.update({ originalText: displayText, translatedText, status: 'done' });
      this.preFetchUpcoming();
    } catch (err) {
      if (translationId !== this.activeTranslationId) return;
      if (err instanceof TranslationRequestError && err.cancelled) return;
      this.renderer.update({
        originalText: displayText,
        translatedText: '',
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Translation unavailable',
      });
    }
  }

  /**
   * Pre-translates upcoming units ahead of playback (throttled).
   */
  private preFetchUpcoming(immediate = false): void {
    if (!this.settings.preFetchNext || !this.video || !this.vtt.hasCues()) return;
    const now = Date.now();
    if (!immediate && now - this.lastPrefetchAt < PREFETCH_THROTTLE_MS) return;
    this.lastPrefetchAt = now;

    this.vtt.preFetchUpcoming(
      this.video.currentTime,
      this.settings.sourceLanguage,
      this.settings.targetLanguage,
      this.translationClient
    );
  }

  // ============================================================
  // Settings & messages
  // ============================================================

  /**
   * Handles settings changes from Options page, Popup or keyboard shortcuts.
   */
  private onSettingsChanged(newSettings: ExtensionSettings, oldSettings: ExtensionSettings): void {
    const translationChanged =
      newSettings.translationProvider !== oldSettings.translationProvider ||
      newSettings.sourceLanguage !== oldSettings.sourceLanguage ||
      newSettings.targetLanguage !== oldSettings.targetLanguage ||
      JSON.stringify(getProviderConfig(newSettings)) !==
        JSON.stringify(getProviderConfig(oldSettings, newSettings.translationProvider));
    const timelineChanged = newSettings.smartSentenceMode !== oldSettings.smartSentenceMode;
    const enabledChanged = newSettings.enabled !== oldSettings.enabled;

    this.settings = newSettings;

    // Update all modules
    this.renderer.updateSettings(newSettings);
    this.selectionTranslator.updateSettings(newSettings);
    this.wordTooltip.updateSettings(newSettings);

    // Toggle QA Learning Mode
    if (newSettings.qaLearningMode) {
      this.wordTooltip.enable();
    } else {
      this.wordTooltip.disable();
    }

    if (translationChanged) {
      // Translations of another provider/language must not be shown any more.
      this.translationClient.clearMemCache();
      this.vtt.clearInFlight();
      this.translationClient.cancelPrefetch();
      if (newSettings.sourceLanguage !== oldSettings.sourceLanguage && this.video) {
        this.vtt.reset();
        this.vtt.loadFromVideo(this.video, newSettings.sourceLanguage, true);
      }
    }
    if (timelineChanged) {
      this.vtt.setSentenceMode(newSettings.smartSentenceMode);
    }

    if (!newSettings.enabled) {
      this.activeTranslationId++;
      this.renderer.hide();
    } else if (translationChanged || timelineChanged || enabledChanged) {
      this.refreshCurrent();
      this.preFetchUpcoming(true);
    }

    log('Settings updated');
  }

  /**
   * Handles messages from popup/background.
   */
  private handleMessage(
    message: { action: string; payload?: unknown },
    sendResponse: (response: unknown) => void
  ): void {
    switch (message.action) {
      case 'URL_CHANGED': {
        const url = (message.payload as { url?: string } | undefined)?.url || window.location.href;
        this.handleNavigation(url);
        sendResponse({ success: true });
        break;
      }

      case 'VTT_RESOURCE': {
        const url = (message.payload as { url?: string } | undefined)?.url;
        if (url) this.onCaptionFileUrl(url);
        sendResponse({ success: true });
        break;
      }

      case 'TOGGLE_TRANSLATION': {
        const visible = this.renderer.toggleTranslationVisibility();
        sendResponse({ success: true, data: { visible } });
        break;
      }

      case 'CLEAR_CACHE':
        this.translationClient.clearMemCache();
        sendResponse({ success: true });
        break;

      case 'GET_STATUS':
        sendResponse({
          success: true,
          data: {
            enabled: this.settings.enabled,
            detected: this.detector.isValid(),
            strategy: this.vtt.hasCues() ? 'VTT timeline' : this.detector.getLastResult()?.strategy || 'none',
            lastText: this.lastSubtitleText,
          },
        });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  }

  /**
   * Saves a word to the QA dictionary.
   */
  private async saveWord(
    word: string,
    translation: string,
    qaMeaning: string,
    example: string
  ): Promise<void> {
    try {
      await saveDictionaryWord({
        word,
        translation,
        qaMeaning,
        example,
        sourceUrl: window.location.href,
      });
      log(`Word saved: ${word}`);
    } catch (err) {
      logError('Failed to save word:', err);
    }
  }
}

// ============================================================
// Entry Point
// ============================================================

const app = new UdemyDualSubtitles();
app.init().catch((err) => {
  console.error('[UDS] Fatal initialization error:', err);
});
