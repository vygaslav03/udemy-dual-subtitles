/**
 * Text processing: terminology fixes, punctuation clean-up, LLM response parsing, utils, settings migration.
 */
import { describe, it, expect } from 'vitest';
import { TerminologyProcessor } from '../src/translation/TerminologyProcessor';
import { SentenceSegmenter } from '../src/content/SentenceSegmenter';
import {
  errorFromResponse,
  extractPlainTranslation,
  isAllowedEndpoint,
  mapBatchResponse,
  stripWrappingQuotes,
} from '../src/translation/providerUtils';
import { decodeHtmlEntities, lessonKey, makeCacheKey } from '../src/shared/utils';
import { normalizeSettings, getProviderConfig } from '../src/shared/storage';
import { SubtitleFormatter } from '../src/content/SubtitleFormatter';

describe('TerminologyProcessor', () => {
  const p = (t: string) => TerminologyProcessor.process(t);

  it('keeps grammatical case of the replaced phrase', () => {
    expect(p('Мы находимся на этапе испытаний')).toBe('Мы находимся на этапе тестирования');
    expect(p('Это этап испытаний')).toBe('Это этап тестирования');
    expect(p('без набора испытаний')).toBe('без набора тестов');
    expect(p('результаты регрессионных испытаний')).toBe('результаты регрессионного тестирования');
    expect(p('проведём дымовые испытания')).toBe('проведём smoke-тестирование');
    expect(p('создайте новую ветвь git')).toBe('создайте новую ветку git');
  });

  it('never changes the capitalization of a continuation segment', () => {
    expect(p('и после этого мы развернём приложение')).toBe('и после этого мы развернём приложение');
  });

  it('keeps the initial capital of a replaced phrase', () => {
    expect(p('Условия испытаний определены')).toBe('Тестовые условия определены');
  });

  it('leaves code and correct Russian untouched', () => {
    expect(p('const user = await getUser(id);')).toBe('const user = await getUser(id);');
    expect(p('ожидаемого результата нет')).toBe('ожидаемого результата нет');
  });

  it('does nothing for other target languages', () => {
    expect(TerminologyProcessor.process('условия испытаний', 'en', 'uk')).toBe('условия испытаний');
  });
});

describe('SentenceSegmenter.restorePunctuation', () => {
  const s = new SentenceSegmenter();

  it('does not corrupt code, paths or ellipses', () => {
    expect(s.restorePunctuation('for (let i = 0; i < n; i++) wait...')).toBe('for (let i = 0; i < n; i++) wait...');
    expect(s.restorePunctuation('for i in range of items')).toBe('for i in range of items');
    expect(s.restorePunctuation('run cd ../src and continue')).toBe('run cd ../src and continue');
  });

  it('does not invent questions or sentence breaks', () => {
    expect(s.restorePunctuation("i'll explain what is a variable in this video")).toBe(
      "I'll explain what is a variable in this video"
    );
    expect(s.restorePunctuation('and as you can see the result')).toBe('and as you can see the result');
  });

  it('adds the comma after an introductory phrase', () => {
    expect(s.restorePunctuation('in this video we will learn Git')).toBe('in this video, we will learn Git');
  });
});

