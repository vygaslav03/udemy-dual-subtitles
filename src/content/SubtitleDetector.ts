/**
 * SubtitleDetector — finds subtitle elements in the Udemy player DOM.
 *
 * Uses a multi-strategy approach with fallbacks:
 * 1. Finds <video> element and its player container.
 * 2. Searches for Udemy cue/display elements within player.
 * 3. Semantic positioned overlay search near <video>.
 * 4. TextTrack API fallback.
 * 5. Watches playerContainer directly if no cue is active yet.
 */
import { CAPTION_CONTAINER_SELECTOR, SUBTITLE_SELECTORS, PLAYER_SELECTORS } from '../shared/constants';
import { log } from '../shared/utils';

export interface DetectionResult {
  /** The element containing subtitle text or container to watch */
  subtitleElement: HTMLElement | null;
  /** The video player container */
  playerContainer: HTMLElement | null;
  /** The <video> element if found */
  videoElement: HTMLVideoElement | null;
  /** Which strategy found the subtitles */
  strategy: string;
}

export class SubtitleDetector {
  private lastDetectionResult: DetectionResult | null = null;

  /**
   * Attempts to detect subtitle elements using all strategies.
   */
  detect(): DetectionResult {
    const videoEl = this.findVideoElement();
    if (!videoEl) {
      log('Video element not in DOM yet, waiting...');
      return {
        subtitleElement: null,
        playerContainer: null,
        videoElement: null,
        strategy: 'waiting for video',
      };
    }

    const playerContainer = this.findPlayerContainer(videoEl);

    // Strategy 1a: Search for active cue elements with visible text
    for (const selector of SUBTITLE_SELECTORS) {
      const element = (playerContainer || document).querySelector<HTMLElement>(selector);
      if (
        element &&
        !element.closest('#uds-container') &&
        !element.id.startsWith('uds-') &&
        this.hasVisibleText(element)
      ) {
        const persistentContainer =
          element.closest<HTMLElement>(CAPTION_CONTAINER_SELECTOR) ||
          element.parentElement ||
          element;

        const result: DetectionResult = {
          subtitleElement: persistentContainer,
          playerContainer,
          videoElement: videoEl,
          strategy: `active cue container: ${selector}`,
        };
        this.lastDetectionResult = result;
        log(`Subtitles detected via ${result.strategy}`);
        return result;
      }
    }

    // Strategy 1b: Search for captions display container (even if currently empty between cues)
    for (const selector of SUBTITLE_SELECTORS) {
      const element = (playerContainer || document).querySelector<HTMLElement>(selector);
      if (
        element &&
        !element.closest('#uds-container') &&
        !element.id.startsWith('uds-')
      ) {
        const persistentContainer =
          element.closest<HTMLElement>(CAPTION_CONTAINER_SELECTOR) ||
          element.parentElement ||
          element;

        const result: DetectionResult = {
          subtitleElement: persistentContainer,
          playerContainer,
          videoElement: videoEl,
          strategy: `container: ${selector}`,
        };
        this.lastDetectionResult = result;
        log(`Subtitle container detected via ${result.strategy}`);
        return result;
      }
    }

    // Strategy 2: Find semantic overlay near video element
    const container = this.findCaptionNearVideo(videoEl);
    if (container) {
      const result: DetectionResult = {
        subtitleElement: container,
        playerContainer,
        videoElement: videoEl,
        strategy: 'semantic: near video element',
      };
      this.lastDetectionResult = result;
      log(`Subtitles detected via ${result.strategy}`);
      return result;
    }

    // Strategy 3: TextTrack API
    if (videoEl.textTracks && videoEl.textTracks.length > 0) {
      const result: DetectionResult = {
        subtitleElement: null, // TextTrack mode
        playerContainer,
        videoElement: videoEl,
        strategy: 'TextTrack API',
      };
      this.lastDetectionResult = result;
      log(`Subtitles detected via ${result.strategy}`);
      return result;
    }

    // Strategy 4: If video exists, watch player container directly for future cues
    if (playerContainer) {
      const result: DetectionResult = {
        subtitleElement: playerContainer,
        playerContainer,
        videoElement: videoEl,
        strategy: 'player-container observer',
      };
      this.lastDetectionResult = result;
      log('Watching player container for upcoming subtitles...');
      return result;
    }

    return {
      subtitleElement: null,
      playerContainer: null,
      videoElement: videoEl,
      strategy: 'none',
    };
  }

  getLastResult(): DetectionResult | null {
    return this.lastDetectionResult;
  }

  isValid(): boolean {
    if (!this.lastDetectionResult) return false;
    const { subtitleElement, videoElement, strategy } = this.lastDetectionResult;

    if (strategy === 'TextTrack API') {
      return !!videoElement && document.contains(videoElement);
    }

    return !!subtitleElement && document.contains(subtitleElement);
  }

  reset(): void {
    this.lastDetectionResult = null;
  }

  private hasVisibleText(el: HTMLElement): boolean {
    const text = el.textContent?.trim();
    return !!text && text.length > 0;
  }

  findPlayerContainer(startElement?: HTMLElement | null): HTMLElement | null {
    for (const selector of PLAYER_SELECTORS) {
      if (selector === 'video') continue;
      const el = document.querySelector<HTMLElement>(selector);
      if (el) return el;
    }

    if (startElement) {
      let current: HTMLElement | null = startElement;
      while (current && current !== document.body) {
        const cls = current.classList?.toString() || '';
        const purpose = current.getAttribute('data-purpose') || '';
        if (
          cls.includes('player') ||
          cls.includes('video') ||
          cls.includes('viewer') ||
          purpose.includes('video') ||
          purpose.includes('player')
        ) {
          return current;
        }
        current = current.parentElement;
      }
    }

    const videoEl = this.findVideoElement();
    if (videoEl?.parentElement) return videoEl.parentElement;

    return null;
  }

  findVideoElement(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>('video');
  }

  private findCaptionNearVideo(video: HTMLVideoElement): HTMLElement | null {
    const parent = video.closest('[class*="player"]') || video.parentElement?.parentElement;
    if (!parent) return null;

    const candidates = parent.querySelectorAll<HTMLElement>('div, span, p');
    for (const candidate of candidates) {
      if (candidate.contains(video) || candidate.closest('#uds-container')) continue;

      const style = window.getComputedStyle(candidate);
      const text = candidate.textContent?.trim();

      if (
        text &&
        text.length > 0 &&
        text.length < 500 &&
        (style.position === 'absolute' || style.position === 'fixed') &&
        parseInt(style.zIndex, 10) > 0
      ) {
        const videoRect = video.getBoundingClientRect();
        const candidateRect = candidate.getBoundingClientRect();

        if (
          candidateRect.top >= videoRect.top - 50 &&
          candidateRect.bottom <= videoRect.bottom + 50 &&
          candidateRect.left >= videoRect.left - 50 &&
          candidateRect.right <= videoRect.right + 50
        ) {
          return candidate;
        }
      }
    }

    return null;
  }
}
