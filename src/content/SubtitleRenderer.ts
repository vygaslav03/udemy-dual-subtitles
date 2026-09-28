/**
 * SubtitleRenderer — creates and manages the dual subtitle display.
 *
 * Renders:
 * - Original English text (top line)
 * - Translation (bottom line, with "Translating..." state)
 *
 * Handles styling, positioning, error states, and fullscreen.
 */
import type { ExtensionSettings, SubtitleState } from '../shared/types';
import { CSS_PREFIX, LOADING_INDICATOR_DELAY_MS } from '../shared/constants';
import { escapeHtml } from '../shared/utils';
import { SubtitleFormatter } from './SubtitleFormatter';

export class SubtitleRenderer {
  private container: HTMLElement | null = null;
  private originalLine: HTMLElement | null = null;
  private translationLine: HTMLElement | null = null;
  private retryButton: HTMLElement | null = null;
  private playerContainer: HTMLElement | null = null;
  private settings: ExtensionSettings;
  private currentState: SubtitleState = { originalText: '', translatedText: '', status: 'idle' };
  private retryCallback: (() => void) | null = null;
  private loadingTimer: ReturnType<typeof setTimeout> | null = null;
  private translationVisible = true;

  constructor(settings: ExtensionSettings) {
    this.settings = settings;
  }

