/**
 * TranslationClient — client for content script to request translations.
 *
 * Communicates with Background Service Worker via typed messages (shared/messages.ts).
 * This bypasses Udemy's strict Content Security Policy (connect-src) and CORS.
 * Includes a fast in-memory cache and per-text in-flight tracking in the content script:
 * the display must look translations up synchronously, within a video frame, which a
 * round-trip to the service worker cannot do.
 */
import type {
  LanguageCode,
  TranslationResult,
  BatchTranslationRequest,
  BatchTranslationResponse,
} from '../shared/types';
import { FALLBACK_MEM_CACHE_TTL_MS, MEM_CACHE_TTL_MS } from '../shared/constants';
import { makeCacheKey } from '../shared/utils';
import { MessageError, sendToBackground, type TranslationContext } from '../shared/messages';

const MAX_MEM_ENTRIES = 500;

export class TranslationClient {
  private memCache = new Map<string, { result: TranslationResult; expiresAt: number }>();
  /** Texts currently being translated by a batch: key → promise of the translation ('' if it failed) */
  private pending = new Map<string, Promise<string>>();

  /**
   * Synchronously checks if a translation already exists in the content script memory cache.
   */
  getCached(text: string, source: LanguageCode, target: LanguageCode): TranslationResult | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const cacheKey = makeCacheKey(source, target, trimmed);
    const cached = this.memCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() > cached.expiresAt) {
      this.memCache.delete(cacheKey);
      return null;
    }
    return { ...cached.result, fromCache: true };
  }

  /**
   * Returns the in-flight batch translation of this text, if any.
   */
  getPending(text: string, source: LanguageCode, target: LanguageCode): Promise<string> | null {
    return this.pending.get(makeCacheKey(source, target, text.trim())) || null;
  }

  async translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: TranslationContext
  ): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { originalText: text, translatedText: '', provider: 'google-free', fromCache: false };
    }

    const cached = this.getCached(trimmed, source, target);
    if (cached) return cached;

    const result = await sendToBackground('TRANSLATE_TEXT', { text: trimmed, source, target, context });
    if (!result?.translatedText) {
      throw new MessageError('Empty translation');
    }
    this.setMemCache(makeCacheKey(source, target, trimmed), result);
    return result;
  }

  /**
   * Translates a batch of consecutive segments via Background Service Worker.
   * Caches individual segment translations in memory for instant display.
   */
  async translateBatch(request: BatchTranslationRequest): Promise<BatchTranslationResponse> {
    if (!request.segments || request.segments.length === 0) {
      return { segments: [], provider: 'google-free', fromCache: false };
    }

    const promise = sendToBackground('TRANSLATE_BATCH', request).then((res) => {
      const byId = new Map(res.segments.map((s) => [s.id, s.text]));
      for (const orig of request.segments) {
        const translatedText = byId.get(orig.id);
        if (orig.text.trim() && translatedText) {
          this.setMemCache(makeCacheKey(request.source, request.target, orig.text.trim()), {
            originalText: orig.text,
            translatedText,
            provider: res.provider,
            fromCache: res.fromCache || false,
            fallback: res.fallback,
          });
        }
      }
      return res;
    });

    // Register per-text pending promises so the live display can await prefetch instead of duplicating it.
    const keys: string[] = [];
    for (const seg of request.segments) {
      const key = makeCacheKey(request.source, request.target, seg.text.trim());
      if (!seg.text.trim() || this.pending.has(key)) continue;
      keys.push(key);
      this.pending.set(
        key,
        promise.then(
          (res) => res.segments.find((s) => s.id === seg.id)?.text || '',
          () => ''
        )
      );
    }
    const release = () => keys.forEach((k) => this.pending.delete(k));
    promise.then(release, release);

    return promise;
  }

  /**
   * Cancels low-priority prefetch translation jobs in the background queue.
   */
  cancelPrefetch(): void {
    sendToBackground('CANCEL_PREFETCH').catch(() => {
      // Ignore errors if runtime is disconnected
    });
  }

  private setMemCache(key: string, result: TranslationResult): void {
    if (!result.translatedText) return;
    if (this.memCache.size >= MAX_MEM_ENTRIES) {
      const oldestKey = this.memCache.keys().next().value;
      if (oldestKey) this.memCache.delete(oldestKey);
    }
    // Fallback translations are kept briefly so the configured provider is retried soon.
    const ttl = result.fallback ? FALLBACK_MEM_CACHE_TTL_MS : MEM_CACHE_TTL_MS;
    this.memCache.set(key, { result, expiresAt: Date.now() + ttl });
  }

  clearMemCache(): void {
    this.memCache.clear();
  }
}
