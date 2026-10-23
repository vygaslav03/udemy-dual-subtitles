/**
 * SelectionTranslator — translates text selected by the user on the page.
 *
 * When the user selects text on Udemy, shows a small "Translate" button.
 * Clicking it shows the translation in a small popup near the selection.
 */
import type { ExtensionSettings } from '../shared/types';
import { CSS_PREFIX } from '../shared/constants';
import { TranslationClient } from '../translation/TranslationClient';
import { escapeHtml, log } from '../shared/utils';

export class SelectionTranslator {
  private button: HTMLElement | null = null;
  private popup: HTMLElement | null = null;
  private translationManager: TranslationClient;
  private settings: ExtensionSettings;
  private saveWordCallback: ((word: string, translation: string) => void) | null = null;

  constructor(translationManager: TranslationClient, settings: ExtensionSettings) {
    this.translationManager = translationManager;
    this.settings = settings;
  }

  /**
   * Initializes selection event listeners.
   */
  init(): void {
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousedown', this.handleMouseDown);
    log('SelectionTranslator initialized');
  }

  /**
   * Sets the callback for saving a word to the dictionary.
   */
  onSaveWord(callback: (word: string, translation: string) => void): void {
    this.saveWordCallback = callback;
  }

  private handleMouseDown = (e: MouseEvent): void => {
    // If clicking outside our button/popup, close them
    const target = e.target as Node;
    const insideOurUi = this.button?.contains(target) || this.popup?.contains(target);
    if ((this.button || this.popup) && !insideOurUi) {
      this.cleanup();
    }
  };

  private handleMouseUp = (): void => {
    // Small delay to let selection finalize
    setTimeout(() => this.checkSelection(), 50);
  };

  private checkSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    if (!text || text.length < 2 || text.length > 500) return;

    // Get selection position
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    this.showTranslateButton(rect, text);
  }

  private showTranslateButton(rect: DOMRect, text: string): void {
    this.cleanup();

    this.button = document.createElement('div');
    this.button.className = `${CSS_PREFIX}-sel-btn`;
    this.button.setAttribute('data-uds-injected', 'true');
    this.button.textContent = '🌐 Translate';

    // Position below selection
    this.button.style.cssText = `
      position: fixed;
      left: ${rect.left + rect.width / 2}px;
      top: ${rect.bottom + 8}px;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #1a1a2e;
      color: #e0e0ff;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      transition: background 0.2s;
      user-select: none;
    `;

    this.button.addEventListener('mouseenter', () => {
      if (this.button) this.button.style.background = '#2a2a4e';
    });
    this.button.addEventListener('mouseleave', () => {
      if (this.button) this.button.style.background = '#1a1a2e';
    });

    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.translateSelection(text, rect);
    });

    document.body.appendChild(this.button);
  }

  private async translateSelection(text: string, rect: DOMRect): Promise<void> {
    // Remove button, show popup with loading state
    this.button?.remove();
    this.button = null;

    this.popup = document.createElement('div');
    this.popup.className = `${CSS_PREFIX}-sel-popup`;
    this.popup.setAttribute('data-uds-injected', 'true');

    const updatePopup = (content: string) => {
      if (!this.popup) return;
      this.popup.innerHTML = content;
    };

    this.popup.style.cssText = `
      position: fixed;
      left: ${Math.min(rect.left + rect.width / 2, window.innerWidth - 200)}px;
      top: ${rect.bottom + 8}px;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #1a1a2e;
      color: #e0e0ff;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      max-width: 400px;
      min-width: 200px;
      word-wrap: break-word;
    `;

    document.body.appendChild(this.popup);

    updatePopup(`<div style="color: #888; font-size: 12px;">Translating...</div>`);

    try {
      const result = await this.translationManager.translate(
        text,
        this.settings.sourceLanguage,
        this.settings.targetLanguage
      );

      const saveBtn = this.settings.qaLearningMode
        ? `<button style="
            background: rgba(255,255,255,0.1);
            color: #aaf;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 4px;
            padding: 3px 10px;
            font-size: 11px;
            cursor: pointer;
            margin-top: 6px;
          " data-action="save-word">📖 Save word</button>`
        : '';

      updatePopup(`
        <div style="color: #fff; margin-bottom: 4px; font-weight: 500;">${escapeHtml(text)}</div>
        <div style="color: #aaa; font-size: 13px; font-style: italic;">${escapeHtml(result.translatedText)}</div>
        ${saveBtn}
        <button style="
          position: absolute; top: 4px; right: 8px;
          background: none; border: none; color: #666;
          cursor: pointer; font-size: 16px; padding: 2px;
        " data-action="close">×</button>
      `);

      // Event listeners for buttons
      this.popup.querySelector('[data-action="close"]')?.addEventListener('click', () => this.cleanup());
      this.popup.querySelector('[data-action="save-word"]')?.addEventListener('click', () => {
        this.saveWordCallback?.(text, result.translatedText);
        const btn = this.popup?.querySelector('[data-action="save-word"]') as HTMLButtonElement;
        if (btn) {
          btn.textContent = '✓ Saved';
          btn.disabled = true;
        }
      });

    } catch {
      updatePopup(`
        <div style="color: #fff; margin-bottom: 4px;">${escapeHtml(text)}</div>
        <div style="color: #f88; font-size: 12px;">Translation failed</div>
        <button style="
          position: absolute; top: 4px; right: 8px;
          background: none; border: none; color: #666;
          cursor: pointer; font-size: 16px; padding: 2px;
        " data-action="close">×</button>
      `);
      this.popup.querySelector('[data-action="close"]')?.addEventListener('click', () => this.cleanup());
    }
  }

  /**
   * Updates settings reference.
   */
  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
  }

  /**
   * Removes button and popup from DOM.
   */
  cleanup(): void {
    this.button?.remove();
    this.popup?.remove();
    this.button = null;
    this.popup = null;
  }

  /**
   * Destroys the SelectionTranslator.
   */
  destroy(): void {
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('mousedown', this.handleMouseDown);
    this.cleanup();
  }
}