  /**
   * Creates the dual subtitle container and attaches it to the player.
   */
  mount(playerContainer: HTMLElement): void {
    this.playerContainer = playerContainer;
    this.cleanup(); // Remove any existing instance

    // Create container
    this.container = document.createElement('div');
    this.container.id = `${CSS_PREFIX}-container`;
    this.container.setAttribute('data-uds-injected', 'true');

    // Original subtitle line
    this.originalLine = document.createElement('div');
    this.originalLine.id = `${CSS_PREFIX}-original`;
    this.originalLine.className = `${CSS_PREFIX}-line ${CSS_PREFIX}-original`;
    this.originalLine.setAttribute('data-uds-injected', 'true');

    // Translation line
    this.translationLine = document.createElement('div');
    this.translationLine.id = `${CSS_PREFIX}-translation`;
    this.translationLine.className = `${CSS_PREFIX}-line ${CSS_PREFIX}-translation`;
    this.translationLine.setAttribute('data-uds-injected', 'true');

    // Retry button (hidden by default)
    this.retryButton = document.createElement('button');
    this.retryButton.id = `${CSS_PREFIX}-retry`;
    this.retryButton.className = `${CSS_PREFIX}-retry`;
    this.retryButton.setAttribute('data-uds-injected', 'true');
    this.retryButton.textContent = '↻ Retry';
    this.retryButton.style.display = 'none';
    this.retryButton.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.retryCallback?.();
    });

    this.container.appendChild(this.originalLine);
    this.container.appendChild(this.translationLine);
    this.container.appendChild(this.retryButton);

    // Apply settings
    this.applyStyles();
    this.translationLine.style.visibility = this.translationVisible ? 'visible' : 'hidden';

    // Inject into player (or body as fallback)
    const target = playerContainer || document.body;

    // Make sure the target can hold absolute children
    const targetStyle = window.getComputedStyle(target);
    if (targetStyle.position === 'static') {
      target.style.position = 'relative';
    }

    target.appendChild(this.container);

    if (this.settings.enabled) {
      this.setHideNative(true);
    }
  }

  /**
   * Toggles visibility of Udemy's native subtitles.
   */
  setHideNative(hide: boolean): void {
    if (hide) {
      document.body.classList.add(`${CSS_PREFIX}-hide-native`);
      this.playerContainer?.classList.add(`${CSS_PREFIX}-hide-native`);
    } else {
      document.body.classList.remove(`${CSS_PREFIX}-hide-native`);
      this.playerContainer?.classList.remove(`${CSS_PREFIX}-hide-native`);
    }
  }

  /**
   * Updates the display with new subtitle state.
   */
  update(state: SubtitleState): void {
    this.currentState = state;
    this.clearLoadingTimer();

    if (!this.container || !this.originalLine || !this.translationLine || !this.retryButton) {
      return;
    }

    // Always show original text
    if (state.originalText) {
      this.originalLine.innerHTML = this.wrapSubtitleLines(SubtitleFormatter.formatHtml(state.originalText));
      this.originalLine.style.display = 'block';
      this.container.style.display = 'flex';
      if (this.settings.enabled) {
        this.setHideNative(true);
      }
    } else {
      this.originalLine.innerHTML = '';
      this.originalLine.style.display = 'none';
      this.container.style.display = 'none';
      return;
    }

    // Show translation based on status
    switch (state.status) {
      case 'translating':
        // Keep the line empty for fast translations; show "…" only if it takes a while.
        this.translationLine.innerHTML = '';
        this.translationLine.style.display = 'none';
        this.retryButton.style.display = 'none';
        this.loadingTimer = setTimeout(() => {
          this.loadingTimer = null;
          if (this.currentState !== state || !this.translationLine) return;
          this.translationLine.innerHTML = `<span class="${CSS_PREFIX}-text ${CSS_PREFIX}-loading" style="background: ${this.getBgColor()};">…</span>`;
          this.translationLine.style.display = 'block';
        }, LOADING_INDICATOR_DELAY_MS);
        break;

      case 'done':
        if (state.translatedText) {
          this.translationLine.innerHTML = this.wrapSubtitleLines(SubtitleFormatter.formatHtml(state.translatedText));
          this.translationLine.style.display = 'block';
        } else {
          this.translationLine.innerHTML = '';
          this.translationLine.style.display = 'none';
        }
        this.retryButton.style.display = 'none';
        break;

      case 'error':
        this.translationLine.innerHTML = `<span class="${CSS_PREFIX}-text ${CSS_PREFIX}-error" style="background: ${this.getBgColor()};">${escapeHtml(state.errorMessage || 'Translation unavailable')}</span>`;
        this.translationLine.style.display = 'block';
        this.retryButton.style.display = 'inline-block';
        break;

      case 'idle':
      default:
        this.translationLine.innerHTML = '';
        this.translationLine.style.display = 'none';
        this.retryButton.style.display = 'none';
        break;
    }
  }

  /**
   * Wraps each line of formatted subtitle HTML into a styled text badge,
   * so the background is only behind the subtitle text itself and not across the full screen.
   */
  private wrapSubtitleLines(html: string): string {
    if (!html) return '';
    const bgColor = this.getBgColor();
    const lines = html.split(/<br\s*\/?>/i);
    return lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `<span class="${CSS_PREFIX}-text" style="background: ${bgColor};">${line}</span>`)
      .join('<br>');
  }

  /**
   * Computes RGBA background color from current opacity setting.
   */
  private getBgColor(): string {
    const bgOpacity = this.settings.backgroundOpacity / 100;
    return `rgba(0, 0, 0, ${bgOpacity})`;
  }

  private clearLoadingTimer(): void {
    if (this.loadingTimer) {
      clearTimeout(this.loadingTimer);
      this.loadingTimer = null;
    }
  }

  /**
   * Toggles only the translation line visibility (Alt+T).
   */
  toggleTranslationVisibility(): boolean {
    this.translationVisible = !this.translationVisible;
    if (this.translationLine) {
      this.translationLine.style.visibility = this.translationVisible ? 'visible' : 'hidden';
    }
    return this.translationVisible;
  }

  /**
   * Hides the subtitle container.
   */
  hide(): void {
    this.clearLoadingTimer();
    if (this.container) {
      this.container.style.display = 'none';
    }
    // Only un-hide native subtitles if the extension is disabled
    if (!this.settings.enabled) {
      this.setHideNative(false);
    }
  }

  /**
   * Sets the callback for retry button clicks.
   */
  onRetry(callback: () => void): void {
    this.retryCallback = callback;
  }

  /**
   * Updates settings and re-applies styles.
   */
  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.applyStyles();
    this.setHideNative(settings.enabled);
    if (this.currentState.originalText) {
      this.update(this.currentState);
    }
  }

  /**
   * Applies visual styles from settings.
   */
  private applyStyles(): void {
    if (!this.container || !this.originalLine || !this.translationLine) return;

    const s = this.settings;
    const bgColor = this.getBgColor();

    // Container positioning - flexbox column, shrink-to-fit width, centered horizontally
    this.container.style.cssText = `
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      text-align: center;
      max-width: ${s.subtitleMaxWidth}%;
      width: max-content;
      pointer-events: none;
      display: none;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      padding: 0 8px;
    `;

    // Position
    switch (s.subtitlePosition) {
      case 'bottom':
        this.container.style.bottom = '60px';
        this.container.style.top = 'auto';
        this.container.style.transform = 'translateX(-50%)';
        break;
      case 'middle':
        this.container.style.top = '50%';
        this.container.style.bottom = 'auto';
        this.container.style.transform = 'translate(-50%, -50%)';
        break;
      case 'custom':
        this.container.style.bottom = `${s.customVerticalOffset}px`;
        this.container.style.top = 'auto';
        this.container.style.transform = 'translateX(-50%)';
        break;
    }

    // Original line container (transparent, bounds to text)
    this.originalLine.style.cssText = `
      display: block;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      margin: 0 auto 3px auto;
      font-size: ${s.originalFontSize}px;
      color: ${s.originalColor};
      background: transparent;
      padding: 0;
      line-height: 1.4;
      text-align: center;
      word-wrap: break-word;
      overflow-wrap: break-word;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // Translation line container (transparent, bounds to text)
    this.translationLine.style.cssText = `
      display: block;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      margin: 0 auto;
      font-size: ${s.translationFontSize}px;
      color: ${s.translationColor};
      background: transparent;
      padding: 0;
      line-height: 1.4;
      text-align: center;
      word-wrap: break-word;
      overflow-wrap: break-word;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-style: italic;
    `;

    // Update existing text badges if present
    const existingSpans = this.container.querySelectorAll<HTMLElement>(`.${CSS_PREFIX}-text`);
    existingSpans.forEach((span) => {
      span.style.background = bgColor;
    });

    // Retry button
    if (this.retryButton) {
      this.retryButton.style.cssText = `
        pointer-events: auto;
        cursor: pointer;
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 4px;
        padding: 2px 10px;
        font-size: 12px;
        margin-top: 4px;
        transition: background 0.2s;
      `;
    }
  }

  /**
   * Removes all injected elements from the DOM.
   */
  cleanup(): void {
    this.clearLoadingTimer();
    this.setHideNative(false);
    // Remove by ID (safest)
    const existing = document.getElementById(`${CSS_PREFIX}-container`);
    if (existing) {
      existing.remove();
    }

    this.container = null;
    this.originalLine = null;
    this.translationLine = null;
    this.retryButton = null;
  }
}
