/**
 * Content Script Entry Point — Udemy Dual Subtitles.
 *
 * This is the main orchestrator that initializes all content script modules.
 * It runs only on udemy.com pages.
 *
 * Flow:
 * 1. Get credential-free settings from the background (this script never touches chrome.storage,
 *    so API keys never reach the Udemy page process); later changes are pushed as SETTINGS_CHANGED
 * 2. Start SubtitleDetector (with retries & container awareness)
 * 3. Per detected player, start a session: all listeners/loops are bound to one AbortController
 * 4. Timeline source: VTT cues (merged into sentence units) driven by the video clock;
 *    the DOM caption observer is used only while no VTT timeline is available
 * 5. Mount SubtitleRenderer (handles dual display + native subtitle hiding)
 * 6. URL_CHANGED from the background → re-initialize on lesson change
 * 7. LiveTranslator translates the current subtitle; SelectionTranslator + WordTooltip on demand
 */
import { SubtitleDetector, type DetectionResult } from './SubtitleDetector';
import { SubtitleObserver } from './SubtitleObserver';
import { SubtitleRenderer } from './SubtitleRenderer';
import { SelectionTranslator } from './SelectionTranslator';
import { WordTooltip } from './WordTooltip';
import { SentenceSegmenter } from './SentenceSegmenter';
import { VTTPreFetcher } from './VTTPreFetcher';
import { CueGrouper } from './CueGrouper';
import { LiveTranslator } from './LiveTranslator';
import { TranslationClient } from '../translation/TranslationClient';
import { sendToBackground, type Message, type TabAction, type TabRequests } from '../shared/messages';
import type { MessageResponse, PublicSettings } from '../shared/types';
import { debounce, isUdemyCoursePage, lessonKey, log, logError, logWarn } from '../shared/utils';
import { REINIT_DELAY_MS, SUBTITLE_DEBOUNCE_MS } from '../shared/constants';
import { isVttResourceUrl } from '../subtitles/vttMatching';

const DETECTION_MAX_RETRIES = 30;
const PREFETCH_THROTTLE_MS = 3000;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

class UdemyDualSubtitles {
  private settings!: PublicSettings;
  private detector = new SubtitleDetector();
  private observer!: SubtitleObserver;
  private renderer!: SubtitleRenderer;
  private selectionTranslator!: SelectionTranslator;
  private wordTooltip!: WordTooltip;
  private translationClient = new TranslationClient();
  private live!: LiveTranslator;
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
  private lastPrefetchAt = 0;

  async init(): Promise<void> {
    log('Initializing Udemy Dual Subtitles...');

    try {
      // 1. Load settings (credential-free view)
      this.settings = await sendToBackground('GET_SETTINGS');
      this.vtt.setSentenceMode(this.settings.smartSentenceMode);
      log(`Settings loaded. Enabled: ${this.settings.enabled}, Provider: ${this.settings.translationProvider}`);

      // 2. Initialize SubtitleRenderer and the live translation pipeline
      this.renderer = new SubtitleRenderer(this.settings);
      this.renderer.onRetry(() => this.refreshCurrent());
      this.live = new LiveTranslator({
        client: this.translationClient,
        render: (state) => this.renderer.update(state),
        batchAround: (source, target) =>
          this.vtt.hasCues() && this.video
            ? CueGrouper.createBatchAtTime(this.vtt.getUnits(), this.video.currentTime, source, target, 'high')
            : null,
        upcomingText: () => (this.video ? this.vtt.getUpcomingUnit(this.video.currentTime)?.text : undefined),
        onRendered: () => this.preFetchUpcoming(),
      });

      // 3. DOM caption observer (fallback source when no VTT timeline is available)
      this.observer = new SubtitleObserver(
        debounce((text: string) => this.onDomSubtitle(text), SUBTITLE_DEBOUNCE_MS)
      );

      // 4. Initialize SelectionTranslator
      this.selectionTranslator = new SelectionTranslator(this.translationClient, this.settings);
      this.selectionTranslator.onSaveWord((word, translation) => {
        this.saveWord(word, translation, '', '');
      });
      this.selectionTranslator.init();

      // 5. Initialize WordTooltip (QA Learning Mode)
      this.wordTooltip = new WordTooltip(this.translationClient, this.settings);
      this.wordTooltip.onSaveWord((word, translation, qaMeaning, example) => {
        this.saveWord(word, translation, qaMeaning, example);
      });
      if (this.settings.qaLearningMode) {
        this.wordTooltip.enable();
      }

      // 6. Messages from the background and the popup (settings pushes, navigation, status)
      chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
        if (sender.id !== chrome.runtime.id || typeof message?.action !== 'string') return false;
        this.handleMessage(message as Message<TabAction>, sendResponse);
        return false; // responses are sent synchronously
      });

