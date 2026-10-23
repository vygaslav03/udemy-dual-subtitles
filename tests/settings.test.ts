/**
 * Settings schema (validation, migrations, views), the background SettingsStore (single writer),
 * dictionary helpers, the typed message helper and language-aware prompts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SETTINGS_SCHEMA_VERSION,
  migrateSettings,
  normalizeSettings,
  sanitizeSettings,
  toPublicSettings,
  translationConfigChanged,
} from '../src/shared/settings';
import { DEFAULT_SETTINGS, GEMINI_DEFAULT_MODEL } from '../src/shared/constants';
import { SettingsStore } from '../src/background/SettingsStore';
import { DICTIONARY_KEY, SETTINGS_KEY, exportDictionaryToCsv, searchEntries, upsertEntry } from '../src/shared/storage';
import { MessageError, sendToBackground } from '../src/shared/messages';
import { getBatchSubtitleSystemPrompt, getSubtitleSystemPrompt } from '../src/translation/promptTemplates';
import type { DictionaryEntry } from '../src/shared/types';

/** chrome.storage.local stand-in; reads and writes yield, so unserialized read-modify-write would race. */
function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const area = {
    data,
    get: vi.fn(async (key: string) => {
      await tick();
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await tick();
      Object.assign(data, structuredClone(items));
    }),
  };
  return area as typeof area & chrome.storage.StorageArea;
}

describe('sanitizeSettings', () => {
  it('fills defaults for missing values and drops unknown keys', () => {
    const s = sanitizeSettings({ enabled: false, bogus: 1 } as never);
    expect(s.enabled).toBe(false);
    expect(s.targetLanguage).toBe(DEFAULT_SETTINGS.targetLanguage);
    expect(s).not.toHaveProperty('bogus');
  });

  it('never stores NaN: invalid numbers fall back to defaults, out-of-range ones are clamped', () => {
    const s = sanitizeSettings({ cacheTTLDays: NaN, maxCacheEntries: 5, originalFontSize: 99.6, backgroundOpacity: '40' } as never);
    expect(s.cacheTTLDays).toBe(DEFAULT_SETTINGS.cacheTTLDays);
    expect(s.maxCacheEntries).toBe(100);
    expect(s.originalFontSize).toBe(48);
    expect(s.backgroundOpacity).toBe(40);
  });

  it('rejects unknown enum values, malformed colors and non-boolean flags', () => {
    const s = sanitizeSettings({
      translationProvider: 'evil',
      targetLanguage: 'xx',
      subtitlePosition: 'top',
      originalColor: 'red; background:url(x)',
      translationColor: '#00ff00',
      preFetchNext: 'yes',
    } as never);
    expect(s.translationProvider).toBe(DEFAULT_SETTINGS.translationProvider);
    expect(s.targetLanguage).toBe(DEFAULT_SETTINGS.targetLanguage);
    expect(s.subtitlePosition).toBe(DEFAULT_SETTINGS.subtitlePosition);
    expect(s.originalColor).toBe(DEFAULT_SETTINGS.originalColor);
    expect(s.translationColor).toBe('#00FF00');
    expect(s.preFetchNext).toBe(DEFAULT_SETTINGS.preFetchNext);
  });

  it('keeps only string credentials of known providers', () => {
    const s = sanitizeSettings({
      providerConfigs: { openai: { apiKey: ' sk-1 ', apiModel: 5 }, nope: { apiKey: 'x' } },
    } as never);
    expect(s.providerConfigs).toEqual({ openai: { apiKey: 'sk-1', apiEndpoint: '', apiModel: '' } });
  });

  it('has the Google fallback off by default', () => {
    expect(sanitizeSettings(undefined).fallbackToGoogle).toBe(false);
  });
});

