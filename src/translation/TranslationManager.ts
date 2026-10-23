/**
 * Translation Manager — orchestrates the translation pipeline (runs in the service worker).
 *
 * Responsibilities:
 * 1. Cache lookups (in-memory hot cache → IndexedDB), namespaced per provider/model
 * 2. One priority queue with a shared concurrency limit for single and batch jobs
 * 3. In-flight deduplication (with priority promotion)
 * 4. Circuit breaker + fallback to Google Translate, flagged as `fallback`
 * 5. Cancellation (seek / lesson change) via ProviderError('cancelled') — never by
 *    resolving with the untranslated original
 */
import type { TranslationProvider } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type {
  TranslationResult,
  LanguageCode,
  TranslationProviderType,
  BatchTranslationRequest,
  BatchTranslationResponse,
  BatchPriority,
  TranslatedSegment,
  SubtitleSegment,
} from '../shared/types';
import {
  BREAKER_CONFIG_ERROR_MS,
  BREAKER_RATE_LIMIT_MS,
  PER_SEGMENT_CONCURRENCY,
} from '../shared/constants';
import { TranslationCache } from './TranslationCache';
import { GoogleFreeProvider } from './GoogleFreeProvider';
import { ChromeBuiltinProvider } from './ChromeBuiltinProvider';
import { GoogleCloudProvider } from './GoogleCloudProvider';
import { DeepLProvider } from './DeepLProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { GeminiProvider } from './GeminiProvider';
import { LibreTranslateProvider } from './LibreTranslateProvider';
import { TerminologyProcessor } from './TerminologyProcessor';
import { mapWithConcurrency } from './providerUtils';
import { log, logError, logWarn, makeCacheKey } from '../shared/utils';

type JobKind = 'single' | 'batch';

interface Job {
  kind: JobKind;
  key: string;
  priority: BatchPriority;
  /** Runs the work and settles the caller's promise */
  run: () => Promise<void>;
  reject: (error: Error) => void;
}

const PRIORITY_RANK: Record<BatchPriority, number> = { high: 0, normal: 1, low: 2 };

/** Queued (not yet started) single-text jobs kept at most; older ones are cancelled. */
const MAX_QUEUED_SINGLE_JOBS = 3;
const MAX_HOT_CACHE_ENTRIES = 500;
const LOW_PRIORITY_RETRY_DELAY_MS = 1500;

const cancelledError = () => new ProviderError('cancelled', 'Translation cancelled');

export class TranslationManager {
  private cache: TranslationCache;
  private provider: TranslationProvider;
  private providers: Map<TranslationProviderType, TranslationProvider>;
  private fallbackProvider: TranslationProvider;

  private jobs: Job[] = [];
  private activeCount = 0;
  private maxConcurrent: number;

  /** In-flight deduplication: key → promise + its job while it is still queued */
  private inFlight = new Map<string, { promise: Promise<unknown>; job: Job }>();

  /** In-memory hot cache (namespaced keys) */
  private hotCache = new Map<string, TranslationResult>();

  /** Circuit breaker: provider → cooldown end timestamp */
  private circuitBreakers = new Map<TranslationProviderType, number>();

  constructor(maxConcurrent: number = 2, maxCacheEntries: number = 10000, cacheTTLDays: number = 30) {
    this.maxConcurrent = maxConcurrent;
    this.cache = new TranslationCache(maxCacheEntries, cacheTTLDays);

    const all: TranslationProvider[] = [
      new GoogleFreeProvider(),
      new ChromeBuiltinProvider(),
      new GoogleCloudProvider(),
      new DeepLProvider(),
      new OpenAIProvider(),
      new GeminiProvider(),
      new LibreTranslateProvider(),
    ];
    this.providers = new Map(all.map((p) => [p.type, p]));

    this.fallbackProvider = this.providers.get('google-free')!;
    this.provider = this.fallbackProvider;
  }

