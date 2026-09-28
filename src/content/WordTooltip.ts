/**
 * WordTooltip — QA Learning Mode feature.
 *
 * When enabled, clicking a word in the subtitles shows a tooltip with:
 * - Word and translation
 * - QA-specific meaning (if applicable)
 * - Example usage
 * - Save to dictionary button
 */
import type { ExtensionSettings } from '../shared/types';
import { CSS_PREFIX } from '../shared/constants';
import { TranslationClient } from '../translation/TranslationClient';
import { escapeHtml, log } from '../shared/utils';

// Common QA terms with explanations
const QA_TERMS: Record<string, { meaning: string; example: string }> = {
  'bug': { meaning: 'A defect or error in the software', example: 'We found a critical bug in the login flow' },
  'defect': { meaning: 'An imperfection or flaw in the software', example: 'This defect causes data loss' },
  'severity': { meaning: 'How serious the impact of a bug is', example: 'High severity bug — system crash' },
  'priority': { meaning: 'How urgently a bug needs to be fixed', example: 'Priority 1 — fix before release' },
  'regression': { meaning: 'A bug that was previously fixed but reappeared', example: 'Regression testing after the hotfix' },
  'retest': { meaning: 'Testing a bug fix to confirm it works', example: 'Retest the login issue after deployment' },
  'test case': { meaning: 'A set of conditions to verify functionality', example: 'Write a test case for the payment flow' },
  'test suite': { meaning: 'A collection of related test cases', example: 'Run the smoke test suite' },
  'endpoint': { meaning: 'A URL where an API receives requests', example: 'POST /api/users endpoint' },
  'request': { meaning: 'A message sent to a server', example: 'Send a GET request to the API' },
  'response': { meaning: 'A message returned from a server', example: 'The response status code is 200' },
  'payload': { meaning: 'The data sent in a request body', example: 'The JSON payload contains user data' },
  'smoke test': { meaning: 'Quick test to check basic functionality', example: 'Run smoke tests after deployment' },
  'sanity test': { meaning: 'Focused test after a specific change', example: 'Sanity test the new feature' },
  'boundary': { meaning: 'Edge value at the limit of valid input', example: 'Test boundary values: 0, 1, max' },
  'assertion': { meaning: 'A check that verifies expected behavior', example: 'Assert that status code equals 200' },
  'mock': { meaning: 'A simulated object that mimics real behavior', example: 'Mock the database for unit tests' },
  'stub': { meaning: 'A simplified replacement for a component', example: 'Use a stub for the payment gateway' },
  'flaky': { meaning: 'A test that sometimes passes and sometimes fails', example: 'This flaky test fails on CI' },
  'coverage': { meaning: 'Percentage of code exercised by tests', example: '85% code coverage' },
  'sprint': { meaning: 'A fixed time period for development work', example: 'We have 2 weeks per sprint' },
  'blocker': { meaning: 'An issue that prevents further progress', example: 'This is a blocker for release' },
  'workaround': { meaning: 'A temporary solution to avoid a problem', example: 'Use this workaround until the fix is deployed' },
  'acceptance': { meaning: 'Criteria that must be met for approval', example: 'User acceptance testing (UAT)' },
  'precondition': { meaning: 'A condition that must be true before a test', example: 'Precondition: user is logged in' },
  'postcondition': { meaning: 'The expected state after a test', example: 'Postcondition: order is created' },
  'expected result': { meaning: 'What should happen according to requirements', example: 'Expected result: success message shown' },
  'actual result': { meaning: 'What actually happened during testing', example: 'Actual result: error 500' },
  'status code': { meaning: 'HTTP numeric code indicating response type', example: '404 Not Found, 200 OK' },
  'validation': { meaning: 'Checking if input meets specified rules', example: 'Email validation failed' },
  'authentication': { meaning: 'Verifying user identity', example: 'JWT authentication token' },
  'authorization': { meaning: 'Verifying user permissions', example: 'User not authorized to delete' },
};

export class WordTooltip {
  private tooltip: HTMLElement | null = null;
  private translationManager: TranslationClient;
  private settings: ExtensionSettings;
  private saveWordCallback: ((word: string, translation: string, qaMeaning: string, example: string) => void) | null = null;

  constructor(translationManager: TranslationClient, settings: ExtensionSettings) {
    this.translationManager = translationManager;
    this.settings = settings;
  }

  /**
   * Enables word click handling on subtitle elements.
   */
  enable(): void {
    document.addEventListener('click', this.handleClick);
    log('WordTooltip enabled');
  }

  /**
   * Sets callback for saving words to dictionary.
   */
  onSaveWord(callback: (word: string, translation: string, qaMeaning: string, example: string) => void): void {
    this.saveWordCallback = callback;
  }

