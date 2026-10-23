/**
 * Options Page Script — Udemy Dual Subtitles.
 *
 * Reads settings from storage (trusted extension page); writes go through the background,
 * which validates them and returns the stored values, so the form always shows what is saved.
 */
import { readSettings } from '../shared/storage';
import { getProviderConfig } from '../shared/settings';
import { sendToBackground } from '../shared/messages';
import { fillLanguageSelect } from '../shared/dom';
import { debounce } from '../shared/utils';
import type { ExtensionSettings, ProviderSettings, PublicSettings } from '../shared/types';
import { GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, PROVIDERS_REQUIRING_KEY } from '../shared/constants';

/** Inputs stored per provider (each provider keeps its own key/endpoint/model). */
const PROVIDER_FIELDS: Array<{ id: string; key: keyof ProviderSettings }> = [
  { id: 'apiKey', key: 'apiKey' },
  { id: 'apiEndpoint', key: 'apiEndpoint' },
  { id: 'apiModel', key: 'apiModel' },
];

type FieldType = 'select' | 'number' | 'checkbox' | 'range' | 'color';
type SettingKey = keyof PublicSettings;

const FIELDS: Array<{ id: SettingKey; type: FieldType }> = [
  { id: 'sourceLanguage', type: 'select' },
  { id: 'targetLanguage', type: 'select' },
  { id: 'translationProvider', type: 'select' },
  { id: 'originalFontSize', type: 'range' },
  { id: 'translationFontSize', type: 'range' },
  { id: 'originalColor', type: 'color' },
  { id: 'translationColor', type: 'color' },
  { id: 'backgroundOpacity', type: 'range' },
  { id: 'subtitlePosition', type: 'select' },
  { id: 'customVerticalOffset', type: 'range' },
  { id: 'subtitleMaxWidth', type: 'range' },
  { id: 'fallbackToGoogle', type: 'checkbox' },
  { id: 'maxConcurrentTranslations', type: 'number' },
  { id: 'preFetchNext', type: 'checkbox' },
  { id: 'smartSentenceMode', type: 'checkbox' },
  { id: 'restorePunctuation', type: 'checkbox' },
  { id: 'cacheTTLDays', type: 'number' },
  { id: 'maxCacheEntries', type: 'number' },
  { id: 'qaLearningMode', type: 'checkbox' },
];

/** Sliders and color pickers fire on every movement; storage is written once they settle. */
const LIVE_INPUT_SAVE_DELAY_MS = 150;