  /**
   * Sets the active translation provider.
   */
  setProvider(type: TranslationProviderType, config?: { apiKey?: string; endpoint?: string; model?: string }): void {
    const provider = this.providers.get(type);
    if (!provider) {
      logWarn(`Provider ${type} not found, keeping current`);
      return;
    }

    if (config) {
      provider.configure(config);
    }

    this.provider = provider;
    this.circuitBreakers.delete(type);
    log(`Translation provider set to: ${provider.name}`);
  }

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = Math.max(1, Math.min(5, max));
    this.pump();
  }

  updateCacheConfig(maxEntries: number, ttlDays: number): void {
    this.cache.updateConfig(maxEntries, ttlDays);
  }

  // ============================================================
  // Single text
  // ============================================================

  /**
   * Translates text with caching, queuing, and deduplication.
   * Rejects with ProviderError('cancelled') if dropped from the queue.
   */
  async translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<TranslationResult> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return { originalText: text, translatedText: '', provider: this.provider.type, fromCache: false };
    }

    const cached = await this.lookup(trimmedText, source, target, this.provider);
    if (cached) return cached;

    const key = `single|${makeCacheKey(source, target, trimmedText, this.provider.cacheNamespace)}`;
    return this.enqueue<TranslationResult>('single', key, 'high', () =>
      this.executeTranslation(trimmedText, source, target, context)
    );
  }

  private async executeTranslation(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<TranslationResult> {
    const primary = this.provider;
    const first = this.isTripped(primary) ? this.fallbackProvider : primary;

    try {
      return await this.translateWith(first, primary, text, source, target, context);
    } catch (err) {
      this.recordFailure(first, err);
      if (first === this.fallbackProvider) throw err;

      try {
        log(`Falling back to ${this.fallbackProvider.name}`);
        return await this.translateWith(this.fallbackProvider, primary, text, source, target, context);
      } catch (fallbackErr) {
        logError('Fallback translation also failed:', fallbackErr);
        throw err;
      }
    }
  }

  private async translateWith(
    provider: TranslationProvider,
    primary: TranslationProvider,
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<TranslationResult> {
    log(`Translating: "${text.substring(0, 40)}..." via ${provider.name}`);
    const raw = await provider.translate(text, source, target, context);
    const translatedText = this.postProcess(provider, raw, target);
    if (!translatedText.trim()) {
      throw new ProviderError('bad-response', `${provider.name}: empty translation`);
    }
    this.store(provider, source, target, text, translatedText);
    return {
      originalText: text,
      translatedText,
      provider: provider.type,
      fromCache: false,
      fallback: provider !== primary,
    };
  }

  // ============================================================
  // Batch
  // ============================================================

  /**
   * Translates a semantic batch of subtitle segments with context.
   * Only uncached segments are sent to the provider. Segments that could not be
   * translated come back with an empty text.
   */
  async translateBatch(request: BatchTranslationRequest): Promise<BatchTranslationResponse> {
    if (!request.segments || request.segments.length === 0) {
      return { segments: [], provider: this.provider.type, fromCache: false };
    }

    const { source, target, priority = 'normal' } = request;
    const primary = this.provider;

    const translations = new Map<number, string>();
    const uncached: SubtitleSegment[] = [];
    for (const seg of request.segments) {
      const trimmed = seg.text.trim();
      if (!trimmed) {
        translations.set(seg.id, '');
        continue;
      }
      const cached = await this.lookup(trimmed, source, target, primary);
      if (cached) translations.set(seg.id, cached.translatedText);
      else uncached.push(seg);
    }

    const assemble = (fallback = false, fromCache = false): BatchTranslationResponse => ({
      segments: request.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: translations.get(s.id) || '' })),
      provider: fallback ? this.fallbackProvider.type : primary.type,
      fromCache,
      fallback,
    });

    if (uncached.length === 0) {
      log(`Batch full cache hit for ${request.segments.length} segments`);
      return assemble(false, true);
    }

    const subRequest: BatchTranslationRequest = { ...request, segments: uncached };
    const key = `batch|${primary.cacheNamespace}|${source}:${target}|${uncached.map((s) => s.text).join('␞')}`;

    const result = await this.enqueue<{ segments: TranslatedSegment[]; fallback: boolean }>('batch', key, priority, () =>
      this.executeBatchTranslation(subRequest, priority)
    );
    for (const seg of result.segments) translations.set(seg.id, seg.text);
    return assemble(result.fallback);
  }

  private async executeBatchTranslation(
    request: BatchTranslationRequest,
    priority: BatchPriority
  ): Promise<{ segments: TranslatedSegment[]; fallback: boolean }> {
    const primary = this.provider;
    const first = this.isTripped(primary) ? this.fallbackProvider : primary;
    const retries = priority === 'low' ? 1 : 0;

    try {
      return { segments: await this.batchWith(first, request, retries), fallback: first !== primary };
    } catch (err) {
      this.recordFailure(first, err);
      if (first === this.fallbackProvider) throw err;

      try {
        log(`Falling back to ${this.fallbackProvider.name} for batch...`);
        return { segments: await this.batchWith(this.fallbackProvider, request, 0), fallback: true };
      } catch (fallbackErr) {
        logError('Fallback batch translation also failed:', fallbackErr);
        throw err;
      }
    }
  }

  private async batchWith(
    provider: TranslationProvider,
    request: BatchTranslationRequest,
    retries: number
  ): Promise<TranslatedSegment[]> {
    log(`Translating batch of ${request.segments.length} segments via ${provider.name}`);

    let raw: TranslatedSegment[];
    try {
      raw = provider.translateBatch
        ? await provider.translateBatch(request)
        : await this.translateSegmentsIndividually(provider, request);
    } catch (err) {
      const retryable =
        err instanceof ProviderError && (err.kind === 'server' || err.kind === 'network' || err.kind === 'timeout');
      if (retries > 0 && retryable) {
        await new Promise((r) => setTimeout(r, LOW_PRIORITY_RETRY_DELAY_MS));
        return this.batchWith(provider, request, retries - 1);
      }
      throw err;
    }

    return request.segments.map((seg) => {
      const returned = raw.find((r) => r.id === seg.id);
      const text = returned?.text ? this.postProcess(provider, returned.text, request.target) : '';
      if (text) this.store(provider, request.source, request.target, seg.text.trim(), text);
      return { id: seg.id, start: seg.start, end: seg.end, text };
    });
  }

  /** For providers without a batch API: one request per segment, limited parallelism. */
  private async translateSegmentsIndividually(
    provider: TranslationProvider,
    request: BatchTranslationRequest
  ): Promise<TranslatedSegment[]> {
    let firstError: unknown = null;
    const results = await mapWithConcurrency(request.segments, PER_SEGMENT_CONCURRENCY, async (seg) => {
      try {
        const text = await provider.translate(seg.text, request.source, request.target);
        return { id: seg.id, start: seg.start, end: seg.end, text };
      } catch (err) {
        firstError ??= err;
        return { id: seg.id, start: seg.start, end: seg.end, text: '' };
      }
    });
    if (firstError && results.every((r) => !r.text)) throw firstError;
    return results;
  }

  // ============================================================
  // Queue
  // ============================================================

  private enqueue<T>(kind: JobKind, key: string, priority: BatchPriority, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      log('In-flight dedup hit');
      // A current-playback request must not wait behind prefetch it deduplicated onto.
      if (PRIORITY_RANK[priority] < PRIORITY_RANK[existing.job.priority] && this.jobs.includes(existing.job)) {
        this.jobs = this.jobs.filter((j) => j !== existing.job);
        existing.job.priority = priority;
        this.insertJob(existing.job);
      }
      return existing.promise as Promise<T>;
    }

    let job!: Job;
    const promise = new Promise<T>((resolve, reject) => {
      job = { kind, key, priority, run: () => run().then(resolve, reject), reject };
    });

    this.inFlight.set(key, { promise, job });
    promise.then(
      () => this.inFlight.delete(key),
      () => this.inFlight.delete(key)
    );

    this.insertJob(job);
    if (kind === 'single') this.trimQueuedSingles();
    this.pump();
    return promise;
  }

  /** Newest job first within its priority: the latest current-cue request is the relevant one. */
  private insertJob(job: Job): void {
    const index = this.jobs.findIndex((j) => PRIORITY_RANK[j.priority] >= PRIORITY_RANK[job.priority]);
    if (index === -1) this.jobs.push(job);
    else this.jobs.splice(index, 0, job);
  }

  private trimQueuedSingles(): void {
    const singles = this.jobs.filter((j) => j.kind === 'single');
    for (const stale of singles.slice(MAX_QUEUED_SINGLE_JOBS)) {
      this.jobs = this.jobs.filter((j) => j !== stale);
      stale.reject(cancelledError());
    }
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.activeCount++;
      job
        .run()
        .finally(() => {
          this.activeCount--;
          this.pump();
        });
    }
  }

  /**
   * Cancels queued (not yet started) batch jobs, e.g. prefetch on seek or lesson change.
   * Without a priority, all queued jobs are cancelled.
   */
  cancelPending(priority?: BatchPriority): void {
    const cancelled = this.jobs.filter((j) => (priority ? j.kind === 'batch' && j.priority === priority : true));
    this.jobs = this.jobs.filter((j) => !cancelled.includes(j));
    for (const job of cancelled) job.reject(cancelledError());
    if (cancelled.length) log(`Cancelled ${cancelled.length} queued translation job(s)`);
  }

  // ============================================================
  // Cache, breaker, post-processing
  // ============================================================

  private hotKey(provider: TranslationProvider, source: LanguageCode, target: LanguageCode, text: string): string {
    return makeCacheKey(source, target, text, provider.cacheNamespace);
  }

  private async lookup(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    provider: TranslationProvider
  ): Promise<TranslationResult | null> {
    const key = this.hotKey(provider, source, target, text);
    const hot = this.hotCache.get(key);
    if (hot) return { ...hot, originalText: text, fromCache: true };

    try {
      const cached = await this.cache.get(source, target, text, provider.cacheNamespace);
      if (cached) {
        const result: TranslationResult = {
          originalText: text,
          translatedText: cached.translatedText,
          provider: cached.provider,
          fromCache: true,
        };
        this.setHotCache(key, result);
        return result;
      }
    } catch (err) {
      logError('Cache read error:', err);
    }
    return null;
  }

  /** Stores under the namespace of the provider that actually produced the text. */
  private store(
    provider: TranslationProvider,
    source: LanguageCode,
    target: LanguageCode,
    originalText: string,
    translatedText: string
  ): void {
    if (!translatedText.trim()) return;
    this.setHotCache(this.hotKey(provider, source, target, originalText), {
      originalText,
      translatedText,
      provider: provider.type,
      fromCache: false,
    });
    this.cache
      .set(source, target, originalText, translatedText, provider.type, provider.cacheNamespace)
      .catch((err) => logError('Cache write error:', err));
  }

  private setHotCache(key: string, result: TranslationResult): void {
    if (this.hotCache.size >= MAX_HOT_CACHE_ENTRIES) {
      const oldestKey = this.hotCache.keys().next().value;
      if (oldestKey) this.hotCache.delete(oldestKey);
    }
    this.hotCache.set(key, result);
  }

  /** LLM output already follows the prompt's terminology rules; MT output gets the regex fixes. */
  private postProcess(provider: TranslationProvider, text: string, target: LanguageCode): string {
    return provider.isLlm ? text.trim() : TerminologyProcessor.process(text, 'en', target).trim();
  }

  private isTripped(provider: TranslationProvider): boolean {
    return provider !== this.fallbackProvider && Date.now() < (this.circuitBreakers.get(provider.type) || 0);
  }

  private recordFailure(provider: TranslationProvider, err: unknown): void {
    logWarn(`Provider ${provider.name} failed:`, err);
    if (provider === this.fallbackProvider || !(err instanceof ProviderError)) return;

    const cooldown =
      err.kind === 'rate-limit' ? BREAKER_RATE_LIMIT_MS
      : err.kind === 'auth' || err.kind === 'not-found' ? BREAKER_CONFIG_ERROR_MS
      : 0;
    if (cooldown) {
      this.circuitBreakers.set(provider.type, Date.now() + cooldown);
      logWarn(`Tripped circuit breaker for ${provider.name} (${cooldown / 1000}s, ${err.kind})`);
    }
  }

  async clearCache(): Promise<void> {
    this.hotCache.clear();
    await this.cache.clear();
    log('Translation cache cleared');
  }

  async getCacheStats(): Promise<{ count: number; oldestTimestamp: number | null }> {
    return this.cache.getStats();
  }
}
