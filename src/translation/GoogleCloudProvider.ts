/**
 * Google Cloud Translation Provider.
 *
 * Uses the official Google Cloud Translation API v2.
 * Requires a Google Cloud API key with Translation API enabled.
 *
 * Free tier: 500,000 characters/month.
 * API docs: https://cloud.google.com/translate/docs/reference/rest/v2/translations
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType, BatchTranslationRequest, TranslatedSegment } from '../shared/types';
import { TRANSLATION_TIMEOUT_MS } from '../shared/constants';
import { errorFromResponse, fetchWithTimeout, resolveEndpoint } from './providerUtils';

const DEFAULT_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

export class GoogleCloudProvider implements TranslationProvider {
  readonly name = 'Google Cloud Translation';
  readonly type: TranslationProviderType = 'google-cloud';
  readonly requiresApiKey = true;
  readonly isLlm = false;
  readonly cacheNamespace = 'google-cloud';

  private apiKey = '';
  private endpoint = DEFAULT_ENDPOINT;

  private async request(texts: string[], source: LanguageCode, target: LanguageCode): Promise<string[]> {
    if (!this.apiKey) {
      throw new ProviderError('auth', 'Google Cloud API key is not configured');
    }

    const response = await fetchWithTimeout(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header instead of ?key= so the key never appears in URLs/logs
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({ q: texts, source, target, format: 'text' }),
      },
      TRANSLATION_TIMEOUT_MS * 2,
      this.name
    );

    if (!response.ok) {
      throw await errorFromResponse(response, this.name);
    }

    const data = await response.json().catch(() => null);
    const translations: Array<{ translatedText?: unknown }> | undefined = data?.data?.translations;
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      throw new ProviderError('bad-response', 'Google Cloud: unexpected translation response');
    }
    return translations.map((t) => (typeof t.translatedText === 'string' ? t.translatedText : ''));
  }

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    const [translated] = await this.request([text], source, target);
    if (!translated) throw new ProviderError('bad-response', 'Google Cloud: empty translation');
    return translated;
  }

  async translateBatch(request: BatchTranslationRequest): Promise<TranslatedSegment[]> {
    if (!request.segments || request.segments.length === 0) return [];
    const texts = await this.request(request.segments.map((s) => s.text), request.source, request.target);
    return request.segments.map((seg, i) => ({ id: seg.id, start: seg.start, end: seg.end, text: texts[i] }));
  }

  configure(config: ProviderConfig): void {
    if (config.apiKey !== undefined) this.apiKey = config.apiKey.trim();
    this.endpoint = resolveEndpoint(config.endpoint, DEFAULT_ENDPOINT, this.name);
  }
}
