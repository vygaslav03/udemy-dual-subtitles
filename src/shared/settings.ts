/**
 * Settings schema: defaults, validation and versioned migrations (pure, no chrome.* calls).
 *
 * Stored settings go through `migrateSettings` (once, persisted by the background SettingsStore)
 * and `sanitizeSettings` (on every read and write), so every context sees a valid object even
 * when storage holds an older or hand-edited value.
 */
import type {
  ExtensionSettings,
  LanguageCode,
  ProviderSettings,
  PublicSettings,
  SubtitlePosition,
  TranslationProviderType,
} from './types';
import { DEFAULT_SETTINGS, GEMINI_DEFAULT_MODEL, PROVIDER_LABELS, SUPPORTED_LANGUAGES } from './constants';

/** Bump together with a new step in `MIGRATIONS`. */
export const SETTINGS_SCHEMA_VERSION = 2;

/** Settings as they may appear in storage (any earlier schema version). */
export type StoredSettings = Partial<Record<keyof ExtensionSettings, unknown>> & {
  schemaVersion?: number;
  /** v1: one key/endpoint/model shared by all providers */
  apiKey?: string;
  apiEndpoint?: string;
  apiModel?: string;
};

const EMPTY_PROVIDER_SETTINGS: ProviderSettings = { apiKey: '', apiEndpoint: '', apiModel: '' };

const PROVIDER_TYPES = Object.keys(PROVIDER_LABELS) as TranslationProviderType[];
const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
const POSITIONS: SubtitlePosition[] = ['bottom', 'middle', 'custom'];

/** Inclusive ranges of the numeric settings; values are rounded to integers and clamped. */
export const NUMBER_RANGES = {
  originalFontSize: [12, 48],
  translationFontSize: [12, 48],
  backgroundOpacity: [0, 100],
  customVerticalOffset: [10, 400],
  subtitleMaxWidth: [50, 90],
  maxConcurrentTranslations: [1, 5],
  cacheTTLDays: [1, 365],
  maxCacheEntries: [100, 100_000],
} as const satisfies Partial<Record<keyof ExtensionSettings, readonly [number, number]>>;

type NumberKey = keyof typeof NUMBER_RANGES;
type BooleanKey = {
  [K in keyof ExtensionSettings]: ExtensionSettings[K] extends boolean ? K : never;
}[keyof ExtensionSettings];

const BOOLEAN_KEYS: BooleanKey[] = [
  'enabled',
  'fallbackToGoogle',
  'preFetchNext',
  'qaLearningMode',
  'smartSentenceMode',
  'restorePunctuation',
];

// ============================================================
// Migrations
// ============================================================

/** Gemini models that no longer exist; a stored one is replaced once, when migrating from v1. */
const RETIRED_GEMINI_MODEL = /(^|\/)gemini-(1\.0|1\.5|2\.0)-/;

/** Step `n` upgrades schema n → n + 1. */
const MIGRATIONS: Record<number, (s: StoredSettings) => StoredSettings> = {
  1: (s) => {
    const { apiKey, apiEndpoint, apiModel, ...rest } = s;
    const next: StoredSettings = { ...rest };
    const configs = { ...((rest.providerConfigs as ExtensionSettings['providerConfigs'] | undefined) || {}) };

    // One shared key/endpoint/model → config of the provider that was active.
    const active = (rest.translationProvider as TranslationProviderType | undefined) || DEFAULT_SETTINGS.translationProvider;
    if ((apiKey || apiEndpoint || apiModel) && !configs[active]) {
      configs[active] = { apiKey: apiKey || '', apiEndpoint: apiEndpoint || '', apiModel: apiModel || '' };
    }

    const gemini = configs.gemini;
    if (gemini?.apiModel && RETIRED_GEMINI_MODEL.test(gemini.apiModel)) {
      configs.gemini = { ...gemini, apiModel: GEMINI_DEFAULT_MODEL };
    }
    next.providerConfigs = configs;

    // The on-device provider was removed: the Translator API is not available in the service worker.
    if (next.translationProvider === 'chrome-builtin') next.translationProvider = 'google-free';
    return next;
  },
};

/**
 * Upgrades stored settings to the current schema version.
 * `changed` tells the caller to persist the result, so each migration runs only once.
 */
