/**
 * LiveTranslator: the order of attempts for the subtitle on screen, stale-request suppression,
 * cancellation and error rendering.
 */
import { describe, it, expect, vi } from 'vitest';
import { LiveTranslator, type LiveTranslatorDeps } from '../src/content/LiveTranslator';
import { MessageError } from '../src/shared/messages';
import type { BatchTranslationRequest, SubtitleState, TranslationResult } from '../src/shared/types';

const result = (translatedText: string, fallback?: boolean): TranslationResult => ({
  originalText: 'x',
  translatedText,
  provider: 'gemini',
  fromCache: false,
  fallback,
});

const batchReq = (text: string): BatchTranslationRequest => ({
  segments: [{ id: 1, start: 0, end: 1, text }],
  previousContext: ['before'],
  source: 'en',
  target: 'ru',
  priority: 'high',
});

function setup(overrides: Partial<LiveTranslatorDeps['client']> = {}, batch: BatchTranslationRequest | null = null) {
  const cache = new Map<string, TranslationResult>();
  const rendered: SubtitleState[] = [];
  const client: LiveTranslatorDeps['client'] = {
    getCached: vi.fn((text: string) => cache.get(text) ?? null),
    getPending: vi.fn(() => null),
    translateBatch: vi.fn(async () => ({ segments: [], provider: 'gemini' as const })),
    translate: vi.fn(async (text: string) => result(`RU ${text}`)),
    ...overrides,
  };
  const onRendered = vi.fn();
  const live = new LiveTranslator({
    client,
    render: (s) => rendered.push(s),
    batchAround: () => (batch ? structuredClone(batch) : null),
    upcomingText: () => 'next line',
    onRendered,
  });
  return { live, client, cache, rendered, onRendered };
}

describe('LiveTranslator', () => {
  it('shows a cached translation immediately, without requests', async () => {
    const { live, client, cache, rendered } = setup();
    cache.set('hello', result('привет', true));

    await live.show('hello', 'hello', 'en', 'ru');
    expect(rendered).toEqual([{ originalText: 'hello', translatedText: 'привет', status: 'done', fallback: true }]);
    expect(client.translate).not.toHaveBeenCalled();
  });

  it('awaits a prefetch already translating the same text', async () => {
    const { live, client, cache, rendered } = setup({
      getPending: vi.fn(() => {
        cache.set('hello', result('привет'));
        return Promise.resolve('привет');
      }),
    });

    await live.show('hello', 'hello', 'en', 'ru');
    expect(rendered.map((s) => s.status)).toEqual(['translating', 'done']);
    expect(rendered[1].translatedText).toBe('привет');
    expect(client.translate).not.toHaveBeenCalled();
  });

  it('translates a batch around the playback position, with known previous translations', async () => {
    const { live, client, cache, rendered } = setup({}, batchReq('hello'));
    cache.set('before', result('до'));
    client.translateBatch = vi.fn(async () => {
      cache.set('hello', result('привет'));
      return { segments: [{ id: 1, start: 0, end: 1, text: 'привет' }], provider: 'gemini' as const };
    });

    await live.show('hello', 'hello', 'en', 'ru');
    expect(client.translateBatch).toHaveBeenCalledWith(expect.objectContaining({ previousTranslations: ['до'] }));
    expect(rendered.at(-1)).toMatchObject({ status: 'done', translatedText: 'привет' });
    expect(client.translate).not.toHaveBeenCalled();
  });

  it('falls back to a single request with context when the batch fails', async () => {
    const { live, client, rendered, onRendered } = setup({}, batchReq('hello'));
    client.translateBatch = vi.fn().mockRejectedValue(new MessageError('boom', 'server'));

    await live.show('hello', 'hello', 'en', 'ru');
    expect(client.translate).toHaveBeenCalledWith('hello', 'en', 'ru', { previous: undefined, upcoming: 'next line' });
    expect(rendered.at(-1)).toMatchObject({ status: 'done', translatedText: 'RU hello' });
    expect(onRendered).toHaveBeenCalledTimes(1);
  });

  it('sends the previous line as context of the next request', async () => {
    const { live, client } = setup();
    await live.show('one', 'one', 'en', 'ru');
    await live.show('two', 'two', 'en', 'ru');
    expect(client.translate).toHaveBeenLastCalledWith('two', 'en', 'ru', { previous: 'one', upcoming: 'next line' });

    live.resetContext();
    await live.show('three', 'three', 'en', 'ru');
    expect(client.translate).toHaveBeenLastCalledWith('three', 'en', 'ru', { previous: undefined, upcoming: 'next line' });
  });

  it('never renders a stale translation over a newer subtitle', async () => {
    let releaseFirst!: (r: TranslationResult) => void;
    const { live, rendered } = setup({
      translate: vi.fn((text: string) =>
        text === 'first' ? new Promise<TranslationResult>((r) => (releaseFirst = r)) : Promise.resolve(result(`RU ${text}`))
      ),
    });

    const first = live.show('first', 'first', 'en', 'ru');
    await live.show('second', 'second', 'en', 'ru');
    releaseFirst(result('RU first'));
    await first;

    expect(rendered.at(-1)).toMatchObject({ originalText: 'second', translatedText: 'RU second' });
    expect(rendered.some((s) => s.translatedText === 'RU first')).toBe(false);
  });

  it('renders nothing after invalidate()', async () => {
    let release!: (r: TranslationResult) => void;
    const { live, rendered } = setup({ translate: vi.fn(() => new Promise<TranslationResult>((r) => (release = r))) });

    const pending = live.show('hello', 'hello', 'en', 'ru');
    live.invalidate();
    release(result('привет'));
    await pending;
    expect(rendered.map((s) => s.status)).toEqual(['translating']);
  });

  it('ignores cancelled requests and shows other errors with the message', async () => {
    const cancelled = setup({ translate: vi.fn().mockRejectedValue(new MessageError('Translation cancelled', 'cancelled')) });
    await cancelled.live.show('a', 'a', 'en', 'ru');
    expect(cancelled.rendered.map((s) => s.status)).toEqual(['translating']);

    const failing = setup({ translate: vi.fn().mockRejectedValue(new MessageError('Gemini API key is not configured', 'auth')) });
    await failing.live.show('a', 'a', 'en', 'ru');
    expect(failing.rendered.at(-1)).toMatchObject({ status: 'error', errorMessage: 'Gemini API key is not configured' });
  });

  it('passes the fallback flag of a single request to the renderer', async () => {
    const { live, rendered } = setup({ translate: vi.fn(async () => result('гугл', true)) });
    await live.show('hello', 'hello', 'en', 'ru');
    expect(rendered.at(-1)).toMatchObject({ status: 'done', fallback: true });
  });
});