class OptionsController {
  private settings!: ExtensionSettings;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    this.settings = await readSettings();
    fillLanguageSelect(document.getElementById('sourceLanguage') as HTMLSelectElement | null, this.settings.sourceLanguage);
    fillLanguageSelect(document.getElementById('targetLanguage') as HTMLSelectElement | null, this.settings.targetLanguage);
    this.render();
    this.bindEvents();
    this.refreshCacheStats();
  }

  /** Shows the stored values in the form. */
  private render(): void {
    for (const field of FIELDS) this.setFieldValue(field.id, field.type, this.settings[field.id]);
    this.renderProviderConfig();
    this.updateProviderFields();
    this.updatePositionFields();
  }

  private bindEvents(): void {
    for (const field of FIELDS) {
      const el = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement | null;
      if (!el) continue;

      const live = field.type === 'range' || field.type === 'color';
      const save = live
        ? debounce(() => this.saveSetting(field.id, this.readFieldValue(el, field.type)), LIVE_INPUT_SAVE_DELAY_MS)
        : () => this.saveSetting(field.id, this.readFieldValue(el, field.type));

      el.addEventListener(live ? 'input' : 'change', () => {
        // Update the displayed value right away; the stored value follows.
        const display = document.getElementById(`${field.id}Val`);
        if (display) display.textContent = String(this.readFieldValue(el, field.type));
        save();
      });
    }

    // Provider-specific credentials
    for (const field of PROVIDER_FIELDS) {
      document.getElementById(field.id)?.addEventListener('change', async (e) => {
        const value = (e.target as HTMLInputElement).value.trim();
        if (field.key === 'apiEndpoint' && value) await this.requestEndpointAccess(value);
        this.settings = await sendToBackground('UPDATE_PROVIDER_CONFIG', {
          provider: this.settings.translationProvider,
          config: { [field.key]: value },
        });
        this.showSaveStatus();
      });
    }

    // Position change — show/hide custom offset
    document.getElementById('subtitlePosition')?.addEventListener('change', () => {
      this.updatePositionFields();
    });

    // Clear cache
    document.getElementById('clearCache')?.addEventListener('click', async () => {
      try {
        await sendToBackground('CLEAR_CACHE');
        this.showSaveStatus('Cache cleared');
      } catch (err) {
        this.showSaveStatus(`Could not clear cache: ${err instanceof Error ? err.message : err}`);
      }
      this.refreshCacheStats();
    });

    // Open dictionary
    document.getElementById('openDictionary')?.addEventListener('click', () => {
      const url = chrome.runtime.getURL('src/dictionary/dictionary.html');
      chrome.tabs.create({ url });
    });
  }

  private readFieldValue(el: HTMLInputElement | HTMLSelectElement, type: FieldType): string | number | boolean {
    if (type === 'checkbox') return (el as HTMLInputElement).checked;
    if (type === 'range' || type === 'number') return Number(el.value);
    return el.value;
  }

  private setFieldValue(id: string, type: FieldType, value: unknown): void {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) {
      if (type === 'checkbox') (el as HTMLInputElement).checked = Boolean(value);
      else el.value = String(value);
    }
    const display = document.getElementById(`${id}Val`);
    if (display) display.textContent = String(value);
  }

  private async saveSetting(key: SettingKey, value: unknown): Promise<void> {
    try {
      this.settings = await sendToBackground('UPDATE_SETTINGS', { [key]: value } as Partial<PublicSettings>);
    } catch (err) {
      this.showSaveStatus(`Not saved: ${err instanceof Error ? err.message : err}`);
      return;
    }
    // The background clamps invalid input (e.g. an empty number field) — show the stored value.
    const field = FIELDS.find((f) => f.id === key);
    if (field) this.setFieldValue(key, field.type, this.settings[key]);
    if (key === 'translationProvider') {
      this.renderProviderConfig();
      this.updateProviderFields();
    }
    this.showSaveStatus();
  }

  /**
   * Custom endpoints on hosts outside the manifest's host_permissions need an optional host
   * permission, or the service worker's requests would be blocked by CORS. The endpoint is
   * saved either way; the hint tells whether requests to it can work.
   */
  private async requestEndpointAccess(endpoint: string): Promise<void> {
    const hint = document.getElementById('apiEndpointHint');
    const show = (text: string) => {
      if (hint) hint.textContent = text;
    };
    let origin: string;
    try {
      origin = `${new URL(endpoint).origin}/*`;
    } catch {
      show('Not a valid URL — the default endpoint is used.');
      return;
    }
    try {
      const granted =
        (await chrome.permissions.contains({ origins: [origin] })) || (await chrome.permissions.request({ origins: [origin] }));
      show(granted ? `Access to ${origin} granted.` : `Access to ${origin} was not granted — requests to it will fail.`);
    } catch (err) {
      // Non-https hosts other than localhost cannot be requested (and are ignored by the providers).
      show(`Cannot request access to ${origin}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async refreshCacheStats(): Promise<void> {
    const el = document.getElementById('cacheStats');
    if (!el) return;
    try {
      const { count, oldestTimestamp } = await sendToBackground('GET_CACHE_STATS');
      const since = oldestTimestamp ? `, oldest from ${new Date(oldestTimestamp).toLocaleDateString()}` : '';
      el.textContent = `${count.toLocaleString()} cached translation${count === 1 ? '' : 's'}${since}`;
    } catch {
      el.textContent = 'Cache stats unavailable';
    }
  }

  private renderProviderConfig(): void {
    const config = getProviderConfig(this.settings);
    for (const field of PROVIDER_FIELDS) {
      const el = document.getElementById(field.id) as HTMLInputElement | null;
      if (el) el.value = config[field.key];
    }
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
    const provider = this.settings.translationProvider;
    const usesKey = provider !== 'google-free';

    const apiKeyGroup = document.getElementById('apiKeyGroup');
    const apiEndpointGroup = document.getElementById('apiEndpointGroup');
    const apiModelGroup = document.getElementById('apiModelGroup');
    const apiKeyHint = document.getElementById('apiKeyHint');
    const modelInput = document.getElementById('apiModel') as HTMLInputElement | null;

    if (apiKeyGroup) apiKeyGroup.style.display = usesKey ? '' : 'none';
    if (apiEndpointGroup) apiEndpointGroup.style.display = usesKey ? '' : 'none';
    if (apiModelGroup) apiModelGroup.style.display = ['openai', 'gemini'].includes(provider) ? '' : 'none';

    if (modelInput) {
      if (provider === 'gemini') modelInput.placeholder = `e.g., ${GEMINI_DEFAULT_MODEL} (default)`;
      else if (provider === 'openai') modelInput.placeholder = `e.g., ${OPENAI_DEFAULT_MODEL} (default)`;
    }

    if (apiKeyHint) {
      const link = (href: string, text: string) =>
        `<a href="${href}" target="_blank" style="color: #60a5fa; text-decoration: underline;">${text}</a>`;
      if (provider === 'gemini') {
        apiKeyHint.innerHTML = `Get your free key at ${link('https://aistudio.google.com/apikey', 'aistudio.google.com/apikey')}. Endpoint and model can be left empty.`;
      } else if (provider === 'openai') {
        apiKeyHint.innerHTML = `Get your key at ${link('https://platform.openai.com/api-keys', 'platform.openai.com/api-keys')}. Endpoint and model can be left empty.`;
      } else if (provider === 'deepl') {
        apiKeyHint.innerHTML = `Get a key at ${link('https://www.deepl.com/pro-api', 'deepl.com/pro-api')} (500k chars/mo free).`;
      } else if (provider === 'google-cloud') {
        apiKeyHint.innerHTML = `Get a Cloud API key at ${link('https://console.cloud.google.com/apis/credentials', 'console.cloud.google.com')}.`;
      } else {
        apiKeyHint.textContent = PROVIDERS_REQUIRING_KEY.has(provider)
          ? 'Stored in this browser profile and sent only to the selected provider.'
          : 'Optional. Stored in this browser profile and sent only to the selected provider.';
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
}

const options = new OptionsController();
options.init().catch(console.error);