describe('migrateSettings', () => {
  it('marks fresh and v1 settings for persisting and stamps the current version', () => {
    expect(migrateSettings(undefined)).toMatchObject({ changed: true, settings: { schemaVersion: SETTINGS_SCHEMA_VERSION } });
    expect(migrateSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION }).changed).toBe(false);
  });

  it('replaces a retired Gemini model once; a model chosen later is kept', () => {
    const v1 = { providerConfigs: { gemini: { apiKey: 'k', apiEndpoint: '', apiModel: 'gemini-1.5-flash-latest' } } };
    expect(normalizeSettings(v1).providerConfigs.gemini!.apiModel).toBe(GEMINI_DEFAULT_MODEL);

    const v2 = { schemaVersion: SETTINGS_SCHEMA_VERSION, providerConfigs: { gemini: { apiKey: 'k', apiEndpoint: '', apiModel: 'gemini-2.0-flash' } } };
    expect(normalizeSettings(v2).providerConfigs.gemini!.apiModel).toBe('gemini-2.0-flash');
  });
});

describe('settings views', () => {
  it('toPublicSettings strips credentials', () => {
    const s = sanitizeSettings({ providerConfigs: { gemini: { apiKey: 'secret', apiEndpoint: '', apiModel: '' } } });
    const pub = toPublicSettings(s);
    expect(pub).not.toHaveProperty('providerConfigs');
    expect(JSON.stringify(pub)).not.toContain('secret');
  });

  it('translationConfigChanged reacts to the active provider config, not to other providers', () => {
    const base = sanitizeSettings({ translationProvider: 'gemini' });
    const withKey = (provider: 'gemini' | 'openai', apiKey: string) =>
      sanitizeSettings({ ...base, providerConfigs: { ...base.providerConfigs, [provider]: { apiKey, apiEndpoint: '', apiModel: '' } } });

    expect(translationConfigChanged(base, withKey('gemini', 'k'))).toBe(true);
    expect(translationConfigChanged(base, withKey('openai', 'k'))).toBe(false);
    expect(translationConfigChanged(base, { ...base, targetLanguage: 'de' })).toBe(true);
    expect(translationConfigChanged(base, { ...base, fallbackToGoogle: true })).toBe(true);
    expect(translationConfigChanged(base, { ...base, originalFontSize: 30 })).toBe(false);
  });
});

describe('SettingsStore', () => {
  it('applies concurrent updates from different contexts without losing any', async () => {
    const storage = memoryStorage();
    const store = new SettingsStore(storage);

    await Promise.all([
      store.update({ originalFontSize: 30 }),
      store.update({ targetLanguage: 'de' }),
      store.modify((s) => ({ translationFontSize: s.translationFontSize + 2 })),
      store.updateProviderConfig('openai', { apiKey: 'sk-1' }),
      store.update({ enabled: false }),
    ]);

    const saved = await store.load();
    expect(saved).toMatchObject({ originalFontSize: 30, targetLanguage: 'de', translationFontSize: 18, enabled: false });
    expect(saved.providerConfigs.openai?.apiKey).toBe('sk-1');
  });

  it('persists migrations of old stored settings', async () => {
    const storage = memoryStorage({ [SETTINGS_KEY]: { translationProvider: 'chrome-builtin', apiKey: 'k' } });
    const settings = await new SettingsStore(storage).load();

    expect(settings.translationProvider).toBe('google-free');
    expect(storage.data[SETTINGS_KEY]).toMatchObject({ schemaVersion: SETTINGS_SCHEMA_VERSION, translationProvider: 'google-free' });
    expect(storage.data[SETTINGS_KEY]).not.toHaveProperty('apiKey');
  });

  it('cannot change credentials through a settings update', async () => {
    const store = new SettingsStore(memoryStorage());
    await store.updateProviderConfig('gemini', { apiKey: 'mine' });
    await store.update({ providerConfigs: { gemini: { apiKey: 'injected' } } } as never);
    expect((await store.load()).providerConfigs.gemini?.apiKey).toBe('mine');
  });

  it('clamps invalid values from the options form', async () => {
    const store = new SettingsStore(memoryStorage());
    const saved = await store.update({ cacheTTLDays: NaN, maxConcurrentTranslations: 50 });
    expect(saved.cacheTTLDays).toBe(DEFAULT_SETTINGS.cacheTTLDays);
    expect(saved.maxConcurrentTranslations).toBe(5);
  });

  it('saves concurrent dictionary words without losing any and updates duplicates in place', async () => {
    const storage = memoryStorage();
    const store = new SettingsStore(storage);
    const word = (w: string, translation = 'перевод') => ({ word: w, translation, qaMeaning: '', example: '' });

    await Promise.all([store.saveWord(word('bug')), store.saveWord(word('mock')), store.saveWord(word('stub'))]);
    const first = (storage.data[DICTIONARY_KEY] as DictionaryEntry[]).find((e) => e.word === 'bug')!;
    await store.saveWord(word('Bug', 'баг'));

    const entries = storage.data[DICTIONARY_KEY] as DictionaryEntry[];
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ id: first.id, word: 'Bug', translation: 'баг' });

    await store.deleteWord(first.id);
    expect((storage.data[DICTIONARY_KEY] as DictionaryEntry[]).map((e) => e.word).sort()).toEqual(['mock', 'stub']);
  });
});