export function migrateSettings(stored: StoredSettings | undefined): { settings: StoredSettings; changed: boolean } {
  let settings: StoredSettings = { ...(stored || {}) };
  let version = typeof settings.schemaVersion === 'number' ? settings.schemaVersion : 1;
  const changed = version !== SETTINGS_SCHEMA_VERSION;
  while (version < SETTINGS_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step) settings = step(settings);
    version++;
  }
  return { settings: { ...settings, schemaVersion: SETTINGS_SCHEMA_VERSION }, changed };
}

// ============================================================
// Validation
// ============================================================

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function clampSetting(key: NumberKey, value: unknown): number {
  const [min, max] = NUMBER_RANGES[key];
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function sanitizeProviderConfigs(value: unknown): ExtensionSettings['providerConfigs'] {
  const result: ExtensionSettings['providerConfigs'] = {};
  if (!value || typeof value !== 'object') return result;
  for (const type of PROVIDER_TYPES) {
    const raw = (value as Record<string, unknown>)[type];
    if (!raw || typeof raw !== 'object') continue;
    const cfg = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    result[type] = { apiKey: str(cfg.apiKey), apiEndpoint: str(cfg.apiEndpoint), apiModel: str(cfg.apiModel) };
  }
  return result;
}

/**
 * Returns complete, valid settings: unknown keys are dropped, missing or invalid values fall
 * back to defaults and numbers are clamped to their ranges (an empty number field must never
 * store NaN, which would silently disable cache expiry and eviction).
 */
export function sanitizeSettings(raw: StoredSettings | undefined): ExtensionSettings {
  const s = raw || {};
  const d = DEFAULT_SETTINGS;
  const result: ExtensionSettings = {
    ...d,
    sourceLanguage: pick<LanguageCode>(s.sourceLanguage, LANGUAGE_CODES, d.sourceLanguage),
    targetLanguage: pick<LanguageCode>(s.targetLanguage, LANGUAGE_CODES, d.targetLanguage),
    translationProvider: pick(s.translationProvider, PROVIDER_TYPES, d.translationProvider),
    providerConfigs: sanitizeProviderConfigs(s.providerConfigs),
    originalColor: color(s.originalColor, d.originalColor),
    translationColor: color(s.translationColor, d.translationColor),
    subtitlePosition: pick(s.subtitlePosition, POSITIONS, d.subtitlePosition),
  };
  for (const key of Object.keys(NUMBER_RANGES) as NumberKey[]) {
    result[key] = s[key] === undefined ? d[key] : clampSetting(key, s[key]);
  }
  for (const key of BOOLEAN_KEYS) {
    result[key] = typeof s[key] === 'boolean' ? (s[key] as boolean) : d[key];
  }
  return result;
}

/** Migrates (in memory) and validates raw stored settings. */
export function normalizeSettings(stored: StoredSettings | undefined): ExtensionSettings {
  return sanitizeSettings(migrateSettings(stored).settings);
}

// ============================================================
// Views
// ============================================================

/** Returns the credentials/overrides of a provider (the active one by default). */
export function getProviderConfig(
  settings: Pick<ExtensionSettings, 'providerConfigs' | 'translationProvider'>,
  type: TranslationProviderType = settings.translationProvider
): ProviderSettings {
  return { ...EMPTY_PROVIDER_SETTINGS, ...settings.providerConfigs[type] };
}

/** Strips credentials: the only settings view a content script may receive. */
export function toPublicSettings(settings: ExtensionSettings): PublicSettings {
  const { providerConfigs: _credentials, ...rest } = settings;
  return rest;
}

/**
 * True when translations made under `before` must not be shown under `after`
 * (provider, model/endpoint/key of the active provider, languages, fallback policy).
 */
export function translationConfigChanged(before: ExtensionSettings, after: ExtensionSettings): boolean {
  return (
    before.translationProvider !== after.translationProvider ||
    before.sourceLanguage !== after.sourceLanguage ||
    before.targetLanguage !== after.targetLanguage ||
    before.fallbackToGoogle !== after.fallbackToGoogle ||
    JSON.stringify(getProviderConfig(before, after.translationProvider)) !==
      JSON.stringify(getProviderConfig(after))
  );
}
