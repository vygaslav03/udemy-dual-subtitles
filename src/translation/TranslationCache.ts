/**
 * Translation cache using IndexedDB (lives in the background service worker).
 *
 * Caches translations to avoid redundant API calls.
 * Features:
 * - Keys namespaced by provider/model/prompt version
 * - TTL-based expiration
 * - Oldest-first eviction when max entries exceeded
 */
import type { CachedTranslation, LanguageCode, TranslationProviderType } from '../shared/types';
import { DB_NAME, DB_VERSION, CACHE_STORE_NAME } from '../shared/constants';
import { makeCacheKey } from '../shared/utils';

/** Eviction needs a full count(); run it once per this many writes instead of on every write. */
const EVICTION_CHECK_EVERY_WRITES = 50;

export class TranslationCache {
  private db: IDBDatabase | null = null;
  private maxEntries: number;
  private ttlMs: number;
  private writesSinceEvictionCheck = 0;

  constructor(maxEntries: number = 10000, ttlDays: number = 30) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // v1 entries were not namespaced by provider, and some held the untranslated
        // original as the "translation" — drop them instead of migrating.
        if (event.oldVersion < 2) {
          if (db.objectStoreNames.contains(CACHE_STORE_NAME)) db.deleteObjectStore(CACHE_STORE_NAME);
          // The dictionary lives in chrome.storage.local; this store was never used.
          if (db.objectStoreNames.contains('dictionary')) db.deleteObjectStore('dictionary');
        }

        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        this.db.onclose = () => { this.db = null; };
        resolve(this.db);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Gets a cached translation, or null if not found / expired.
   */
  async get(
    source: LanguageCode,
    target: LanguageCode,
    text: string,
    namespace: string
  ): Promise<CachedTranslation | null> {
    const db = await this.openDB();
    const key = makeCacheKey(source, target, text, namespace);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result as CachedTranslation | undefined;
        if (!result || !result.translatedText) {
          resolve(null);
          return;
        }

        // Check TTL
        if (Date.now() - result.timestamp > this.ttlMs) {
          // Entry expired, clean it up asynchronously
          this.delete(key).catch(() => { /* ignore cleanup errors */ });
          resolve(null);
          return;
        }

        resolve(result);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Stores a translation in cache. Empty translations are never stored.
   */
  async set(
    source: LanguageCode,
    target: LanguageCode,
    originalText: string,
    translatedText: string,
    provider: TranslationProviderType,
    namespace: string
  ): Promise<void> {
    if (!translatedText.trim()) return;

    const db = await this.openDB();
    const key = makeCacheKey(source, target, originalText, namespace);

    const entry: CachedTranslation = {
      key,
      originalText: originalText.trim(),
      translatedText,
      sourceLanguage: source,
      targetLanguage: target,
      provider,
      timestamp: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      store.put(entry); // put = upsert

      tx.oncomplete = () => {
        resolve();
        if (++this.writesSinceEvictionCheck >= EVICTION_CHECK_EVERY_WRITES) {
          this.writesSinceEvictionCheck = 0;
          this.evictIfNeeded().catch(() => { /* ignore */ });
        }
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Deletes a specific cache entry.
   */
  private async delete(key: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Evicts oldest entries if cache exceeds max size.
   */
  private async evictIfNeeded(): Promise<void> {
    const db = await this.openDB();

    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (count <= this.maxEntries) return;

    const toDelete = count - this.maxEntries;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const index = store.index('timestamp');
      const request = index.openCursor(); // ascending = oldest first
      let deleted = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && deleted < toDelete) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clears all cached translations.
   */
  async clear(): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Returns cache statistics.
   */
  async getStats(): Promise<{ count: number; oldestTimestamp: number | null }> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, 'readonly');
      const store = tx.objectStore(CACHE_STORE_NAME);

      const countReq = store.count();
      let count = 0;
      let oldestTimestamp: number | null = null;

      countReq.onsuccess = () => {
        count = countReq.result;
      };

      const index = store.index('timestamp');
      const cursorReq = index.openCursor();

      cursorReq.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          oldestTimestamp = cursor.value.timestamp;
          // Don't continue — we only need the oldest
        }
      };

      tx.oncomplete = () => resolve({ count, oldestTimestamp });
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Update configuration */
  updateConfig(maxEntries: number, ttlDays: number): void {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }
}