describe('dictionary helpers', () => {
  const entry = (word: string, translation: string): DictionaryEntry => ({
    id: word, word, translation, qaMeaning: '', example: '', addedAt: 0,
  });

  it('upsertEntry moves the saved word to the top', () => {
    const { entries } = upsertEntry([entry('a', '1'), entry('b', '2')], { word: 'B', translation: '3', qaMeaning: '', example: '' }, 'new', 5);
    expect(entries.map((e) => [e.id, e.translation])).toEqual([['b', '3'], ['a', '1']]);
  });

  it('searchEntries matches word or translation', () => {
    const all = [entry('assertion', 'проверка'), entry('mock', 'заглушка')];
    expect(searchEntries(all, 'ЗАГЛ').map((e) => e.word)).toEqual(['mock']);
    expect(searchEntries(all, '  ')).toBe(all);
  });

  it('CSV export neutralizes spreadsheet formulas', () => {
    const csv = exportDictionaryToCsv([entry('=HYPERLINK("x")', '@cmd')]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"'@cmd"`);
  });
});

describe('sendToBackground', () => {
  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  const stubRuntime = (response: unknown, lastError?: { message: string }) => {
    (globalThis as any).chrome = {
      runtime: {
        lastError,
        sendMessage: vi.fn((_message: unknown, callback: (r: unknown) => void) => callback(response)),
      },
    };
  };

  it('resolves with the data of a successful response', async () => {
    stubRuntime({ success: true, data: { count: 3, oldestTimestamp: null } });
    await expect(sendToBackground('GET_CACHE_STATS')).resolves.toEqual({ count: 3, oldestTimestamp: null });
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'GET_CACHE_STATS', payload: undefined },
      expect.any(Function)
    );
  });

  it('rejects with the error code of a failed response', async () => {
    stubRuntime({ success: false, error: 'Translation cancelled', errorCode: 'cancelled' });
    const err = await sendToBackground('CANCEL_PREFETCH').catch((e) => e);
    expect(err).toBeInstanceOf(MessageError);
    expect(err.cancelled).toBe(true);
  });

  it('rejects when the background is unreachable', async () => {
    stubRuntime(undefined, { message: 'Could not establish connection' });
    await expect(sendToBackground('GET_SETTINGS')).rejects.toThrow('Could not establish connection');
  });
});

describe('language-aware prompts', () => {
  it('gives Russian-specific guidance only to Russian', () => {
    const ru = getBatchSubtitleSystemPrompt('en', 'ru');
    expect(ru).toContain('"вы"');
    expect(ru).toContain('тест-кейс');
    expect(ru).toContain('Сначала нужно настроить сервер.');

    for (const prompt of [getBatchSubtitleSystemPrompt('en', 'de'), getSubtitleSystemPrompt('en', 'fr')]) {
      expect(prompt).not.toMatch(/[а-яё]/i);
    }
    expect(getBatchSubtitleSystemPrompt('en', 'de')).toContain('into German');
  });

  it('has its own guidance for Ukrainian', () => {
    const uk = getSubtitleSystemPrompt('en', 'uk');
    expect(uk).toContain('гілка');
    expect(uk).not.toContain('ветка');
  });
});
