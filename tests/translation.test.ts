/**
 * Translation pipeline: manager (cache, queue, fallback, breaker), client (content-side cache), providers (fetch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslationManager } from '../src/translation/TranslationManager';
import { ProviderError, type TranslationProvider } from '../src/translation/TranslationProvider';
import { TranslationClient } from '../src/translation/TranslationClient';
import { GeminiProvider } from '../src/translation/GeminiProvider';
import { OpenAIProvider } from '../src/translation/OpenAIProvider';
import { GoogleFreeProvider } from '../src/translation/GoogleFreeProvider';
import type { BatchTranslationRequest } from '../src/shared/types';

function mockProvider(overrides: Partial<TranslationProvider> = {}): TranslationProvider {
  return {
    name: 'Mock LLM',
    type: 'gemini',
    requiresApiKey: true,
    isLlm: true,
    cacheNamespace: 'gemini:mock',
    configure: vi.fn(),
    translate: vi.fn().mockResolvedValue('перевод'),
    ...overrides,
  };
}

function createManager(max = 2, { fallback = true } = {}) {
  const manager = new TranslationManager(max, 50, 1);
  manager.setFallbackEnabled(fallback);
  const store = new Map<string, string>();
  const cache = (manager as any).cache;
  cache.get = vi.fn(async (s: string, t: string, text: string, ns: string) => {
    const v = store.get(`${ns}|${s}:${t}:${text.toLowerCase()}`);
    return v ? { translatedText: v, provider: 'gemini' } : null;
  });
  cache.set = vi.fn(async (s: string, t: string, text: string, tr: string, _p: string, ns: string) => {
    store.set(`${ns}|${s}:${t}:${text.toLowerCase()}`, tr);
  });
  const google = (manager as any).fallbackProvider as GoogleFreeProvider;
  return { manager, store, cache, google };
}

const batch = (texts: string[], priority: BatchTranslationRequest['priority'] = 'normal'): BatchTranslationRequest => ({
  segments: texts.map((text, i) => ({ id: i + 1, start: i, end: i + 1, text })),
  source: 'en',
  target: 'ru',
  priority,
});

describe('TranslationManager', () => {
  it('never caches the original text when the fallback provider fails', async () => {
    const { manager, cache, google } = createManager();
    google.translate = vi.fn().mockRejectedValue(new ProviderError('timeout', 'timeout'));

    await expect(manager.translateBatch(batch(['hello world']))).rejects.toMatchObject({ kind: 'timeout' });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns empty text for untranslated segments and caches only real translations', async () => {
    const { manager, cache, google } = createManager();
    google.translate = vi.fn(async (text: string) => {
      if (text === 'bad') throw new ProviderError('server', 'boom');
      return `RU ${text}`;
    });

    const res = await manager.translateBatch(batch(['good', 'bad']));
    expect(res.segments.map((s) => s.text)).toEqual(['RU good', '']);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('rejects cancelled prefetch jobs instead of resolving them with the original', async () => {
    const { manager } = createManager(1);
    (manager as any).provider = mockProvider({ translateBatch: () => new Promise(() => {}) });

    manager.translateBatch(batch(['busy'], 'high'));
    const low = manager.translateBatch(batch(['we deploy the app'], 'low'));
    await new Promise((r) => setTimeout(r, 10));
    manager.cancelPending('low');

    await expect(low).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('rejects single jobs dropped by queue overflow (never resolves with an empty translation)', async () => {
    const { manager } = createManager(1);
    (manager as any).provider = mockProvider({
      translate: (t: string) => new Promise((r) => setTimeout(() => r(`RU:${t}`), 20)),
    });

    const results = await Promise.allSettled(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((t) => manager.translate(t, 'en', 'ru')));
    for (const r of results) {
      if (r.status === 'fulfilled') expect(r.value.translatedText).toMatch(/^RU:/);
      else expect(r.reason).toMatchObject({ kind: 'cancelled' });
    }
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
  });

  it('keeps translations of different providers apart', async () => {
    const { manager } = createManager();
    const a = mockProvider({ cacheNamespace: 'gemini:a', translate: vi.fn().mockResolvedValue('A') });
    const b = mockProvider({ cacheNamespace: 'openai:b', type: 'openai', translate: vi.fn().mockResolvedValue('B') });

    (manager as any).provider = a;
    expect((await manager.translate('text', 'en', 'ru')).translatedText).toBe('A');
    (manager as any).provider = b;
    expect((await manager.translate('text', 'en', 'ru')).translatedText).toBe('B');
    expect(b.translate).toHaveBeenCalledTimes(1);
  });

  it('flags fallback results and stores them under the fallback provider namespace', async () => {
    const { manager, store, google } = createManager();
    (manager as any).provider = mockProvider({ translate: vi.fn().mockRejectedValue(new ProviderError('timeout', 't')) });
    google.translate = vi.fn().mockResolvedValue('гугл');

    const res = await manager.translate('hello', 'en', 'ru');
    expect(res).toMatchObject({ translatedText: 'гугл', fallback: true, provider: 'google-free' });
    expect([...store.keys()].every((k) => k.startsWith('google-free|'))).toBe(true);
  });

  it('trips the breaker on auth errors and stops calling the broken provider', async () => {
    const { manager, google } = createManager();
    const broken = mockProvider({ translate: vi.fn().mockRejectedValue(new ProviderError('auth', 'bad key', 401)) });
    (manager as any).provider = broken;
    google.translate = vi.fn(async (t: string) => `G ${t}`);

    await manager.translate('one', 'en', 'ru');
    await manager.translate('two', 'en', 'ru');
    expect(broken.translate).toHaveBeenCalledTimes(1);
  });

  it('does not send text to Google when the fallback is disabled', async () => {
    const { manager, google } = createManager(2, { fallback: false });
    (manager as any).provider = mockProvider({ translate: vi.fn().mockRejectedValue(new ProviderError('timeout', 'slow')) });
    google.translate = vi.fn().mockResolvedValue('гугл');

    await expect(manager.translate('hello', 'en', 'ru')).rejects.toMatchObject({ kind: 'timeout' });
    expect(google.translate).not.toHaveBeenCalled();
  });

  it('does not send batches to Google when the fallback is disabled', async () => {
    const { manager, google } = createManager(2, { fallback: false });
    (manager as any).provider = mockProvider({
      translateBatch: vi.fn().mockRejectedValue(new ProviderError('server', 'down', 503)),
    });
    google.translate = vi.fn().mockResolvedValue('гугл');

    await expect(manager.translateBatch(batch(['hello']))).rejects.toMatchObject({ kind: 'server' });
    expect(google.translate).not.toHaveBeenCalled();
  });

  it('with an open breaker and no fallback, fails fast with the original error', async () => {
    const { manager, google } = createManager(2, { fallback: false });
    const broken = mockProvider({ translate: vi.fn().mockRejectedValue(new ProviderError('auth', 'bad key', 401)) });
    (manager as any).provider = broken;
    google.translate = vi.fn();

    await expect(manager.translate('one', 'en', 'ru')).rejects.toMatchObject({ kind: 'auth' });
    const second = manager.translate('two', 'en', 'ru');
    await expect(second).rejects.toMatchObject({ kind: 'auth' });
    await expect(second).rejects.toThrow(/bad key.*paused/);
    expect(broken.translate).toHaveBeenCalledTimes(1);
    expect(google.translate).not.toHaveBeenCalled();
  });

  it('closes the breaker when the provider is reconfigured (e.g. a new key)', async () => {
    const { manager } = createManager(2, { fallback: false });
    const gemini = (manager as any).providers.get('gemini');
    gemini.translate = vi.fn().mockRejectedValueOnce(new ProviderError('auth', 'bad key', 401)).mockResolvedValue('ок');
    manager.setProvider('gemini', { apiKey: 'old' });

    await expect(manager.translate('one', 'en', 'ru')).rejects.toMatchObject({ kind: 'auth' });
    manager.setProvider('gemini', { apiKey: 'new' });
    expect((await manager.translate('one', 'en', 'ru')).translatedText).toBe('ок');
  });

  it('sends only uncached segments of a batch to the provider', async () => {
    const { manager } = createManager();
    const translateBatch = vi.fn(async (req: BatchTranslationRequest) =>
      req.segments.map((s) => ({ ...s, text: `RU ${s.text}` }))
    );
    (manager as any).provider = mockProvider({ translateBatch });

    await manager.translateBatch(batch(['first']));
    const res = await manager.translateBatch(batch(['first', 'second']));
    expect(translateBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ segments: [expect.objectContaining({ text: 'second' })] })
    );
    expect(res.segments.map((s) => s.text)).toEqual(['RU first', 'RU second']);
  });

  it('promotes a queued prefetch job when the live display needs the same text', async () => {
    const { manager } = createManager(1);
    let release!: () => void;
    const order: string[] = [];
    (manager as any).provider = mockProvider({
      translateBatch: vi.fn(async (req: BatchTranslationRequest) => {
        order.push(req.segments[0].text);
        if (req.segments[0].text === 'busy') await new Promise<void>((r) => (release = r));
        return req.segments.map((s) => ({ ...s, text: `RU ${s.text}` }));
      }),
    });

    manager.translateBatch(batch(['busy'], 'high'));
    await new Promise((r) => setTimeout(r, 5));
    manager.translateBatch(batch(['other prefetch'], 'low'));
    const low = manager.translateBatch(batch(['current'], 'low'));
    await new Promise((r) => setTimeout(r, 5));
    const high = manager.translateBatch(batch(['current'], 'high')); // dedups onto the low job
    await new Promise((r) => setTimeout(r, 5));
    release();

    await Promise.all([low, high]);
    expect(order.indexOf('current')).toBeLessThan(order.indexOf('other prefetch'));
  });

  it('does not apply regex terminology fixes to LLM output', async () => {
    const { manager } = createManager();
    (manager as any).provider = mockProvider({ translate: vi.fn().mockResolvedValue('и условия испытаний') });
    expect((await manager.translate('x', 'en', 'ru')).translatedText).toBe('и условия испытаний');
  });
});

describe('TranslationClient', () => {
  let respond: (message: any) => any;

  beforeEach(() => {
    (globalThis as any).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: vi.fn((message: any, callback?: (r: any) => void) => {
          const result = respond(message);
          if (callback) Promise.resolve(result).then(callback);
          return Promise.resolve(result);
        }),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it('does not cache empty segment translations', async () => {
    respond = () => ({ success: true, data: { provider: 'gemini', segments: [{ id: 1, start: 0, end: 1, text: '' }] } });
    const client = new TranslationClient();
    await client.translateBatch(batch(['hello']));
    expect(client.getCached('hello', 'en', 'ru')).toBeNull();
  });

  it('exposes in-flight batch translations per text', async () => {
    respond = () => ({ success: true, data: { provider: 'gemini', segments: [{ id: 1, start: 0, end: 1, text: 'привет' }] } });
    const client = new TranslationClient();
    const p = client.translateBatch(batch(['hello']));
    const pending = client.getPending('hello', 'en', 'ru');
    expect(pending).not.toBeNull();
    expect(await pending).toBe('привет');
    await p;
    expect(client.getPending('hello', 'en', 'ru')).toBeNull();
    expect(client.getCached('hello', 'en', 'ru')?.translatedText).toBe('привет');
  });

  it('passes the cancelled error code through', async () => {
    respond = () => ({ success: false, error: 'Translation cancelled', errorCode: 'cancelled' });
    const client = new TranslationClient();
    await expect(client.translateBatch(batch(['x']))).rejects.toMatchObject({ cancelled: true });
  });

  it('keeps fallback translations only briefly', async () => {
    vi.useFakeTimers();
    try {
      respond = () => ({ success: true, data: { originalText: 'hi', translatedText: 'привет', provider: 'google-free', fromCache: false, fallback: true } });
      const client = new TranslationClient();
      await client.translate('hi', 'en', 'ru');
      expect(client.getCached('hi', 'en', 'ru')).not.toBeNull();
      vi.advanceTimersByTime(3 * 60 * 1000);
      expect(client.getCached('hi', 'en', 'ru')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('providers (fetch mocked)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('Gemini sends the key in a header, not in the URL, and falls back on 404 of the default model', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { message: 'not found' } }, 404))
      .mockResolvedValueOnce(json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Привет' }] } }] }));
    const gemini = new GeminiProvider();
    gemini.configure({ apiKey: 'secret' });

    expect(await gemini.translate('Hello', 'en', 'ru')).toBe('Привет');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).not.toContain('secret');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
    expect(url).toContain('gemini-2.5-flash');
  });

  it('Gemini rejects truncated output', async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"segm' }] } }] }));
    const gemini = new GeminiProvider();
    gemini.configure({ apiKey: 'k', model: 'custom' });
    await expect(gemini.translateBatch(batch(['a']))).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('OpenAI single translation returns plain text even if the model answers with JSON', async () => {
    fetchMock.mockResolvedValue(json({ choices: [{ finish_reason: 'stop', message: { content: '{"segments":[{"id":1,"text":"Привет"}]}' } }] }));
    const openai = new OpenAIProvider();
    openai.configure({ apiKey: 'k' });
    expect(await openai.translate('Hello', 'en', 'ru')).toBe('Привет');
  });

  it('OpenAI ignores a non-https custom endpoint (the key is never sent there)', async () => {
    fetchMock.mockResolvedValue(json({ choices: [{ finish_reason: 'stop', message: { content: 'Привет' } }] }));
    const openai = new OpenAIProvider();
    openai.configure({ apiKey: 'k', endpoint: 'http://evil.example.com/v1' });
    await openai.translate('Hello', 'en', 'ru');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('OpenAI maps 429 to a rate-limit error', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'slow down' } }, 429));
    const openai = new OpenAIProvider();
    openai.configure({ apiKey: 'k' });
    await expect(openai.translate('Hello', 'en', 'ru')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('Google Free returns empty text for failed segments and throws only if all fail', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('q=bad') ? json({}, 500) : json([[['Привет', 'good']]])
    );
    const google = new GoogleFreeProvider();
    const res = await google.translateBatch(batch(['good', 'bad']));
    expect(res.map((r) => r.text)).toEqual(['Привет', '']);

    fetchMock.mockResolvedValue(json({}, 500));
    await expect(google.translateBatch(batch(['bad']))).rejects.toMatchObject({ kind: 'server' });
  });
});
