/**
 * Chrome storage wrapper for type-safe settings management.
 */
import type {
  ExtensionSettings,
  DictionaryEntry,
  ProviderSettings,
  TranslationProviderType,
} from './types';
import { DEFAULT_SETTINGS, CACHE_EPOCH_KEY, GEMINI_DEFAULT_MODEL } from './constants';
import { generateId } from './utils';

// ============================================================
// Settings (chrome.storage.local)
// ============================================================

const SETTINGS_KEY = 'uds_settings';

const EMPTY_PROVIDER_SETTINGS: ProviderSettings = { apiKey: '', apiEndpoint: '', apiModel: '' };

/** Settings as stored before per-provider configs existed (v1). */
type StoredSettings = Partial<ExtensionSettings> & {
  apiKey?: string;
  apiEndpoint?: string;
  apiModel?: string;
};

/**
 * Normalizes raw stored settings: merges defaults and migrates the legacy shared
 * apiKey/apiEndpoint/apiModel into the config of the provider that was active.
 */
export function normalizeSettings(stored: StoredSettings | undefined): ExtensionSettings {
  const { apiKey, apiEndpoint, apiModel, ...rest } = stored || {};
  const merged: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    ...rest,
    providerConfigs: { ...(rest.providerConfigs || {}) },
  };

  if ((apiKey || apiEndpoint || apiModel) && !merged.providerConfigs[merged.translationProvider]) {
    merged.providerConfigs[merged.translationProvider] = {
      apiKey: apiKey || '',
      apiEndpoint: apiEndpoint || '',
      apiModel: apiModel || '',
    };
  }

  // The on-device Translator API is not available in the service worker (see ChromeBuiltinProvider).
  if (merged.translationProvider === 'chrome-builtin') {
    merged.translationProvider = 'google-free';
  }

  // Auto-migrate retired Gemini models
  const gemini = merged.providerConfigs.gemini;
  if (gemini?.apiModel && (gemini.apiModel.includes('2.0-flash') || gemini.apiModel.includes('1.5-flash'))) {
    merged.providerConfigs.gemini = { ...gemini, apiModel: GEMINI_DEFAULT_MODEL };
  }

  return merged;
}

/**
 * Loads extension settings from chrome.storage.local.
 * Merges with defaults to handle missing keys after updates.
 */
export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY] as StoredSettings | undefined);
}

/**
 * Saves partial settings update to chrome.storage.local.
 */
export async function saveSettings(update: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const merged = { ...current, ...update };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

/** Returns the credentials/overrides of a provider (the active one by default). */
export function getProviderConfig(
  settings: ExtensionSettings,
  type: TranslationProviderType = settings.translationProvider
): ProviderSettings {
  return { ...EMPTY_PROVIDER_SETTINGS, ...settings.providerConfigs[type] };
}

/** Updates the credentials/overrides of a single provider. */
export async function saveProviderConfig(
  type: TranslationProviderType,
  update: Partial<ProviderSettings>
): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const providerConfigs = {
    ...current.providerConfigs,
    [type]: { ...getProviderConfig(current, type), ...update },
  };
  return saveSettings({ providerConfigs });
}

/**
 * Listens for settings changes.
 */
export function onSettingsChanged(
  callback: (newSettings: ExtensionSettings, oldSettings: ExtensionSettings) => void
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (areaName === 'local' && changes[SETTINGS_KEY]) {
      const newVal = normalizeSettings(changes[SETTINGS_KEY].newValue as StoredSettings | undefined);
      const oldVal = normalizeSettings(changes[SETTINGS_KEY].oldValue as StoredSettings | undefined);
      callback(newVal, oldVal);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Signals every context (open Udemy tabs included) that the translation cache was cleared. */
export async function bumpCacheEpoch(): Promise<void> {
  await chrome.storage.local.set({ [CACHE_EPOCH_KEY]: Date.now() });
}

export function onCacheCleared(callback: () => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName === 'local' && changes[CACHE_EPOCH_KEY]) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ============================================================
// QA Dictionary (chrome.storage.local)
// Shared across Content Script, Background, Popup & Extension Pages
// ============================================================

const DICTIONARY_KEY = 'uds_dictionary';

/**
 * Gets all dictionary entries, sorted by addedAt descending.
 */
export async function getDictionaryWords(): Promise<DictionaryEntry[]> {
  const result = await chrome.storage.local.get(DICTIONARY_KEY);
  const entries = (result[DICTIONARY_KEY] as DictionaryEntry[] | undefined) || [];
  return entries.sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Saves a word to the QA dictionary.
 */
export async function saveDictionaryWord(
  entry: Omit<DictionaryEntry, 'id' | 'addedAt'>
): Promise<DictionaryEntry> {
  const allWords = await getDictionaryWords();
  const existingIndex = allWords.findIndex(
    (w) => w.word.trim().toLowerCase() === entry.word.trim().toLowerCase()
  );

  const fullEntry: DictionaryEntry = {
    ...entry,
    id: existingIndex >= 0 ? allWords[existingIndex].id : generateId(),
    addedAt: Date.now(),
  };

  if (existingIndex >= 0) {
    allWords[existingIndex] = fullEntry;
  } else {
    allWords.unshift(fullEntry);
  }

  await chrome.storage.local.set({ [DICTIONARY_KEY]: allWords });
  return fullEntry;
}

/**
 * Deletes a word from the dictionary.
 */
export async function deleteDictionaryWord(id: string): Promise<void> {
  const allWords = await getDictionaryWords();
  const filtered = allWords.filter((w) => w.id !== id);
  await chrome.storage.local.set({ [DICTIONARY_KEY]: filtered });
}

/**
 * Searches dictionary by word (partial match).
 */
export async function searchDictionary(query: string): Promise<DictionaryEntry[]> {
  const allWords = await getDictionaryWords();
  const lowerQuery = query.toLowerCase();
  return allWords.filter(
    (entry) =>
      entry.word.toLowerCase().includes(lowerQuery) ||
      entry.translation.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Exports dictionary to CSV string.
 */
export function exportDictionaryToCsv(entries: DictionaryEntry[]): string {
  const header = 'Word,Translation,QA Meaning,Example,Added At\n';
  const rows = entries.map((e) => {
    const escapeCsv = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const date = new Date(e.addedAt).toISOString().split('T')[0];
    return [
      escapeCsv(e.word),
      escapeCsv(e.translation),
      escapeCsv(e.qaMeaning),
      escapeCsv(e.example),
      date,
    ].join(',');
  });
  return header + rows.join('\n');
}
