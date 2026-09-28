/**
 * Options Page Script — Udemy Dual Subtitles.
 */
import { getProviderConfig, loadSettings, saveProviderConfig, saveSettings } from '../shared/storage';
import type { ExtensionSettings, ProviderSettings } from '../shared/types';
import { GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from '../shared/constants';

/** Inputs stored per provider (each provider keeps its own key/endpoint/model). */
const PROVIDER_FIELDS: Array<{ id: string; key: keyof ProviderSettings }> = [
  { id: 'apiKey', key: 'apiKey' },
  { id: 'apiEndpoint', key: 'apiEndpoint' },
  { id: 'apiModel', key: 'apiModel' },
];

class OptionsController {
  private settings!: ExtensionSettings;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    this.settings = await loadSettings();
    this.render();
    this.bindEvents();
  }

  private render(): void {
    // Languages
    this.setSelectValue('sourceLanguage', this.settings.sourceLanguage);
    this.setSelectValue('targetLanguage', this.settings.targetLanguage);

    // Provider
    this.setSelectValue('translationProvider', this.settings.translationProvider);
    this.renderProviderConfig();
    this.updateProviderFields();

    // Appearance
    this.setRangeValue('originalFontSize', this.settings.originalFontSize);
    this.setRangeValue('translationFontSize', this.settings.translationFontSize);
    this.setColorValue('originalColor', this.settings.originalColor);
    this.setColorValue('translationColor', this.settings.translationColor);
    this.setRangeValue('backgroundOpacity', this.settings.backgroundOpacity);

    // Position
    this.setSelectValue('subtitlePosition', this.settings.subtitlePosition);
    this.setRangeValue('customVerticalOffset', this.settings.customVerticalOffset);
    this.setRangeValue('subtitleMaxWidth', this.settings.subtitleMaxWidth);
    this.updatePositionFields();

    // Behavior
    this.setSelectValue('maxConcurrentTranslations', String(this.settings.maxConcurrentTranslations));
    this.setCheckboxValue('preFetchNext', this.settings.preFetchNext);
    this.setCheckboxValue('smartSentenceMode', this.settings.smartSentenceMode);
    this.setCheckboxValue('restorePunctuation', this.settings.restorePunctuation);

    // Cache
    this.setInputValue('cacheTTLDays', String(this.settings.cacheTTLDays));
    this.setInputValue('maxCacheEntries', String(this.settings.maxCacheEntries));

    // QA Mode
    this.setCheckboxValue('qaLearningMode', this.settings.qaLearningMode);
  }

  private bindEvents(): void {
    // Select and input fields
    const fields: Array<{ id: string; key: keyof ExtensionSettings; type: 'select' | 'text' | 'number' | 'checkbox' | 'range' | 'color' }> = [
      { id: 'sourceLanguage', key: 'sourceLanguage', type: 'select' },
      { id: 'targetLanguage', key: 'targetLanguage', type: 'select' },
      { id: 'translationProvider', key: 'translationProvider', type: 'select' },
      { id: 'originalFontSize', key: 'originalFontSize', type: 'range' },
      { id: 'translationFontSize', key: 'translationFontSize', type: 'range' },
      { id: 'originalColor', key: 'originalColor', type: 'color' },
      { id: 'translationColor', key: 'translationColor', type: 'color' },
      { id: 'backgroundOpacity', key: 'backgroundOpacity', type: 'range' },
      { id: 'subtitlePosition', key: 'subtitlePosition', type: 'select' },
      { id: 'customVerticalOffset', key: 'customVerticalOffset', type: 'range' },
      { id: 'subtitleMaxWidth', key: 'subtitleMaxWidth', type: 'range' },
      { id: 'maxConcurrentTranslations', key: 'maxConcurrentTranslations', type: 'select' },
      { id: 'preFetchNext', key: 'preFetchNext', type: 'checkbox' },
      { id: 'smartSentenceMode', key: 'smartSentenceMode', type: 'checkbox' },
      { id: 'restorePunctuation', key: 'restorePunctuation', type: 'checkbox' },
      { id: 'cacheTTLDays', key: 'cacheTTLDays', type: 'number' },
      { id: 'maxCacheEntries', key: 'maxCacheEntries', type: 'number' },
      { id: 'qaLearningMode', key: 'qaLearningMode', type: 'checkbox' },
    ];

    for (const field of fields) {
      const el = document.getElementById(field.id);
      if (!el) continue;

      const eventType = field.type === 'range' || field.type === 'color' ? 'input' : 'change';

      el.addEventListener(eventType, () => {
        let value: string | number | boolean;

        if (field.type === 'checkbox') {
          value = (el as HTMLInputElement).checked;
        } else if (field.type === 'range' || field.type === 'number') {
          value = parseInt((el as HTMLInputElement).value, 10);
        } else {
          value = (el as HTMLInputElement).value;
        }

        // Update display values for ranges
        const displayEl = document.getElementById(`${field.id}Val`);
        if (displayEl) {
          displayEl.textContent = String(value);
        }

        // Color display
        if (field.type === 'color') {
          const colorDisplay = document.getElementById(`${field.id}Val`);
          if (colorDisplay) colorDisplay.textContent = value as string;
        }

        this.saveSetting(field.key, value);
      });
    }

    // Provider-specific credentials
    for (const field of PROVIDER_FIELDS) {
      document.getElementById(field.id)?.addEventListener('change', async (e) => {
        const value = (e.target as HTMLInputElement).value.trim();
        this.settings = await saveProviderConfig(this.settings.translationProvider, { [field.key]: value });
        this.showSaveStatus();
      });
    }

    // Provider change — show/hide API fields and load that provider's credentials
    document.getElementById('translationProvider')?.addEventListener('change', () => {
      this.updateProviderFields();
    });

    // Position change — show/hide custom offset
    document.getElementById('subtitlePosition')?.addEventListener('change', () => {
      this.updatePositionFields();
    });

    // Clear cache
    document.getElementById('clearCache')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'CLEAR_CACHE' });
      const statsEl = document.getElementById('cacheStats');
      if (statsEl) statsEl.textContent = 'Cache cleared';
      this.showSaveStatus('Cache cleared');
    });

    // Open dictionary
    document.getElementById('openDictionary')?.addEventListener('click', () => {
      const url = chrome.runtime.getURL('src/dictionary/dictionary.html');
      chrome.tabs.create({ url });
    });
  }

  private async saveSetting(key: keyof ExtensionSettings, value: unknown): Promise<void> {
    const update = { [key]: value } as Partial<ExtensionSettings>;
    this.settings = await saveSettings(update);
    if (key === 'translationProvider') this.renderProviderConfig();
    this.showSaveStatus();
  }

  private renderProviderConfig(): void {
    const config = getProviderConfig(this.settings);
    for (const field of PROVIDER_FIELDS) this.setInputValue(field.id, config[field.key]);
  }

  private showSaveStatus(message?: string): void {
    const el = document.getElementById('saveStatus');
    if (!el) return;

    el.textContent = message || '✓ Settings saved';
    el.classList.add('visible');

    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      el.classList.remove('visible');
    }, 2000);
  }

  private updateProviderFields(): void {
    const provider = (document.getElementById('translationProvider') as HTMLSelectElement)?.value;
    const needsKey = !['google-free', 'chrome-builtin'].includes(provider);

    const apiKeyGroup = document.getElementById('apiKeyGroup');
    const apiEndpointGroup = document.getElementById('apiEndpointGroup');
    const apiModelGroup = document.getElementById('apiModelGroup');
    const apiKeyHint = document.getElementById('apiKeyHint');
    const modelInput = document.getElementById('apiModel') as HTMLInputElement | null;

    if (apiKeyGroup) apiKeyGroup.style.display = needsKey ? '' : 'none';
    if (apiEndpointGroup) apiEndpointGroup.style.display = needsKey ? '' : 'none';
    if (apiModelGroup) apiModelGroup.style.display = ['openai', 'gemini'].includes(provider) ? '' : 'none';

    if (modelInput) {
      if (provider === 'gemini') modelInput.placeholder = `e.g., ${GEMINI_DEFAULT_MODEL} (default)`;
      else if (provider === 'openai') modelInput.placeholder = `e.g., ${OPENAI_DEFAULT_MODEL} (default)`;
    }

    if (apiKeyHint) {
      if (provider === 'gemini') {
        apiKeyHint.innerHTML = 'Get your free key at <a href="https://aistudio.google.com/apikey" target="_blank" style="color: #60a5fa; text-decoration: underline;">aistudio.google.com/apikey</a>. Endpoint and model can be left empty.';
      } else if (provider === 'openai') {
        apiKeyHint.innerHTML = 'Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" style="color: #60a5fa; text-decoration: underline;">platform.openai.com/api-keys</a>. Endpoint and model can be left empty.';
      } else if (provider === 'deepl') {
        apiKeyHint.innerHTML = 'Get a key at <a href="https://www.deepl.com/pro-api" target="_blank" style="color: #60a5fa; text-decoration: underline;">deepl.com/pro-api</a> (500k chars/mo free).';
      } else if (provider === 'google-cloud') {
        apiKeyHint.innerHTML = 'Get a Cloud API key at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color: #60a5fa; text-decoration: underline;">console.cloud.google.com</a>.';
      } else {
        apiKeyHint.textContent = 'Stored locally, never sent anywhere except your chosen provider.';
      }
    }
  }

  private updatePositionFields(): void {
    const position = (document.getElementById('subtitlePosition') as HTMLSelectElement)?.value;
    const customGroup = document.getElementById('customOffsetGroup');
    if (customGroup) {
      customGroup.style.display = position === 'custom' ? '' : 'none';
    }
  }

  // Helper methods
  private setSelectValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el) el.value = value;
  }

  private setInputValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
  }

  private setRangeValue(id: string, value: number): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(value);
    const displayEl = document.getElementById(`${id}Val`);
    if (displayEl) displayEl.textContent = String(value);
  }

  private setColorValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
    const displayEl = document.getElementById(`${id}Val`);
    if (displayEl) displayEl.textContent = value;
  }

  private setCheckboxValue(id: string, value: boolean): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = value;
  }
}

const options = new OptionsController();
options.init().catch(console.error);
