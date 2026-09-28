/**
 * Popup Script — Udemy Dual Subtitles.
 */
import { getProviderConfig, loadSettings, saveProviderConfig, saveSettings } from '../shared/storage';
import type { ExtensionSettings, LanguageCode, TranslationProviderType } from '../shared/types';
import { GEMINI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from '../shared/constants';

class PopupController {
  private settings!: ExtensionSettings;

  async init(): Promise<void> {
    this.settings = await loadSettings();
    this.render();
    this.bindEvents();
    this.checkStatus();
  }

  private render(): void {
    // Toggle
    const toggle = document.getElementById('toggleEnabled') as HTMLInputElement;
    toggle.checked = this.settings.enabled;
    this.updateToggleStatus(this.settings.enabled);

    // Languages
    (document.getElementById('sourceLanguage') as HTMLSelectElement).value = this.settings.sourceLanguage;
    (document.getElementById('targetLanguage') as HTMLSelectElement).value = this.settings.targetLanguage;

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

  private bindEvents(): void {
    // Toggle
    document.getElementById('toggleEnabled')?.addEventListener('change', async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await saveSettings({ enabled });
      this.updateToggleStatus(enabled);
    });

    // Smart sentences toggle
    document.getElementById('smartSentenceMode')?.addEventListener('change', async (e) => {
      const smartSentenceMode = (e.target as HTMLInputElement).checked;
      await saveSettings({ smartSentenceMode });
      this.updateSmartSentenceStatus(smartSentenceMode);
    });

    // Source language
    document.getElementById('sourceLanguage')?.addEventListener('change', async (e) => {
      const value = (e.target as HTMLSelectElement).value as LanguageCode;
      await saveSettings({ sourceLanguage: value });
    });

    // Target language
    document.getElementById('targetLanguage')?.addEventListener('change', async (e) => {
      const value = (e.target as HTMLSelectElement).value as LanguageCode;
      await saveSettings({ targetLanguage: value });
    });

    // Translation provider
    document.getElementById('translationProvider')?.addEventListener('change', async (e) => {
      const value = (e.target as HTMLSelectElement).value as TranslationProviderType;
      this.settings = await saveSettings({ translationProvider: value });
      this.updateProviderUI();
      this.checkStatus();
    });

    // Save API key directly from popup
    document.getElementById('saveApiKeyBtn')?.addEventListener('click', async () => {
      const keyInput = document.getElementById('popupApiKey') as HTMLInputElement | null;
      if (keyInput) {
        const apiKey = keyInput.value.trim();
        this.settings = await saveProviderConfig(this.settings.translationProvider, { apiKey });
        const btn = document.getElementById('saveApiKeyBtn');
        if (btn) {
          btn.textContent = '✓ Saved';
          setTimeout(() => {
            if (btn) btn.textContent = 'Save';
          }, 1500);
        }
        this.updateProviderUI();
        this.checkStatus();
      }
    });

    // Save Model directly from popup
    document.getElementById('saveModelBtn')?.addEventListener('click', async () => {
      const modelInput = document.getElementById('popupApiModel') as HTMLInputElement | null;
      if (modelInput) {
        const apiModel = modelInput.value.trim();
        this.settings = await saveProviderConfig(this.settings.translationProvider, { apiModel });
        const btn = document.getElementById('saveModelBtn');
        if (btn) {
          btn.textContent = '✓ Saved';
          setTimeout(() => {
            if (btn) btn.textContent = 'Set';
          }, 1500);
        }
        this.updateProviderUI();
        this.checkStatus();
      }
    });

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

    const needsKey = ['gemini', 'openai', 'deepl', 'google-cloud'].includes(provider);

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
      if (provider === 'gemini') {
        apiKeyInput.placeholder = 'Paste Google Gemini API Key...';
      } else if (provider === 'openai') {
        apiKeyInput.placeholder = 'Paste OpenAI API Key...';
      } else {
        apiKeyInput.placeholder = 'Paste API Key here...';
      }
    }

    if (apiKeyHintText) {
      if (provider === 'gemini') {
        apiKeyHintText.innerHTML = 'Free key: <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>';
      } else if (provider === 'openai') {
        apiKeyHintText.innerHTML = 'Get key: <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>';
      }
    }

    if (banner) {
      if (needsKey && !config.apiKey) {
        banner.style.display = 'flex';
        banner.className = 'provider-banner warning';
        banner.textContent = `⚠️ ${provider.toUpperCase()} requires an API key! Currently falling back to Google Free.`;
      } else if (needsKey && config.apiKey) {
        banner.style.display = 'flex';
        banner.className = 'provider-banner success';
        const activeModel =
          config.apiModel ||
          (provider === 'gemini' ? GEMINI_DEFAULT_MODEL : provider === 'openai' ? OPENAI_DEFAULT_MODEL : provider);
        banner.textContent = `✨ ${activeModel} active (falls back to Google on errors)`;
      } else {
        banner.style.display = 'flex';
        banner.className = 'provider-banner info';
        banner.textContent = `⚡ Google Translate (Enhanced with IT/QA dictionary)`;
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

    // Update provider name
    const providerNames: Record<string, string> = {
      'chrome-builtin': 'Chrome Built-in (On-Device)',
      'google-free': 'Google Translate (Free)',
      'google-cloud': 'Google Cloud Translation',
      'deepl': 'DeepL',
      'openai': 'OpenAI',
      'gemini': 'Gemini',
      'libretranslate': 'LibreTranslate',
    };
    providerName.textContent = `Provider: ${providerNames[this.settings.translationProvider] || this.settings.translationProvider}`;

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
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_STATUS' });
          if (response?.success) {
            const { detected } = response.data;
            if (detected) {
              statusDot.className = 'status-dot active';
              statusText.textContent = 'Subtitles detected';
            } else {
              statusDot.className = 'status-dot waiting';
              statusText.textContent = 'Looking for subtitles...';
            }
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
