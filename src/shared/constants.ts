import type { ExtensionSettings, LanguageOption } from './types';

/** All supported languages */
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
];

/** Default settings for fresh install */
export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  sourceLanguage: 'en',
  targetLanguage: 'ru',

  translationProvider: 'google-free',
  providerConfigs: {},

  originalFontSize: 18,
  translationFontSize: 16,
  originalColor: '#FFFFFF',
  translationColor: '#CCCCCC',
  backgroundOpacity: 75,
  subtitlePosition: 'bottom',
  customVerticalOffset: 60,
  subtitleMaxWidth: 80,

  maxConcurrentTranslations: 2,
  preFetchNext: true,
  cacheTTLDays: 30,
  maxCacheEntries: 10000,

  qaLearningMode: false,
  smartSentenceMode: true,
  restorePunctuation: true,
};

/** Default Gemini model (the provider falls back to GEMINI_FALLBACK_MODEL on 404) */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
export const GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * IndexedDB database configuration.
 * v2: cache keys are namespaced by provider/model/prompt version; the upgrade drops
 * v1 entries, some of which stored the untranslated original as a "translation".
 */
export const DB_NAME = 'udemy-dual-subtitles';
export const DB_VERSION = 2;
export const CACHE_STORE_NAME = 'translations';

/** Bump when prompts change so LLM translations made with old prompts are not reused */
export const PROMPT_VERSION = 2;

/** chrome.storage.local key written by the background when the cache is cleared */
export const CACHE_EPOCH_KEY = 'uds_cache_epoch';

/** Timing constants — optimized for real-time video subtitles */
export const SUBTITLE_DEBOUNCE_MS = 15;
export const OBSERVER_DEBOUNCE_MS = 20;
/** Machine translation APIs (Google, DeepL, …) */
export const TRANSLATION_TIMEOUT_MS = 4000;
/** LLM single-text request */
export const LLM_TIMEOUT_MS = 8000;
/** LLM batch request */
export const LLM_BATCH_TIMEOUT_MS = 15000;
/** Delay before a "…" loading indicator appears, so fast translations don't flicker */
export const LOADING_INDICATOR_DELAY_MS = 400;
/** Delay before re-detecting after a lesson change, so the new player can mount */
export const REINIT_DELAY_MS = 1500;
/** Minimum interval between VTT discovery attempts */
export const VTT_LOAD_RETRY_MS = 3000;

/** Circuit breaker cooldowns */
export const BREAKER_RATE_LIMIT_MS = 60_000;
export const BREAKER_CONFIG_ERROR_MS = 300_000;

/** Content-script memory cache TTLs */
export const MEM_CACHE_TTL_MS = 60 * 60 * 1000;
export const FALLBACK_MEM_CACHE_TTL_MS = 2 * 60 * 1000;

/** Sentence units: cues are merged while all limits hold */
export const UNIT_MAX_GAP_SEC = 1.0;
export const UNIT_MAX_DURATION_SEC = 7.0;
export const UNIT_MAX_CHARS = 110;
/** A cue ending in a comma closes the unit once it is at least this long */
export const UNIT_CLAUSE_SPLIT_CHARS = 60;

/** Pre-fetching */
export const PREFETCH_WINDOW_SEC = 90;
export const PREFETCH_MAX_BATCHES = 2;
export const PREFETCH_BATCH_MAX_SEGMENTS = 15;
export const PREFETCH_BATCH_MIN_SEC = 30;
export const PREFETCH_BATCH_MAX_SEC = 75;

/** Max parallel requests a non-batch provider may issue for one batch */
export const PER_SEGMENT_CONCURRENCY = 4;

/** CSS class prefix to avoid collisions */
export const CSS_PREFIX = 'uds';

/** Google Translate free endpoint */
export const GOOGLE_FREE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

/** Persistent Udemy caption containers (survive cue changes) */
export const CAPTION_CONTAINER_SELECTOR =
  '[data-purpose="captions-display"], div[class*="captions-display"], span[class*="captions-display"], .vjs-text-track-display';

/** Subtitle detection selectors — ordered by reliability */
export const SUBTITLE_SELECTORS = [
  // Persistent display containers (survive subtitle changes)
  '[data-purpose="captions-display"]',
  'div[class*="captions-display"]',
  'span[class*="captions-display"]',
  '.vjs-text-track-display',
  // Individual cue elements
  '[data-purpose="captions-cue-text"]',
  'div[class*="captions-cue-text"]',
  'span[class*="captions-cue-text"]',
  'div[class*="caption-cue-text"]',
  'span[class*="caption-cue-text"]',
  '.vjs-text-track-cue',
] as const;

/** Video player container selectors */
export const PLAYER_SELECTORS = [
  '[data-purpose="video-player"]',
  '[class*="video-player"]',
  '[class*="video-viewer"]',
  'video',
] as const;
