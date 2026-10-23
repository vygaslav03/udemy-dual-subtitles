/**
 * Background Service Worker — Udemy Dual Subtitles.
 *
 * Handles:
 * - Translation execution (bypasses Udemy CSP & CORS with host_permissions)
 * - Settings and dictionary writes (SettingsStore is the single writer)
 * - Pushing credential-free settings and cache clears to open Udemy tabs
 * - Keyboard shortcut commands
 * - SPA navigation detection via chrome.tabs.onUpdated
 */
import { onStoredSettingsChanged } from '../shared/storage';
import {
  getProviderConfig,
  toPublicSettings,
  translationConfigChanged,
} from '../shared/settings';
import { PROVIDER_LABELS, SUPPORTED_LANGUAGES } from '../shared/constants';
import {
  EXTENSION_PAGE_ONLY,
  type BackgroundAction,
  type BackgroundRequests,
  type Message,
  type PayloadOf,
  type ResultOf,
  type TabAction,
  type TabRequests,
} from '../shared/messages';
import { SettingsStore } from './SettingsStore';
import { TranslationManager } from '../translation/TranslationManager';
import { ProviderError } from '../translation/TranslationProvider';
import type { ExtensionSettings, LanguageCode, MessageResponse } from '../shared/types';
import { log, logError } from '../shared/utils';

const store = new SettingsStore();
let translationManager: TranslationManager | null = null;

/** Content scripts run on every udemy.com page (`*.udemy.com` also matches the bare domain). */
const UDEMY_TAB_URLS = ['https://*.udemy.com/*'];

function providerConfigOf(settings: ExtensionSettings) {
  const cfg = getProviderConfig(settings);
  return { apiKey: cfg.apiKey, endpoint: cfg.apiEndpoint, model: cfg.apiModel };
}

async function getTranslationManager(): Promise<TranslationManager> {
  if (!translationManager) {
    const settings = await store.load();
    translationManager = new TranslationManager(
      settings.maxConcurrentTranslations,
      settings.maxCacheEntries,
      settings.cacheTTLDays
    );
    translationManager.setFallbackEnabled(settings.fallbackToGoogle);
    translationManager.setProvider(settings.translationProvider, providerConfigOf(settings));
  }
  return translationManager;
}

async function broadcastToUdemyTabs<A extends TabAction>(action: A, payload?: TabRequests[A]['payload']): Promise<void> {
  const tabs = await chrome.tabs.query({ url: UDEMY_TAB_URLS });
  const message: Message<A> = { action, payload };
  for (const tab of tabs) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

// Settings changed (by any context): reconfigure translation and push the public view to open tabs.
onStoredSettingsChanged((newSettings, oldSettings) => {
  if (translationManager) {
    translationManager.setMaxConcurrent(newSettings.maxConcurrentTranslations);
    translationManager.updateCacheConfig(newSettings.maxCacheEntries, newSettings.cacheTTLDays);
    translationManager.setFallbackEnabled(newSettings.fallbackToGoogle);
    if (
      newSettings.translationProvider !== oldSettings.translationProvider ||
      JSON.stringify(getProviderConfig(newSettings)) !==
        JSON.stringify(getProviderConfig(oldSettings, newSettings.translationProvider))
    ) {
      translationManager.setProvider(newSettings.translationProvider, providerConfigOf(newSettings));
    }
  }

  const settings = toPublicSettings(newSettings);
  const previous = toPublicSettings(oldSettings);
  const translationChanged = translationConfigChanged(oldSettings, newSettings);
  // Credentials of a provider that is not active change nothing a tab can see.
  if (!translationChanged && JSON.stringify(settings) === JSON.stringify(previous)) return;
  broadcastToUdemyTabs('SETTINGS_CHANGED', { settings, previous, translationChanged }).catch(() => {});
});

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  log(`Command received: ${command}`);

  switch (command) {
    case 'toggle-dual-subtitles':
      await store.modify((s) => ({ enabled: !s.enabled }));
      break;

    case 'toggle-translation': {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        const message: Message<TabAction> = { action: 'TOGGLE_TRANSLATION' };
        chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
      }
      break;
    }

    case 'increase-subtitle-size':
    case 'decrease-subtitle-size': {
      const step = command === 'increase-subtitle-size' ? 2 : -2;
      // Clamped to the allowed range by the store.
      await store.modify((s) => ({
        originalFontSize: s.originalFontSize + step,
        translationFontSize: s.translationFontSize + step,
      }));
      break;
    }
  }
});

// Detect Udemy SPA navigation: content scripts run in an isolated world and cannot see the
// page's history.pushState calls, so the tab URL is watched here (the content script ignores
// hash/query-only changes).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && isUdemyUrl(changeInfo.url)) {
    const message: Message<TabAction> = { action: 'URL_CHANGED', payload: { url: changeInfo.url } };
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  }
});

// Caption files downloaded by the Udemy player (it renders captions itself, without <track>).
// Complements Resource Timing in the content script, which misses requests made outside the
// page's main document (workers, frames); observational only.
chrome.webRequest?.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode !== 200) return;
    if (!/\.(web)?vtt(\?|$)/i.test(details.url) || /thumb|sprite|storyboard/i.test(details.url)) return;
    const message: Message<TabAction> = { action: 'VTT_RESOURCE', payload: { url: details.url } };
    chrome.tabs.sendMessage(details.tabId, message).catch(() => {});
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