  private handleClick = async (e: MouseEvent): Promise<void> => {
    if (!this.settings.qaLearningMode) return;

    const target = e.target as HTMLElement;

    // Only handle clicks within our subtitle container
    const subtitleContainer = target.closest(`#${CSS_PREFIX}-container`);
    if (!subtitleContainer) return;

    // Don't trigger on buttons or retry
    if (target.tagName === 'BUTTON' || target.closest('button')) return;

    // Get the clicked word
    const word = this.getWordAtPoint(e.clientX, e.clientY);
    if (!word || word.length < 2) return;

    e.preventDefault();
    e.stopPropagation();

    await this.showTooltip(word, e.clientX, e.clientY);
  };

  /**
   * Gets the word at a specific point in the document.
   */
  private getWordAtPoint(x: number, y: number): string | null {
    // Use caretPositionFromPoint or caretRangeAtPoint
    let range: Range | null = null;

    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    }

    if (!range) return null;

    const textNode = range.startContainer;
    if (textNode.nodeType !== Node.TEXT_NODE) return null;

    const text = textNode.textContent || '';
    const offset = range.startOffset;

    // Find word boundaries
    let start = offset;
    let end = offset;

    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;

    const word = text.substring(start, end).trim();
    return word || null;
  }

  /**
   * Shows the word tooltip with translation and QA context.
   */
  private async showTooltip(word: string, x: number, y: number): Promise<void> {
    this.closeTooltip();

    this.tooltip = document.createElement('div');
    this.tooltip.className = `${CSS_PREFIX}-word-tooltip`;
    this.tooltip.setAttribute('data-uds-injected', 'true');

    this.tooltip.style.cssText = `
      position: fixed;
      left: ${Math.min(x, window.innerWidth - 280)}px;
      top: ${y + 20}px;
      z-index: 2147483647;
      background: #16213e;
      color: #e0e0ff;
      border: 1px solid rgba(100, 130, 255, 0.3);
      border-radius: 10px;
      padding: 14px 18px;
      font-size: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
      max-width: 320px;
      min-width: 220px;
      pointer-events: auto;
    `;

    // Show loading
    this.tooltip.innerHTML = `
      <div style="font-weight: 600; font-size: 16px; color: #fff;">${escapeHtml(word)}</div>
      <div style="color: #888; font-size: 12px; margin-top: 6px;">Loading...</div>
    `;

    document.body.appendChild(this.tooltip);

    // Translate the word
    try {
      const result = await this.translationManager.translate(
        word,
        this.settings.sourceLanguage,
        this.settings.targetLanguage
      );

      // Check for QA term
      const lowerWord = word.toLowerCase();
      const qaInfo = QA_TERMS[lowerWord];

      let html = `
        <div style="font-weight: 600; font-size: 16px; color: #fff;">${escapeHtml(word)}</div>
        <div style="color: #a0a0ff; font-size: 14px; margin-top: 4px; font-style: italic;">${escapeHtml(result.translatedText)}</div>
      `;

      if (qaInfo) {
        html += `
          <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1);">
            <div style="color: #80d0ff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">QA Meaning</div>
            <div style="color: #ccc; font-size: 13px;">${escapeHtml(qaInfo.meaning)}</div>
            <div style="color: #888; font-size: 12px; margin-top: 6px; font-style: italic;">"${escapeHtml(qaInfo.example)}"</div>
          </div>
        `;
      }

      html += `
        <div style="margin-top: 10px; display: flex; gap: 6px;">
          <button data-action="save" style="
            background: rgba(100,130,255,0.2);
            color: #aaf;
            border: 1px solid rgba(100,130,255,0.3);
            border-radius: 5px;
            padding: 4px 12px;
            font-size: 12px;
            cursor: pointer;
          ">📖 Save</button>
          <button data-action="close-tooltip" style="
            background: rgba(255,255,255,0.08);
            color: #888;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 5px;
            padding: 4px 12px;
            font-size: 12px;
            cursor: pointer;
          ">Close</button>
        </div>
      `;

      if (this.tooltip) {
        this.tooltip.innerHTML = html;

        this.tooltip.querySelector('[data-action="save"]')?.addEventListener('click', () => {
          this.saveWordCallback?.(
            word,
            result.translatedText,
            qaInfo?.meaning || '',
            qaInfo?.example || ''
          );
          const btn = this.tooltip?.querySelector('[data-action="save"]') as HTMLButtonElement;
          if (btn) {
            btn.textContent = '✓ Saved';
            btn.disabled = true;
          }
        });

        this.tooltip.querySelector('[data-action="close-tooltip"]')?.addEventListener('click', () => {
          this.closeTooltip();
        });
      }
    } catch {
      if (this.tooltip) {
        this.tooltip.innerHTML = `
          <div style="font-weight: 600; color: #fff;">${escapeHtml(word)}</div>
          <div style="color: #f88; font-size: 12px; margin-top: 6px;">Translation failed</div>
        `;
      }
    }
  }

  /**
   * Closes the tooltip.
   */
  closeTooltip(): void {
    this.tooltip?.remove();
    this.tooltip = null;
  }

  /**
   * Updates settings reference.
   */
  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
  }

  /**
   * Disables and cleans up.
   */
  disable(): void {
    document.removeEventListener('click', this.handleClick);
    this.closeTooltip();
  }
}
