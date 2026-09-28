/**
 * TranslationClient — client for content script to request translations.
 *
 * Communicates with Background Service Worker via chrome.runtime.sendMessage.
 * This bypasses Udemy's strict Content Security Policy (connect-src) and CORS.
 * Includes a fast in-memory cache and per-text in-flight tracking in the content script.
 */
import type {
  LanguageCode,
  TranslationResult,
  BatchTranslationRequest,
  BatchTranslationResponse,
  MessageResponse,
} from '../shared/types';
import { FALLBACK_MEM_CACHE_TTL_MS, MEM_CACHE_TTL_MS } from '../shared/constants';
import { makeCacheKey } from '../shared/utils';

const MAX_MEM_ENTRIES = 500;

export class TranslationRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'TranslationRequestError';
  }

  get cancelled(): boolean {
    return this.code === 'cancelled';
  }
}

function sendMessage<T>(message: { action: string; payload?: unknown }): Promise<MessageResponse<T>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: MessageResponse<T> | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new TranslationRequestError(chrome.runtime.lastError.message || 'Background worker unavailable'));
          return;
        }
        resolve(response || { success: false, error: 'No response from background' });
      });
    } catch (err) {
      // "Extension context invalidated" after the extension is reloaded
      reject(new TranslationRequestError(err instanceof Error ? err.message : 'Background worker unavailable'));
    }
  });
}

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
    context?: { previous?: string; upcoming?: string }
  ): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { originalText: text, translatedText: '', provider: 'google-free', fromCache: false };
    }

    const cached = this.getCached(trimmed, source, target);
    if (cached) return cached;

    const response = await sendMessage<TranslationResult>({
      action: 'TRANSLATE_TEXT',
      payload: { text: trimmed, source, target, context },
    });

    if (!response.success || !response.data) {
      throw new TranslationRequestError(response.error || 'Translation failed', response.errorCode);
    }

    const result = response.data;
    if (!result.translatedText) {
      throw new TranslationRequestError('Empty translation');
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

    const promise = sendMessage<BatchTranslationResponse>({ action: 'TRANSLATE_BATCH', payload: request }).then(
      (response) => {
        if (!response.success || !response.data) {
          throw new TranslationRequestError(response.error || 'Batch translation failed', response.errorCode);
        }
        const res = response.data;
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
      }
    );

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
    sendMessage({ action: 'CANCEL_PREFETCH' }).catch(() => {
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
