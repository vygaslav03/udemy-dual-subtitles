/**
 * Translation Provider interface.
 *
 * All translation providers must implement this interface.
 * This allows swapping providers without changing the core logic.
 */
import type { LanguageCode, TranslationProviderType, BatchTranslationRequest, TranslatedSegment } from '../shared/types';

export interface TranslationProvider {
  /** Human-readable provider name */
  readonly name: string;

  /** Provider type identifier */
  readonly type: TranslationProviderType;

  /** Whether this provider requires an API key */
  readonly requiresApiKey: boolean;

  /**
   * LLM providers follow the prompt's terminology rules themselves;
   * machine-translation output additionally goes through TerminologyProcessor.
   */
  readonly isLlm: boolean;

  /**
   * Identifies translations produced by this provider configuration (provider + model),
   * so switching provider/model never serves another provider's cached output.
   */
  readonly cacheNamespace: string;

  /**
   * Translates text from source to target language with optional context.
   * @throws ProviderError if translation fails
   */
  translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<string>;

  /**
   * Translates a semantic batch of subtitle segments with surrounding context.
   * Segments the provider could not translate come back with an empty `text`.
   */
  translateBatch?(request: BatchTranslationRequest): Promise<TranslatedSegment[]>;

  /**
   * Sets configuration for this provider (API key, endpoint, model).
   */
  configure(config: ProviderConfig): void;
}

export interface ProviderConfig {
  apiKey?: string;
  endpoint?: string;
  model?: string;
}

export type ProviderErrorKind =
  | 'rate-limit'   // 429 / quota — retry later
  | 'auth'         // invalid or missing key
  | 'not-found'    // wrong model or endpoint
  | 'timeout'
  | 'network'
  | 'server'       // 5xx
  | 'bad-response' // unparsable / empty / truncated output
  | 'cancelled';   // dropped by the queue (seek, lesson change, overflow)

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
