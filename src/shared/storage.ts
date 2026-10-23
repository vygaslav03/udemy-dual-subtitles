/**
 * chrome.storage.local access for trusted extension contexts (service worker and extension pages).
 *
 * - Content scripts never import this module: they get credential-free settings and push updates
 *   from the background via messages (see shared/messages.ts).
 * - All writes go through the background SettingsStore, a single writer, so concurrent updates
 *   from the popup, options page, shortcuts and content scripts cannot overwrite each other.
 *   Extension pages request writes with `sendToBackground('UPDATE_SETTINGS' | ...)`.
 */
import type { DictionaryEntry, ExtensionSettings } from './types';
import { normalizeSettings, type StoredSettings } from './settings';

export const SETTINGS_KEY = 'uds_settings';
export const DICTIONARY_KEY = 'uds_dictionary';

// ============================================================
// Settings
// ============================================================

/** Reads settings, migrated (in memory) and validated. */
export async function readSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY] as StoredSettings | undefined);
}

/** Calls back with normalized settings whenever the stored settings change. */
export function onStoredSettingsChanged(
  callback: (newSettings: ExtensionSettings, oldSettings: ExtensionSettings) => void
): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName === 'local' && changes[SETTINGS_KEY]) {
      callback(
        normalizeSettings(changes[SETTINGS_KEY].newValue as StoredSettings | undefined),
        normalizeSettings(changes[SETTINGS_KEY].oldValue as StoredSettings | undefined)
      );
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ============================================================
// QA Dictionary
// ============================================================

/** Gets all dictionary entries, newest first. */
export async function readDictionary(): Promise<DictionaryEntry[]> {
  const result = await chrome.storage.local.get(DICTIONARY_KEY);
  const entries = (result[DICTIONARY_KEY] as DictionaryEntry[] | undefined) || [];
  return sortEntries(entries);
}

export function onDictionaryChanged(callback: () => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName === 'local' && changes[DICTIONARY_KEY]) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function sortEntries(entries: DictionaryEntry[]): DictionaryEntry[] {
  return [...entries].sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Inserts a word, or replaces the entry with the same word (case-insensitive) keeping its id.
 * The saved entry moves to the top.
 */
export function upsertEntry(
  entries: DictionaryEntry[],
  entry: Omit<DictionaryEntry, 'id' | 'addedAt'>,
  newId: string,
  now: number
): { entries: DictionaryEntry[]; saved: DictionaryEntry } {
  const word = entry.word.trim().toLowerCase();
  const existing = entries.find((w) => w.word.trim().toLowerCase() === word);
  const saved: DictionaryEntry = { ...entry, id: existing ? existing.id : newId, addedAt: now };
  return { entries: [saved, ...entries.filter((w) => w !== existing)], saved };
}

/** Filters entries by word or translation (partial, case-insensitive). */
export function searchEntries(entries: DictionaryEntry[], query: string): DictionaryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.word.toLowerCase().includes(q) || e.translation.toLowerCase().includes(q));
}

/**
 * Exports dictionary to CSV. Cells starting with = + - @ are prefixed with an apostrophe so a
 * spreadsheet does not evaluate them as formulas.
 */
export function exportDictionaryToCsv(entries: DictionaryEntry[]): string {
  const header = 'Word,Translation,QA Meaning,Example,Added At\n';
  const cell = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows = entries.map((e) => {
    const date = new Date(e.addedAt).toISOString().split('T')[0];
    return [cell(e.word), cell(e.translation), cell(e.qaMeaning), cell(e.example), date].join(',');
  });
  return header + rows.join('\n');
}
