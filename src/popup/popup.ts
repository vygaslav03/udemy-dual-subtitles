/**
 * Popup Script — Udemy Dual Subtitles.
 *
 * Reads settings from storage (trusted extension page); writes go through the background.
 */
import { readSettings } from '../shared/storage';
import { getProviderConfig } from '../shared/settings';
import { sendToBackground, sendToTab } from '../shared/messages';
import { fillLanguageSelect } from '../shared/dom';
import type { ExtensionSettings, LanguageCode, PublicSettings, TranslationProviderType } from '../shared/types';
import { GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, PROVIDER_LABELS, PROVIDERS_REQUIRING_KEY } from '../shared/constants';

class PopupController {
  private settings!: ExtensionSettings;

  async init(): Promise<void> {
    this.settings = await readSettings();
    this.render();
    this.bindEvents();
    this.checkStatus();
  }

  private render(): void {
    const version = document.getElementById('popupVersion');
    if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;

    // Toggle
    const toggle = document.getElementById('toggleEnabled') as HTMLInputElement;
    toggle.checked = this.settings.enabled;
    this.updateToggleStatus(this.settings.enabled);

    // Languages
    fillLanguageSelect(document.getElementById('sourceLanguage') as HTMLSelectElement | null, this.settings.sourceLanguage);
    fillLanguageSelect(document.getElementById('targetLanguage') as HTMLSelectElement | null, this.settings.targetLanguage);

    // Provider
    const providerSelect = document.getElementById('translationProvider') as HTMLSelectElement | null;
    if (providerSelect) {
      providerSelect.value = this.settings.translationProvider;
    }

    // Smart sentence toggle
    const smartToggle = document.getElementById('smartSentenceMode') as HTMLInputElement | null;
    if (smartToggle) {
      smartToggle.checked = this.settings.smartSentenceMode;
      this.updateSmartSentenceStatus(this.settings.smartSentenceMode);
    }

    // Update Provider UI (API key panel and banner)
    this.updateProviderUI();
  }

  private async save(update: Partial<PublicSettings>): Promise<void> {
    this.settings = await sendToBackground('UPDATE_SETTINGS', update);
  }

  private bindEvents(): void {
    // Toggle
    document.getElementById('toggleEnabled')?.addEventListener('change', async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await this.save({ enabled });
      this.updateToggleStatus(enabled);
    });

    // Smart sentences toggle
    document.getElementById('smartSentenceMode')?.addEventListener('change', async (e) => {
      const smartSentenceMode = (e.target as HTMLInputElement).checked;
      await this.save({ smartSentenceMode });
      this.updateSmartSentenceStatus(smartSentenceMode);
    });

    // Languages
    document.getElementById('sourceLanguage')?.addEventListener('change', async (e) => {
      await this.save({ sourceLanguage: (e.target as HTMLSelectElement).value as LanguageCode });
    });
    document.getElementById('targetLanguage')?.addEventListener('change', async (e) => {
      await this.save({ targetLanguage: (e.target as HTMLSelectElement).value as LanguageCode });
    });

    // Translation provider
    document.getElementById('translationProvider')?.addEventListener('change', async (e) => {
      await this.save({ translationProvider: (e.target as HTMLSelectElement).value as TranslationProviderType });
      this.updateProviderUI();
      this.checkStatus();
    });

    // Save API key / model directly from popup
    const bindProviderField = (buttonId: string, inputId: string, field: 'apiKey' | 'apiModel', label: string) => {
      document.getElementById(buttonId)?.addEventListener('click', async () => {
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        if (!input) return;
        this.settings = await sendToBackground('UPDATE_PROVIDER_CONFIG', {
          provider: this.settings.translationProvider,
          config: { [field]: input.value.trim() },
        });
        const btn = document.getElementById(buttonId);
        if (btn) {
          btn.textContent = '✓ Saved';
          setTimeout(() => {
            btn.textContent = label;
          }, 1500);
        }
        this.updateProviderUI();
        this.checkStatus();
      });
    };
    bindProviderField('saveApiKeyBtn', 'popupApiKey', 'apiKey', 'Save');
    bindProviderField('saveModelBtn', 'popupApiModel', 'apiModel', 'Set');