// ============================================================
// Message router
// ============================================================

const LANGUAGE_CODES = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.code));
const MAX_TEXT_LENGTH = 5000;

class InvalidRequestError extends Error {}

function requireText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new InvalidRequestError(`Invalid ${field}`);
  return value;
}

function requireLanguage(value: unknown): LanguageCode {
  if (typeof value !== 'string' || !LANGUAGE_CODES.has(value)) throw new InvalidRequestError('Invalid language');
  return value as LanguageCode;
}

function requireObject<T extends object>(value: unknown): T {
  if (!value || typeof value !== 'object') throw new InvalidRequestError('Invalid payload');
  return value as T;
}

type Handlers = { [A in BackgroundAction]: (payload: PayloadOf<A>) => Promise<ResultOf<A>> };

/**
 * Payloads from content scripts are validated: a compromised Udemy page process could send anything.
 */
const handlers: Handlers = {
  GET_SETTINGS: async () => toPublicSettings(await store.load()),

  UPDATE_SETTINGS: (update) => store.update(requireObject(update)),

  UPDATE_PROVIDER_CONFIG: (payload) => {
    const { provider, config } = requireObject<BackgroundRequests['UPDATE_PROVIDER_CONFIG']['payload']>(payload);
    if (!(provider in PROVIDER_LABELS)) throw new InvalidRequestError('Unknown provider');
    return store.updateProviderConfig(provider, requireObject(config));
  },

  TRANSLATE_TEXT: async (payload) => {
    const { text, source, target, context } = requireObject<PayloadOf<'TRANSLATE_TEXT'>>(payload);
    const mgr = await getTranslationManager();
    return mgr.translate(requireText(text, 'text'), requireLanguage(source), requireLanguage(target), {
      previous: context?.previous === undefined ? undefined : requireText(context.previous, 'context'),
      upcoming: context?.upcoming === undefined ? undefined : requireText(context.upcoming, 'context'),
    });
  },

  TRANSLATE_BATCH: async (payload) => {
    const req = requireObject<PayloadOf<'TRANSLATE_BATCH'>>(payload);
    if (!Array.isArray(req.segments) || req.segments.some((s) => typeof s?.text !== 'string')) {
      throw new InvalidRequestError('Invalid TRANSLATE_BATCH payload');
    }
    requireLanguage(req.source);
    requireLanguage(req.target);
    const mgr = await getTranslationManager();
    return mgr.translateBatch(req);
  },

  CANCEL_PREFETCH: async () => {
    (await getTranslationManager()).cancelPending('low');
  },

  CLEAR_CACHE: async () => {
    await (await getTranslationManager()).clearCache();
    await broadcastToUdemyTabs('CACHE_CLEARED'); // open tabs drop their in-memory caches
  },

  GET_CACHE_STATS: async () => (await getTranslationManager()).getCacheStats(),

  FETCH_VTT: async (payload) => {
    const { url } = requireObject<PayloadOf<'FETCH_VTT'>>(payload);
    if (typeof url !== 'string' || !isAllowedVttUrl(url)) throw new InvalidRequestError('URL not allowed');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  },

  SAVE_WORD: (payload) => {
    const entry = requireObject<PayloadOf<'SAVE_WORD'>>(payload);
    return store.saveWord({
      word: requireText(entry.word, 'word', 500).trim(),
      translation: requireText(entry.translation, 'translation'),
      qaMeaning: requireText(entry.qaMeaning, 'qaMeaning'),
      example: requireText(entry.example, 'example'),
      sourceUrl: entry.sourceUrl === undefined ? undefined : requireText(entry.sourceUrl, 'sourceUrl', 2000),
    });
  },

  DELETE_WORD: (payload) => store.deleteWord(requireText(requireObject<{ id: string }>(payload).id, 'id', 100)),
};

/** Extension pages (popup, options, dictionary) are served from the extension origin; content scripts are not. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message?.action !== 'string' || !(message.action in handlers)) {
    return false;
  }
  const action = message.action as BackgroundAction;
  // Note: an options page opened in a tab also has `sender.tab`, so origin is what tells them apart.
  if (EXTENSION_PAGE_ONLY.has(action) && !isExtensionPage(sender)) {
    sendResponse({ success: false, error: 'Not allowed from content scripts' } satisfies MessageResponse);
    return false;
  }
  handleMessage(action, message.payload, sendResponse);
  return true; // Asynchronous response
});

async function handleMessage(
  action: BackgroundAction,
  payload: unknown,
  sendResponse: (response: MessageResponse) => void
): Promise<void> {
  try {
    const handler = handlers[action] as (payload: unknown) => Promise<unknown>;
    sendResponse({ success: true, data: await handler(payload) });
  } catch (err) {
    const cancelled = err instanceof ProviderError && err.kind === 'cancelled';
    if (!cancelled) logError(`Error handling ${action}:`, err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      errorCode: err instanceof ProviderError ? err.kind : undefined,
    });
  }
}

// Extension installation/update lifecycle: run pending settings migrations once.
chrome.runtime.onInstalled.addListener((details) => {
  log(`Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
  store.load().catch((err) => logError('Settings migration failed:', err));
});