describe('provider utils', () => {
  it('strips only quotes that wrap the whole answer', () => {
    expect(stripWrappingQuotes('Нажмите кнопку «Сохранить»')).toBe('Нажмите кнопку «Сохранить»');
    expect(stripWrappingQuotes('«Привет»')).toBe('Привет');
    expect(stripWrappingQuotes('"Привет"')).toBe('Привет');
    expect(stripWrappingQuotes('"a" и "b"')).toBe('"a" и "b"');
  });

  it('extracts plain text even if the model answered with JSON or a code fence', () => {
    expect(extractPlainTranslation('{"segments":[{"id":1,"start":0,"end":1,"text":"Привет"}]}')).toBe('Привет');
    expect(extractPlainTranslation('{"translation":"Привет"}')).toBe('Привет');
    expect(extractPlainTranslation('```\nПривет\n```')).toBe('Привет');
    expect(extractPlainTranslation('Используйте {id} в шаблоне')).toBe('Используйте {id} в шаблоне');
  });

  const segs = [
    { id: 1, start: 0, end: 1, text: 'one' },
    { id: 2, start: 1, end: 2, text: 'two' },
  ];

  it('maps batch answers by id; missing segments become empty, never the original', () => {
    const res = mapBatchResponse('{"segments":[{"id":2,"text":"два"}]}', segs, 'Test');
    expect(res.map((r) => r.text)).toEqual(['', 'два']);
    expect(res[0].start).toBe(0);
  });

  it('accepts JSON wrapped in a markdown fence', () => {
    const res = mapBatchResponse('```json\n{"segments":[{"id":1,"text":"один"},{"id":2,"text":"два"}]}\n```', segs, 'Test');
    expect(res.map((r) => r.text)).toEqual(['один', 'два']);
  });

  it('rejects unusable answers', () => {
    expect(() => mapBatchResponse('not json', segs, 'Test')).toThrow();
    expect(() => mapBatchResponse('{"segments":[]}', segs, 'Test')).toThrow();
    expect(() => mapBatchResponse('{"segments":[{"id":7,"text":"x"}]}', segs, 'Test')).toThrow();
    expect(() => mapBatchResponse('{"segments":[{"id":1,"text":"оди', segs, 'Test')).toThrow();
  });

  it('allows only https or localhost custom endpoints', () => {
    expect(isAllowedEndpoint('https://proxy.example.com/v1/chat/completions')).toBe(true);
    expect(isAllowedEndpoint('http://localhost:5000/translate')).toBe(true);
    expect(isAllowedEndpoint('http://example.com/translate')).toBe(false);
    expect(isAllowedEndpoint('javascript:alert(1)')).toBe(false);
  });

  it('maps HTTP errors to typed kinds', async () => {
    const kind = async (status: number, body = '{}') =>
      (await errorFromResponse(new Response(body, { status }), 'T')).kind;
    expect(await kind(429)).toBe('rate-limit');
    expect(await kind(401)).toBe('auth');
    expect(await kind(400, '{"error":{"message":"API key not valid"}}')).toBe('auth');
    expect(await kind(404)).toBe('not-found');
    expect(await kind(503)).toBe('server');
  });
});

describe('utils', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x2014; &unknown;')).toBe("a & b <c> 'd' — &unknown;");
  });

  it('identifies a lesson by path only', () => {
    expect(lessonKey('https://www.udemy.com/course/x/learn/lecture/1#overview')).toBe(
      lessonKey('https://www.udemy.com/course/x/learn/lecture/1?start=30#questions')
    );
    expect(lessonKey('https://www.udemy.com/course/x/learn/lecture/1')).not.toBe(
      lessonKey('https://www.udemy.com/course/x/learn/lecture/2')
    );
  });

  it('namespaces cache keys', () => {
    expect(makeCacheKey('en', 'ru', ' Hello  World ', 'gemini:m')).toBe('gemini:m|en:ru:hello world');
    expect(makeCacheKey('en', 'ru', 'x')).toBe('en:ru:x');
  });
});

describe('settings migration', () => {
  it('moves the legacy shared key/model into the active provider config', () => {
    const s = normalizeSettings({ translationProvider: 'openai', apiKey: 'sk-1', apiModel: 'gpt-4o' } as never);
    expect(getProviderConfig(s, 'openai')).toEqual({ apiKey: 'sk-1', apiEndpoint: '', apiModel: 'gpt-4o' });
    expect(getProviderConfig(s, 'gemini').apiKey).toBe('');
    expect((s as unknown as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('migrates retired Gemini models and the unsupported built-in provider', () => {
    const s = normalizeSettings({
      translationProvider: 'chrome-builtin',
      providerConfigs: { gemini: { apiKey: 'k', apiEndpoint: '', apiModel: 'gemini-2.0-flash' } },
    });
    expect(s.translationProvider).toBe('google-free');
    expect(s.providerConfigs.gemini!.apiModel).not.toContain('2.0');
  });
});

describe('SubtitleFormatter', () => {
  it('escapes HTML in subtitle text', () => {
    expect(SubtitleFormatter.formatHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});