      // 7. Caption files downloaded by the player (Udemy renders captions itself, without <track>)
      this.watchCaptionFiles();

      // 8. Start subtitle detection
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
        this.live.resetContext();
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

    // Also drives the timeline while paused/seeking and where requestVideoFrameCallback is missing.
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
    this.live.invalidate();
    this.live.resetContext();
    this.lastSubtitleText = '';
    this.lastDomText = '';

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
      this.live.invalidate();
      this.renderer.hide();
      return;
    }

    // DOM-only mode: optional light punctuation clean-up of the text sent for translation.
    // The displayed original is never modified.
    const textToTranslate =
      !this.vtt.hasCues() && this.settings.restorePunctuation
        ? this.segmenter.restorePunctuation(text) || text
        : text;

    this.live.show(text, textToTranslate, this.settings.sourceLanguage, this.settings.targetLanguage);
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
   * Applies settings pushed by the background (changed in the options page, popup or by a shortcut).
   * `translationChanged` covers what this script cannot see itself: model, endpoint and key changes.
   */
  private onSettingsChanged(newSettings: PublicSettings, oldSettings: PublicSettings, translationChanged: boolean): void {
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
      this.live.invalidate();
      this.renderer.hide();
    } else if (translationChanged || timelineChanged || enabledChanged) {
      this.refreshCurrent();
      this.preFetchUpcoming(true);
    }

    log('Settings updated');
  }

  /**
   * Handles messages from the background and the popup.
   */
  private handleMessage(message: Message<TabAction>, sendResponse: (response: MessageResponse) => void): void {
    const ok = <A extends TabAction>(data?: TabRequests[A]['result']) => sendResponse({ success: true, data });

    switch (message.action) {
      case 'URL_CHANGED': {
        const { url } = (message.payload || {}) as Partial<TabRequests['URL_CHANGED']['payload']>;
        this.handleNavigation(url || window.location.href);
        ok();
        break;
      }

      case 'VTT_RESOURCE': {
        const { url } = (message.payload || {}) as Partial<TabRequests['VTT_RESOURCE']['payload']>;
        if (url) this.onCaptionFileUrl(url);
        ok();
        break;
      }

      case 'TOGGLE_TRANSLATION':
        ok<'TOGGLE_TRANSLATION'>({ visible: this.renderer.toggleTranslationVisibility() });
        break;

      case 'SETTINGS_CHANGED': {
        const { settings, previous, translationChanged } = message.payload as TabRequests['SETTINGS_CHANGED']['payload'];
        this.onSettingsChanged(settings, previous, translationChanged);
        ok();
        break;
      }

      case 'CACHE_CLEARED':
        this.translationClient.clearMemCache();
        this.vtt.clearInFlight();
        ok();
        break;

      case 'GET_STATUS':
        ok<'GET_STATUS'>({
          enabled: this.settings.enabled,
          detected: this.detector.isValid(),
          strategy: this.vtt.hasCues() ? 'VTT timeline' : this.detector.getLastResult()?.strategy || 'none',
          lastText: this.lastSubtitleText,
        });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  }

  /**
   * Saves a word to the QA dictionary (written by the background).
   */
  private async saveWord(word: string, translation: string, qaMeaning: string, example: string): Promise<void> {
    try {
      await sendToBackground('SAVE_WORD', { word, translation, qaMeaning, example, sourceUrl: window.location.href });
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
