/**
 * LiveTranslator — translates the subtitle on screen and renders the result.
 *
 * Order of attempts: content memory cache → in-flight prefetch of the same text → small
 * high-priority batch around the playback position (keeps sentence context) → single request
 * with neighbouring context. Only the latest request may render: a newer subtitle, or
 * `invalidate()`, makes the older ones stale. Cancelled requests render nothing.
 *
 * DOM-free (rendering and timeline access are injected), so the pipeline is unit-tested.
 */
import type { BatchTranslationRequest, LanguageCode, SubtitleState } from '../shared/types';
import type { TranslationClient } from '../translation/TranslationClient';
import { MessageError } from '../shared/messages';
import { previousTranslationsFor } from './VTTPreFetcher';
import { logWarn } from '../shared/utils';

export interface LiveTranslatorDeps {
  client: Pick<TranslationClient, 'getCached' | 'getPending' | 'translateBatch' | 'translate'>;
  render(state: SubtitleState): void;
  /** High-priority batch around the playback position (VTT timeline), or null in DOM-only mode */
  batchAround(source: LanguageCode, target: LanguageCode): BatchTranslationRequest | null;
  /** Text of the next unit, sent as context with single requests */
  upcomingText(): string | undefined;
  /** Called after a translation that was not cached yet was rendered */
  onRendered?(): void;
}

export class LiveTranslator {
  private requestId = 0;
  /** Last translated text, sent as context with the next single request */
  private previousText = '';

  constructor(private readonly deps: LiveTranslatorDeps) {}

  /** Makes in-flight requests stale (subtitle hidden, lesson changed, extension disabled). */
  invalidate(): void {
    this.requestId++;
  }

  /** Drops the "previous line" context (after a seek or lesson change). */
  resetContext(): void {
    this.previousText = '';
  }

  /**
   * Shows `displayText` with the translation of `textToTranslate` (they differ only when the
   * text sent for translation was cleaned up).
   */
  async show(displayText: string, textToTranslate: string, source: LanguageCode, target: LanguageCode): Promise<void> {
    const id = ++this.requestId;
    const isCurrent = () => id === this.requestId;
    const { client, render } = this.deps;

    const cached = client.getCached(textToTranslate, source, target);
    if (cached) {
      render({ originalText: displayText, translatedText: cached.translatedText, status: 'done', fallback: cached.fallback });
      this.previousText = textToTranslate;
      return;
    }

    // Cache miss: update immediately so the previous subtitle does not linger on screen
    render({ originalText: displayText, translatedText: '', status: 'translating' });

    try {
      let translatedText = '';
      let fallback: boolean | undefined;
      const fromMemCache = () => {
        const hit = client.getCached(textToTranslate, source, target);
        fallback = hit?.fallback;
        return hit?.translatedText || '';
      };

      // 1. A prefetch batch already translating this text
      const pending = client.getPending(textToTranslate, source, target);
      if (pending && (await pending)) translatedText = fromMemCache();

      // 2. High-priority batch around the playback position
      if (!translatedText && isCurrent()) {
        const batch = this.deps.batchAround(source, target);
        if (batch) {
          batch.previousTranslations = previousTranslationsFor(batch.previousContext, source, target, client);
          try {
            await client.translateBatch(batch);
            translatedText = fromMemCache();
          } catch (err) {
            if (!(err instanceof MessageError && err.cancelled)) {
              logWarn('Batch translation failed, falling back to single translation:', err);
            }
          }
        }
      }

      // 3. Single request with neighbouring context
      if (!translatedText && isCurrent()) {
        const result = await client.translate(textToTranslate, source, target, {
          previous: this.previousText || undefined,
          upcoming: this.deps.upcomingText(),
        });
        translatedText = result.translatedText;
        fallback = result.fallback;
      }

      if (!isCurrent()) return;
      this.previousText = textToTranslate;
      render({ originalText: displayText, translatedText, status: 'done', fallback });
      this.deps.onRendered?.();
    } catch (err) {
      if (!isCurrent() || (err instanceof MessageError && err.cancelled)) return;
      render({
        originalText: displayText,
        translatedText: '',
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Translation unavailable',
      });
    }
  }
}
