/**
 * SettingsStore — the only writer of settings and the QA dictionary (runs in the service worker).
 *
 * chrome.storage has no transactions: two contexts doing read → merge → write at the same time
 * lose one of the updates (e.g. a shortcut resizing subtitles while the options page saves).
 * All writes are therefore requested from the background and applied here one after another.
 */
import type { DictionaryEntry, ExtensionSettings, ProviderSettings, PublicSettings, TranslationProviderType } from '../shared/types';
import {
  SETTINGS_SCHEMA_VERSION,
  getProviderConfig,
  migrateSettings,
  sanitizeSettings,
  type StoredSettings,
} from '../shared/settings';
import { DICTIONARY_KEY, SETTINGS_KEY, sortEntries, upsertEntry } from '../shared/storage';
import { generateId } from '../shared/utils';

export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: chrome.storage.StorageArea = chrome.storage.local) {}

  /** Runs operations strictly one after another (a failed one does not block the next). */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<ExtensionSettings> {
    const result = await this.storage.get(SETTINGS_KEY);
    const { settings, changed } = migrateSettings(result[SETTINGS_KEY] as StoredSettings | undefined);
    const valid = sanitizeSettings(settings);
    if (changed) await this.write(valid); // persist the migration so it runs once
    return valid;
  }

  private async write(settings: ExtensionSettings): Promise<void> {
    await this.storage.set({ [SETTINGS_KEY]: { ...settings, schemaVersion: SETTINGS_SCHEMA_VERSION } });
  }

  /** Loads settings, migrating and persisting older stored versions. */
  load(): Promise<ExtensionSettings> {
    return this.serialize(() => this.read());
  }

  /** Applies a partial update; invalid values are replaced by defaults or clamped. */
  update(update: Partial<PublicSettings>): Promise<ExtensionSettings> {
    return this.serialize(async () => {
      const current = await this.read();
      const next = sanitizeSettings({ ...current, ...update, providerConfigs: current.providerConfigs });
      await this.write(next);
      return next;
    });
  }

  /** Updates a function of the current settings atomically (e.g. "font size + 2"). */
  modify(change: (current: ExtensionSettings) => Partial<PublicSettings>): Promise<ExtensionSettings> {
    return this.serialize(async () => {
      const current = await this.read();
      const next = sanitizeSettings({ ...current, ...change(current), providerConfigs: current.providerConfigs });
      await this.write(next);
      return next;
    });
  }

  /** Updates the credentials/overrides of one provider. */
  updateProviderConfig(provider: TranslationProviderType, config: Partial<ProviderSettings>): Promise<ExtensionSettings> {
    return this.serialize(async () => {
      const current = await this.read();
      const next = sanitizeSettings({
        ...current,
        providerConfigs: { ...current.providerConfigs, [provider]: { ...getProviderConfig(current, provider), ...config } },
      });
      await this.write(next);
      return next;
    });
  }

  saveWord(entry: Omit<DictionaryEntry, 'id' | 'addedAt'>): Promise<DictionaryEntry> {
    return this.serialize(async () => {
      const { entries, saved } = upsertEntry(await this.readDictionary(), entry, generateId(), Date.now());
      await this.storage.set({ [DICTIONARY_KEY]: entries });
      return saved;
    });
  }

  deleteWord(id: string): Promise<void> {
    return this.serialize(async () => {
      const entries = (await this.readDictionary()).filter((e) => e.id !== id);
      await this.storage.set({ [DICTIONARY_KEY]: entries });
    });
  }

  private async readDictionary(): Promise<DictionaryEntry[]> {
    const result = await this.storage.get(DICTIONARY_KEY);
    return sortEntries((result[DICTIONARY_KEY] as DictionaryEntry[] | undefined) || []);
  }
}
