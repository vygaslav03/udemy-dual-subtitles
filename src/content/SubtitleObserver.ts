/**
 * SubtitleObserver — watches for subtitle text changes.
 *
 * Uses MutationObserver to efficiently detect when subtitle text changes.
 * Also supports TextTrack API cuechange events as a fallback.
 * Includes debounce to avoid excessive callbacks.
 */
import { cleanCueText, debounce, log } from '../shared/utils';
import { CAPTION_CONTAINER_SELECTOR, OBSERVER_DEBOUNCE_MS, SUBTITLE_SELECTORS } from '../shared/constants';

const HEALTH_CHECK_INTERVAL_MS = 2000;

/** Cue text of a DOM element without our injected nodes, whitespace collapsed. */
function cleanElementText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-uds-injected]').forEach((node) => node.remove());
  // <br> between cue lines would otherwise glue words together in textContent
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

export type SubtitleChangeCallback = (text: string) => void;

export class SubtitleObserver {
  private mutationObserver: MutationObserver | null = null;
  private lastText = '';
  private callback: SubtitleChangeCallback;
  private debouncedCheck: () => void;
  private observedElement: HTMLElement | null = null;
  private textTrackCleanups: (() => void)[] = [];
  /** React may replace the caption container (and its parent) without a mutation we observe. */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(callback: SubtitleChangeCallback) {
    this.callback = callback;
    this.debouncedCheck = debounce(() => this.checkForChanges(), OBSERVER_DEBOUNCE_MS);
  }

  /**
   * Starts observing a subtitle DOM element (or player container) for text changes.
   */
  observeElement(element: HTMLElement): void {
    this.disconnect();

    // Climb to persistent display container if an inner cue was passed
    const persistent = element.closest<HTMLElement>(CAPTION_CONTAINER_SELECTOR) || element;

    this.observedElement = persistent;
    this.lastText = '';

    this.mutationObserver = new MutationObserver(() => {
      this.debouncedCheck();
    });

    // Observe childList, text changes and subtree
    this.mutationObserver.observe(persistent, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Also observe parent in case the element gets replaced
    if (persistent.parentElement && persistent.parentElement !== document.body) {
      this.mutationObserver.observe(persistent.parentElement, {
        childList: true,
        subtree: true,
      });
    }

    this.healthCheckTimer = setInterval(() => {
      if (this.observedElement && !document.contains(this.observedElement)) this.checkForChanges();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Check immediately
    this.checkForChanges();
    log('SubtitleObserver: watching DOM element for cues');
  }

  /**
   * Starts observing TextTrack cuechange events.
   */
  observeTextTracks(video: HTMLVideoElement): void {
    this.disconnect();

    const tracks = video.textTracks;
    if (!tracks || tracks.length === 0) {
      log('SubtitleObserver: no text tracks found');
      return;
    }

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];

      const handler = () => {
        const cue = track.activeCues?.[0];
        if (cue && 'text' in cue) {
          const text = cleanCueText((cue as VTTCue).text);
          if (text !== this.lastText) {
            this.lastText = text;
            this.callback(text);
          }
        }
      };

      track.addEventListener('cuechange', handler);
      this.textTrackCleanups.push(() => {
        track.removeEventListener('cuechange', handler);
      });
    }

    log('SubtitleObserver: watching TextTrack API');
  }

  /**
   * Checks if the observed element's text has changed.
   */
  private checkForChanges(): void {
    if (!this.observedElement) return;

    // Auto-recovery: if the observed element was detached by React or player update, re-bind to live container
    if (!document.contains(this.observedElement)) {
      const live = document.querySelector<HTMLElement>(
        `${CAPTION_CONTAINER_SELECTOR}, [data-purpose="captions-cue-text"]`
      );
      if (live && !live.closest('#uds-container')) {
        const container = live.closest<HTMLElement>(CAPTION_CONTAINER_SELECTOR) || live;
        log('SubtitleObserver: container was detached, re-bound to live DOM container');
        this.observeElement(container);
        return;
      }
    }

    const currentText = this.getSubtitleText(this.observedElement);

    if (currentText !== this.lastText) {
      this.lastText = currentText;
      this.callback(currentText);
    }
  }

  /**
   * Extracts clean subtitle text from the observed element or its children.
   */
  private getSubtitleText(container: HTMLElement): string {
    // 1. Search for specific cue elements inside container
    for (const selector of SUBTITLE_SELECTORS) {
      const cueEl = container.querySelector<HTMLElement>(selector);
      if (cueEl && !cueEl.closest('#uds-container') && !cueEl.id.startsWith('uds-')) {
        const text = cleanElementText(cueEl);
        if (text) return text;
      }
    }

    // 2. Also search live DOM in case cue is outside this specific container
    const globalCue = document.querySelector<HTMLElement>(
      '[data-purpose="captions-cue-text"], .vjs-text-track-cue'
    );
    if (globalCue && !globalCue.closest('#uds-container') && !globalCue.id.startsWith('uds-')) {
      const text = cleanElementText(globalCue);
      if (text) return text;
    }

    // 3. If the container itself is a cue element with text.
    // If container is playerContainer, do not return all player text
    if (
      container.classList.toString().includes('player') ||
      container.getAttribute('data-purpose')?.includes('player')
    ) {
      return '';
    }

    return cleanElementText(container);
  }

  disconnect(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    for (const cleanup of this.textTrackCleanups) {
      cleanup();
    }
    this.textTrackCleanups = [];
    this.observedElement = null;
    this.lastText = '';
  }
}
