/**
 * DeepL Translation Provider.
 *
 * Uses the DeepL API (v2) for high-quality translations.
 * Requires an API key (free or pro).
 *
 * Free tier: 500,000 characters/month.
 * API docs: https://developers.deepl.com/docs
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType, BatchTranslationRequest, TranslatedSegment } from '../shared/types';
import { TRANSLATION_TIMEOUT_MS } from '../shared/constants';
import { errorFromResponse, fetchWithTimeout, resolveEndpoint } from './providerUtils';

// DeepL uses uppercase language codes and some are different from ISO 639-1
const DEEPL_LANG_MAP: Record<string, string> = {
  en: 'EN',
  ru: 'RU',
  uk: 'UK',
  pl: 'PL',
  de: 'DE',
  es: 'ES',
  fr: 'FR',
};

const FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const PRO_ENDPOINT = 'https://api.deepl.com/v2/translate';

export class DeepLProvider implements TranslationProvider {
  readonly name = 'DeepL';
  readonly type: TranslationProviderType = 'deepl';
  readonly requiresApiKey = true;
  readonly isLlm = false;
  readonly cacheNamespace = 'deepl';

  private apiKey = '';
  // DeepL free API uses a different endpoint than Pro
  private endpoint = FREE_ENDPOINT;

  /**
   * Sends several texts in one request. `context` is DeepL's own parameter: it influences the
   * translation but is not translated or billed.
   */
  private async request(texts: string[], source: LanguageCode, target: LanguageCode, context?: string): Promise<string[]> {
    if (!this.apiKey) {
      throw new ProviderError('auth', 'DeepL API key is not configured');
    }

    const response = await fetchWithTimeout(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: texts,
          source_lang: DEEPL_LANG_MAP[source] || source.toUpperCase(),
          target_lang: DEEPL_LANG_MAP[target] || target.toUpperCase(),
          ...(context ? { context } : {}),
        }),
      },
      TRANSLATION_TIMEOUT_MS * 2,
      this.name
    );

    if (!response.ok) {
      throw await errorFromResponse(response, this.name);
    }

    const data = await response.json().catch(() => null);
    const translations: Array<{ text?: unknown }> | undefined = data?.translations;
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      throw new ProviderError('bad-response', 'DeepL: unexpected translation response');
    }
    return translations.map((t) => (typeof t.text === 'string' ? t.text : ''));
  }

  async translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<string> {
    const contextText = [context?.previous, context?.upcoming].filter(Boolean).join(' ');
    const [translated] = await this.request([text], source, target, contextText || undefined);
    if (!translated) throw new ProviderError('bad-response', 'DeepL: empty translation');
    return translated;
  }

  async translateBatch(request: BatchTranslationRequest): Promise<TranslatedSegment[]> {
    if (!request.segments || request.segments.length === 0) return [];
    const context = [...(request.previousContext || []), ...(request.nextContext || [])].join(' ');
    const texts = await this.request(
      request.segments.map((s) => s.text),
      request.source,
      request.target,
      context || undefined
    );
    return request.segments.map((seg, i) => ({ id: seg.id, start: seg.start, end: seg.end, text: texts[i] }));
  }

  configure(config: ProviderConfig): void {
    if (config.apiKey !== undefined) this.apiKey = config.apiKey.trim();
    // Free API keys end with ':fx'
    const defaultEndpoint = this.apiKey.endsWith(':fx') ? FREE_ENDPOINT : PRO_ENDPOINT;
    this.endpoint = resolveEndpoint(config.endpoint, defaultEndpoint, this.name);
  }
}
