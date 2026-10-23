// ============================================================
// Shared type definitions for Udemy Dual Subtitles extension
// ============================================================

/** Supported languages */
export type LanguageCode = 'en' | 'ru' | 'uk' | 'pl' | 'de' | 'es' | 'fr';

export interface LanguageOption {
  code: LanguageCode;
  name: string;
  nativeName: string;
  flag: string;
}

/** Translation provider identifiers */
export type TranslationProviderType =
  | 'google-free'
  | 'google-cloud'
  | 'deepl'
  | 'openai'
  | 'gemini'
  | 'libretranslate';

/** Per-provider credentials and overrides (each provider keeps its own). */
export interface ProviderSettings {
  apiKey: string;
  apiEndpoint: string;
  apiModel: string;
}

/** Subtitle position presets */
export type SubtitlePosition = 'bottom' | 'middle' | 'custom';

/** Extension settings stored in chrome.storage.local */
export interface ExtensionSettings {
  // Core
  enabled: boolean;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;

  // Translation provider
  translationProvider: TranslationProviderType;
  providerConfigs: Partial<Record<TranslationProviderType, ProviderSettings>>;

  // Subtitle appearance
  originalFontSize: number;    // px, 12–48
  translationFontSize: number; // px, 12–48
  originalColor: string;       // hex
  translationColor: string;    // hex
  backgroundOpacity: number;   // 0–100
  subtitlePosition: SubtitlePosition;
  customVerticalOffset: number; // px from bottom
  subtitleMaxWidth: number;     // percentage 50–90

  // Translation behavior
  /** Retry failed requests with Google Translate (free). Off by default: text then leaves the chosen provider. */
  fallbackToGoogle: boolean;
  maxConcurrentTranslations: number; // 1–5
  preFetchNext: boolean;
  cacheTTLDays: number;        // days
  maxCacheEntries: number;

  // QA Learning Mode
  qaLearningMode: boolean;

  /** Merge VTT cues into sentence units before translating and displaying */
  smartSentenceMode: boolean;
  /** DOM-only mode: light English punctuation clean-up before translation */
  restorePunctuation: boolean;

  // Keyboard shortcuts are managed by Chrome commands API
}

/**
 * Settings without credentials. This is all a content script ever receives: API keys stay
 * in the service worker and extension pages and never reach the Udemy page process.
 */
export type PublicSettings = Omit<ExtensionSettings, 'providerConfigs'>;

export interface CacheStats {
  count: number;
  oldestTimestamp: number | null;
}

/** A cached translation entry in IndexedDB */
export interface CachedTranslation {
  key: string;                 // `${namespace}|${source}:${target}:${text}`
  originalText: string;
  translatedText: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  provider: TranslationProviderType;
  timestamp: number;           // Date.now()
}

/** QA Dictionary word entry */
export interface DictionaryEntry {
  id: string;
  word: string;
  translation: string;
  qaMeaning: string;
  example: string;
  addedAt: number;             // Date.now()
  sourceUrl?: string;          // Udemy lesson URL where it was saved
}

/** Translation result returned by providers */
export interface TranslationResult {
  originalText: string;
  translatedText: string;
  provider: TranslationProviderType;
  fromCache: boolean;
  /** True when the configured provider failed and a fallback provider answered */
  fallback?: boolean;
}

/** Status of a translation request */
export type TranslationStatus = 'idle' | 'translating' | 'done' | 'error';

/** State of the subtitle renderer */
export interface SubtitleState {
  originalText: string;
  translatedText: string;
  status: TranslationStatus;
  errorMessage?: string;
  /** The translation came from the Google fallback, not the configured provider */
  fallback?: boolean;
}

/** Subtitle segment for batch translation */
export interface SubtitleSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/**
 * Translated segment returned by batch translation.
 * An empty `text` means "not translated" — callers must never substitute the original.
 */
export interface TranslatedSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** Priority level for translation queue items */
export type BatchPriority = 'high' | 'normal' | 'low';

/** Request for batch translation */
export interface BatchTranslationRequest {
  segments: SubtitleSegment[];
  previousContext?: string[];
  /** Already-produced translations of the preceding segments (for consistent terminology/style) */
  previousTranslations?: string[];
  nextContext?: string[];
  source: LanguageCode;
  target: LanguageCode;
  priority?: BatchPriority;
}

/** Result of batch translation */
export interface BatchTranslationResponse {
  segments: TranslatedSegment[];
  provider: TranslationProviderType;
  fromCache?: boolean;
  fallback?: boolean;
}

export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Machine-readable error kind, e.g. 'cancelled' */
  errorCode?: string;
}