    // Settings button
    document.getElementById('openSettings')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // Dictionary button
    document.getElementById('openDictionary')?.addEventListener('click', () => {
      const url = chrome.runtime.getURL('src/dictionary/dictionary.html');
      chrome.tabs.create({ url });
    });
  }

  private updateProviderUI(): void {
    const provider = this.settings.translationProvider;
    const config = getProviderConfig(this.settings);
    const apiKeyPanel = document.getElementById('apiKeyPanel');
    const apiKeyInput = document.getElementById('popupApiKey') as HTMLInputElement | null;
    const modelRow = document.getElementById('modelRow');
    const modelInput = document.getElementById('popupApiModel') as HTMLInputElement | null;
    const apiKeyHintText = document.getElementById('apiKeyHintText');
    const banner = document.getElementById('providerBanner');

    const needsKey = PROVIDERS_REQUIRING_KEY.has(provider);

    if (apiKeyPanel) {
      apiKeyPanel.style.display = needsKey ? 'block' : 'none';
    }

    if (modelRow) {
      modelRow.style.display = ['gemini', 'openai'].includes(provider) ? 'flex' : 'none';
    }

    if (modelInput) {
      modelInput.value = config.apiModel;
      if (provider === 'gemini') {
        modelInput.placeholder = `Model (default ${GEMINI_DEFAULT_MODEL})`;
      } else if (provider === 'openai') {
        modelInput.placeholder = `Model (default ${OPENAI_DEFAULT_MODEL})`;
      }
    }

    if (apiKeyInput) {
      apiKeyInput.value = config.apiKey;
      apiKeyInput.placeholder = `Paste ${PROVIDER_LABELS[provider]} API key...`;
    }

    if (apiKeyHintText) {
      if (provider === 'gemini') {
        apiKeyHintText.innerHTML = 'Free key: <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>';
      } else if (provider === 'openai') {
        apiKeyHintText.innerHTML = 'Get key: <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>';
      } else {
        apiKeyHintText.textContent = 'Stored in this browser profile and sent only to the selected provider.';
      }
    }

    if (banner) {
      banner.style.display = 'flex';
      const fallback = this.settings.fallbackToGoogle;
      if (needsKey && !config.apiKey) {
        banner.className = 'provider-banner warning';
        banner.textContent = fallback
          ? `⚠️ ${PROVIDER_LABELS[provider]} needs an API key. Google Translate is used until you add one.`
          : `⚠️ ${PROVIDER_LABELS[provider]} needs an API key. Subtitles stay untranslated until you add one.`;
      } else if (needsKey) {
        banner.className = 'provider-banner success';
        const activeModel =
          config.apiModel ||
          (provider === 'gemini' ? GEMINI_DEFAULT_MODEL : provider === 'openai' ? OPENAI_DEFAULT_MODEL : PROVIDER_LABELS[provider]);
        banner.textContent = fallback ? `✨ ${activeModel} active (falls back to Google on errors)` : `✨ ${activeModel} active`;
      } else {
        banner.className = 'provider-banner info';
        banner.textContent =
          provider === 'google-free' ? '⚡ Google Translate (Enhanced with IT/QA dictionary)' : `🔓 ${PROVIDER_LABELS[provider]}`;
      }
    }
  }

  private updateToggleStatus(enabled: boolean): void {
    const statusEl = document.getElementById('toggleStatus');
    if (statusEl) {
      statusEl.textContent = enabled ? 'ON' : 'OFF';
      statusEl.className = `toggle-status ${enabled ? 'on' : 'off'}`;
    }
  }

  private updateSmartSentenceStatus(enabled: boolean): void {
    const statusEl = document.getElementById('smartSentenceStatus');
    if (statusEl) {
      statusEl.textContent = enabled ? 'ON' : 'OFF';
      statusEl.className = `toggle-status ${enabled ? 'on' : 'off'}`;
    }
  }

  private async checkStatus(): Promise<void> {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const providerName = document.getElementById('providerName');

    if (!statusDot || !statusText || !providerName) return;

    providerName.textContent = `Provider: ${PROVIDER_LABELS[this.settings.translationProvider]}`;

    // Check if we're on a Udemy page
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.url?.includes('udemy.com')) {
        statusDot.className = 'status-dot inactive';
        statusText.textContent = 'Open a Udemy course to use';
        return;
      }

      // Try to get status from content script
      if (tab.id) {
        try {
          const { detected } = await sendToTab(tab.id, 'GET_STATUS');
          if (detected) {
            statusDot.className = 'status-dot active';
            statusText.textContent = 'Subtitles detected';
          } else {
            statusDot.className = 'status-dot waiting';
            statusText.textContent = 'Looking for subtitles...';
          }
        } catch {
          statusDot.className = 'status-dot waiting';
          statusText.textContent = 'Refresh page (F5) to connect';
        }
      }
    } catch {
      statusDot.className = 'status-dot inactive';
      statusText.textContent = 'Unable to check status';
    }
  }
}

// Init
const popup = new PopupController();
popup.init().catch(console.error);
