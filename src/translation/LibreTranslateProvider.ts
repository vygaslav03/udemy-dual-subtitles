/**
 * LibreTranslate Provider.
 *
 * Uses the LibreTranslate API — an open-source, self-hostable translation engine.
 * Can be used with:
 * - A self-hosted instance (recommended for unlimited use)
 * - Public instances (may have rate limits)
 *
 * API docs: https://libretranslate.com/docs
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType } from '../shared/types';
import { TRANSLATION_TIMEOUT_MS } from '../shared/constants';
import { errorFromResponse, fetchWithTimeout, resolveEndpoint } from './providerUtils';

const DEFAULT_ENDPOINT = 'https://libretranslate.com/translate';

export class LibreTranslateProvider implements TranslationProvider {
  readonly name = 'LibreTranslate';
  readonly type: TranslationProviderType = 'libretranslate';
  readonly requiresApiKey = false; // Optional — depends on instance
  readonly isLlm = false;
  readonly cacheNamespace = 'libretranslate';

  private apiKey = '';
  private endpoint = DEFAULT_ENDPOINT;

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    const body: Record<string, string> = {
      q: text,
      source: source,
      target: target,
      format: 'text',
    };

    if (this.apiKey) {
      body.api_key = this.apiKey;
    }

    const response = await fetchWithTimeout(
      this.endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      TRANSLATION_TIMEOUT_MS,
      this.name
    );

    if (!response.ok) {
      throw await errorFromResponse(response, this.name);
    }

    const data = await response.json().catch(() => null);
    if (typeof data?.translatedText !== 'string' || !data.translatedText) {
      throw new ProviderError('bad-response', 'LibreTranslate: empty translation response');
    }

    return data.translatedText;
  }

  configure(config: ProviderConfig): void {
    if (config.apiKey !== undefined) this.apiKey = config.apiKey.trim();
    this.endpoint = resolveEndpoint(config.endpoint, DEFAULT_ENDPOINT, this.name);
  }
}
