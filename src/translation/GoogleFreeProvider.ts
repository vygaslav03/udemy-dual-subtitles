/**
 * Google Translate (free/unofficial) provider.
 *
 * Uses the undocumented translate.googleapis.com endpoint.
 * This is the same endpoint used by the Google Translate Chrome extension.
 * Suitable for personal use only.
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType, BatchTranslationRequest, TranslatedSegment } from '../shared/types';
import { GOOGLE_FREE_TRANSLATE_URL, PER_SEGMENT_CONCURRENCY, TRANSLATION_TIMEOUT_MS } from '../shared/constants';
import { errorFromResponse, fetchWithTimeout, mapWithConcurrency } from './providerUtils';

export class GoogleFreeProvider implements TranslationProvider {
  readonly name = 'Google Translate (Free)';
  readonly type: TranslationProviderType = 'google-free';
  readonly requiresApiKey = false;
  readonly isLlm = false;
  readonly cacheNamespace = 'google-free';

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    const params = new URLSearchParams({
      client: 'dict-chrome-ex',
      sl: source,
      tl: target,
      dt: 't',
      q: text,
    });

    const response = await fetchWithTimeout(
      `${GOOGLE_FREE_TRANSLATE_URL}?${params}`,
      { method: 'GET' },
      TRANSLATION_TIMEOUT_MS,
      this.name
    );

    if (!response.ok) {
      throw await errorFromResponse(response, this.name);
    }

    const data = await response.json().catch(() => null);

    // Response format: [[["translated text","source text",null,null,10]],null,"en"]
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new ProviderError('bad-response', 'Unexpected response format from Google Translate');
    }

    // Concatenate all translated segments
    const translated = data[0]
      .filter((segment: unknown) => Array.isArray(segment) && typeof segment[0] === 'string')
      .map((segment: unknown[]) => segment[0] as string)
      .join('');

    if (!translated.trim()) {
      throw new ProviderError('bad-response', 'Empty translation result');
    }

    return translated;
  }

  /**
   * Translates segments one by one (the endpoint has no batch mode), with limited parallelism.
   * A failed segment comes back with an empty text; if every segment fails, the first error is thrown.
   */
  async translateBatch(request: BatchTranslationRequest): Promise<TranslatedSegment[]> {
    if (!request.segments || request.segments.length === 0) {
      return [];
    }

    let firstError: unknown = null;
    const results = await mapWithConcurrency(request.segments, PER_SEGMENT_CONCURRENCY, async (seg) => {
      try {
        const text = await this.translate(seg.text, request.source, request.target);
        return { id: seg.id, start: seg.start, end: seg.end, text };
      } catch (err) {
        firstError ??= err;
        return { id: seg.id, start: seg.start, end: seg.end, text: '' };
      }
    });

    if (firstError && results.every((r) => !r.text)) {
      throw firstError;
    }
    return results;
  }

  configure(_config: ProviderConfig): void {
    // No configuration needed for free provider
  }
}
