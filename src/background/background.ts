/**
 * Background Service Worker — Udemy Dual Subtitles.
 *
 * Handles:
 * - Translation execution (bypasses Udemy CSP & CORS with host_permissions)
 * - Keyboard shortcut commands
 * - Message routing between popup/options and content scripts
 * - SPA navigation detection via chrome.tabs.onUpdated
 * - Translation cache management
 */
import { loadSettings, saveSettings, onSettingsChanged, getProviderConfig, bumpCacheEpoch } from '../shared/storage';
import { TranslationManager } from '../translation/TranslationManager';
import { ProviderError } from '../translation/TranslationProvider';
import type { LanguageCode, BatchTranslationRequest, ExtensionSettings, MessageResponse } from '../shared/types';
import { log, logError } from '../shared/utils';

let translationManager: TranslationManager | null = null;

function providerConfigOf(settings: ExtensionSettings) {
  const cfg = getProviderConfig(settings);
  return { apiKey: cfg.apiKey, endpoint: cfg.apiEndpoint, model: cfg.apiModel };
}

async function getTranslationManager(): Promise<TranslationManager> {
  if (!translationManager) {
    const settings = await loadSettings();
    translationManager = new TranslationManager(
      settings.maxConcurrentTranslations,
      settings.maxCacheEntries,
      settings.cacheTTLDays
    );
    translationManager.setProvider(settings.translationProvider, providerConfigOf(settings));
  }
  return translationManager;
}

// React to settings changes in background service worker
onSettingsChanged((newSettings, oldSettings) => {
  if (!translationManager) return;

  translationManager.setMaxConcurrent(newSettings.maxConcurrentTranslations);
  translationManager.updateCacheConfig(newSettings.maxCacheEntries, newSettings.cacheTTLDays);

  if (
    newSettings.translationProvider !== oldSettings.translationProvider ||
    JSON.stringify(getProviderConfig(newSettings)) !== JSON.stringify(getProviderConfig(oldSettings, newSettings.translationProvider))
  ) {
    translationManager.setProvider(newSettings.translationProvider, providerConfigOf(newSettings));
  }
});

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  log(`Command received: ${command}`);

  const settings = await loadSettings();

  switch (command) {
    case 'toggle-dual-subtitles':
      // Content scripts pick this up through chrome.storage.onChanged.
      await saveSettings({ enabled: !settings.enabled });
      break;

    case 'toggle-translation': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'TOGGLE_TRANSLATION' }).catch(() => {});
      }
      break;
    }

    case 'increase-subtitle-size':
      await saveSettings({
        originalFontSize: Math.min(settings.originalFontSize + 2, 48),
        translationFontSize: Math.min(settings.translationFontSize + 2, 48),
      });
      break;

    case 'decrease-subtitle-size':
      await saveSettings({
        originalFontSize: Math.max(settings.originalFontSize - 2, 12),
        translationFontSize: Math.max(settings.translationFontSize - 2, 12),
      });
      break;
  }
});

// Detect Udemy SPA navigation (the content script ignores hash/query-only changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && isUdemyUrl(changeInfo.url)) {
    chrome.tabs.sendMessage(tabId, {
      action: 'URL_CHANGED',
      payload: { url: changeInfo.url },
    }).catch(() => {});
  }
});

// Caption files downloaded by the Udemy player (it renders captions itself, without <track>).
// Complements Resource Timing in the content script; observational only.
chrome.webRequest?.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode !== 200) return;
    if (!/\.(web)?vtt(\?|$)/i.test(details.url) || /thumb|sprite|storyboard/i.test(details.url)) return;
    chrome.tabs.sendMessage(details.tabId, { action: 'VTT_RESOURCE', payload: { url: details.url } }).catch(() => {});
  },
  { urls: ['https://*.udemycdn.com/*', 'https://*.udemy.com/*'] }
);

function isUdemyUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'udemy.com' || hostname.endsWith('.udemy.com'));
  } catch {
    return false;
  }
}

/** Subtitle files are only fetched from Udemy's own hosts. */
function isAllowedVttUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' &&
      (hostname === 'udemycdn.com' || hostname.endsWith('.udemycdn.com') ||
        hostname === 'udemy.com' || hostname.endsWith('.udemy.com'))
    );
  } catch {
    return false;
  }
}

/** Actions that change configuration are only accepted from extension pages, not content scripts. */
const EXTENSION_PAGE_ONLY = new Set(['UPDATE_SETTINGS', 'CLEAR_CACHE']);

// Handle messages from popup / options / content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message?.action !== 'string') {
    return false;
  }
  if (EXTENSION_PAGE_ONLY.has(message.action) && sender.tab) {
    sendResponse({ success: false, error: 'Not allowed from content scripts' } satisfies MessageResponse);
    return false;
  }
  handleBackgroundMessage(message, sendResponse);
  return true; // Asynchronous response
});

async function handleBackgroundMessage(
  message: { action: string; payload?: unknown },
  sendResponse: (response: MessageResponse) => void
): Promise<void> {
  try {
    switch (message.action) {
      case 'GET_SETTINGS': {
        const settings = await loadSettings();
        sendResponse({ success: true, data: settings });
        break;
      }

      case 'UPDATE_SETTINGS': {
        const updated = await saveSettings(message.payload as Partial<ExtensionSettings>);
        sendResponse({ success: true, data: updated });
        break;
      }

      case 'TRANSLATE_TEXT': {
        const { text, source, target, context } = message.payload as {
          text: string;
          source: LanguageCode;
          target: LanguageCode;
          context?: { previous?: string; upcoming?: string };
        };
        if (typeof text !== 'string') throw new Error('Invalid TRANSLATE_TEXT payload');
        const mgr = await getTranslationManager();
        const result = await mgr.translate(text, source, target, context);
        sendResponse({ success: true, data: result });
        break;
      }

      case 'TRANSLATE_BATCH': {
        const req = message.payload as BatchTranslationRequest;
        if (!Array.isArray(req?.segments)) throw new Error('Invalid TRANSLATE_BATCH payload');
        const mgr = await getTranslationManager();
        const result = await mgr.translateBatch(req);
        sendResponse({ success: true, data: result });
        break;
      }

      case 'CANCEL_PREFETCH': {
        const mgr = await getTranslationManager();
        mgr.cancelPending('low');
        sendResponse({ success: true });
        break;
      }

      case 'CLEAR_CACHE': {
        const mgr = await getTranslationManager();
        await mgr.clearCache();
        await bumpCacheEpoch(); // open Udemy tabs drop their in-memory caches
        sendResponse({ success: true });
        break;
      }

      case 'GET_CACHE_STATS': {
        const mgr = await getTranslationManager();
        const stats = await mgr.getCacheStats();
        sendResponse({ success: true, data: stats });
        break;
      }

      case 'FETCH_VTT': {
        const { url } = (message.payload || {}) as { url?: string };
        if (!url || !isAllowedVttUrl(url)) {
          sendResponse({ success: false, error: 'URL not allowed' });
          break;
        }
        const resp = await fetch(url);
        if (resp.ok) {
          sendResponse({ success: true, data: await resp.text() });
        } else {
          sendResponse({ success: false, error: `HTTP ${resp.status}` });
        }
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    }
  } catch (err) {
    const cancelled = err instanceof ProviderError && err.kind === 'cancelled';
    if (!cancelled) logError('Error handling background message:', err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: err instanceof ProviderError ? err.kind : undefined,
    });
  }
}

// Extension installation/update lifecycle
chrome.runtime.onInstalled.addListener((details) => {
  log(`Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
});
