/**
 * Tests for the batch translation pipeline, cue grouper, subtitle formatter,
 * queue prioritization, and the 10 specific test cases from Section 18.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CueGrouper } from '../src/content/CueGrouper';
import { SubtitleFormatter } from '../src/content/SubtitleFormatter';
import { TerminologyProcessor } from '../src/translation/TerminologyProcessor';
import { TranslationManager } from '../src/translation/TranslationManager';
import {
  getBatchSubtitleSystemPrompt,
  buildBatchSubtitleUserPrompt,
} from '../src/translation/promptTemplates';
import type { BatchTranslationRequest } from '../src/shared/types';
import type { TranslationProvider } from '../src/translation/TranslationProvider';
import type { ParsedCue } from '../src/content/VTTPreFetcher';

describe('Section 18 Test Cases & Batch Pipeline', () => {
  // -------------------------------------------------------------
  // Case 1: One sentence across multiple cues
  // -------------------------------------------------------------
  it('Case 1: groups one sentence across multiple consecutive cues into a cohesive batch', () => {
    const cues: ParsedCue[] = [
      { startTime: 10.0, endTime: 11.5, text: "Today we're going to" },
      { startTime: 11.5, endTime: 13.0, text: 'talk about APIs' },
      { startTime: 13.0, endTime: 14.5, text: 'and how they work.' },
    ];

    const groups = CueGrouper.groupAll(cues, 3.0, 10.0, 5);
    expect(groups.length).toBe(1);
    expect(groups[0].segments.length).toBe(3);
    expect(groups[0].segments.map((s) => s.text).join(' ')).toBe(
      "Today we're going to talk about APIs and how they work."
    );

    const userPrompt = buildBatchSubtitleUserPrompt({
      segments: groups[0].segments,
      previousContext: groups[0].previousContext,
      nextContext: groups[0].nextContext,
      source: 'en',
      target: 'ru',
    });
    expect(userPrompt).toContain("Today we're going to");
    expect(userPrompt).toContain('talk about APIs');
    expect(userPrompt).toContain('and how they work.');
  });

  // -------------------------------------------------------------
  // Case 2: Question across cues
  // -------------------------------------------------------------
  it('Case 2: correctly groups question cues and passes question punctuation', () => {
    const cues: ParsedCue[] = [
      { startTime: 20.0, endTime: 21.5, text: 'What happens' },
      { startTime: 21.5, endTime: 23.5, text: 'when the server crashes?' },
    ];

    const groups = CueGrouper.groupAll(cues, 2.0, 10.0, 5);
    expect(groups.length).toBe(1);
    expect(groups[0].segments.length).toBe(2);

    const fullPrompt = buildBatchSubtitleUserPrompt({
      segments: groups[0].segments,
      source: 'en',
      target: 'ru',
    });
    expect(fullPrompt).toContain('when the server crashes?');
  });

  // -------------------------------------------------------------
  // Case 3: Technical command preservation
  // -------------------------------------------------------------
  it('Case 3: preserves technical command systemctl restart nginx.service verbatim', () => {
    const systemPrompt = getBatchSubtitleSystemPrompt();
    // Rule 10 mandates preserving commands, code, filenames
    expect(systemPrompt).toContain('Never translate or alter code, commands, URLs, file names');

    // Terminology check
    const textWithCommand = 'Теперь выполните systemctl restart nginx.service.';
    const processed = TerminologyProcessor.process(textWithCommand);
    expect(processed).toContain('systemctl restart nginx.service');
  });

  // -------------------------------------------------------------
  // Case 4: Continuing sentence without trailing periods
  // -------------------------------------------------------------
  it('Case 4: prompt rules explicitly prohibit periods on continuing cues', () => {
    const systemPrompt = getBatchSubtitleSystemPrompt();
    expect(systemPrompt).toContain('If a segment continues in the next one, do not end it with a period');
    expect(systemPrompt).toContain('end a finished thought with . ? or !');

    const cues: ParsedCue[] = [
      { startTime: 1.0, endTime: 2.5, text: "If you don't do this," },
      { startTime: 2.5, endTime: 4.0, text: 'the application' },
      { startTime: 4.0, endTime: 5.5, text: 'will not work.' },
    ];

    const groups = CueGrouper.groupAll(cues);
    expect(groups.length).toBe(1);
    // Segment 1 ends with comma, Segment 2 has no end punctuation, Segment 3 ends with period
    expect(groups[0].segments[0].text.endsWith(',')).toBe(true);
    expect(/[.!?]$/.test(groups[0].segments[1].text)).toBe(false);
    expect(groups[0].segments[2].text.endsWith('.')).toBe(true);
  });

  // -------------------------------------------------------------
  // Case 5: Long sentence readability and visual formatting
  // -------------------------------------------------------------
  it('Case 5: SubtitleFormatter splits long sentences into max 2 balanced lines without dangling prepositions', () => {
    const longRussianText =
      'В этом практическом уроке мы подробно рассмотрим архитектуру микросервисов для высоконагруженных систем';
    const formatted = SubtitleFormatter.format(longRussianText, 45);

    const lines = formatted.split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
    // Neither line should end with a lone Russian preposition like 'для' or 'в'
    expect(lines[0]).not.toMatch(/\s(в|для|на|с|о)$/i);
    // Glued with non-breaking space
    expect(formatted).toContain('\u00A0');
  });

  // -------------------------------------------------------------
  // Case 6: Code preservation
  // -------------------------------------------------------------
  it('Case 6: code const user = await getUser(id); is protected in prompt and terminology processor', () => {
    const systemPrompt = getBatchSubtitleSystemPrompt();
    expect(systemPrompt).toContain('identifiers');

    const code = 'const user = await getUser(id);';
    const processed = TerminologyProcessor.process(code);
    expect(processed).toBe(code);
  });

  // -------------------------------------------------------------
  // Case 7: Fast speech / short timestamps
  // -------------------------------------------------------------
  it('Case 7: CueGrouper respects cue timestamps and maps them 1:1', () => {
    const fastCues: ParsedCue[] = [
      { startTime: 5.0, endTime: 5.8, text: 'Fast cue one' },
      { startTime: 5.8, endTime: 6.4, text: 'Fast cue two' },
    ];

    const batch = CueGrouper.createBatchAtTime(fastCues, 5.2, 'en', 'ru');
    expect(batch).not.toBeNull();
    expect(batch!.segments[0].start).toBe(5.0);
    expect(batch!.segments[0].end).toBe(5.8);
    expect(batch!.segments[1].start).toBe(5.8);
    expect(batch!.segments[1].end).toBe(6.4);
  });

  // -------------------------------------------------------------
  // Case 8: Cache deduplication (same subtitle triggers no second API call)
  // -------------------------------------------------------------
  it('Case 8: TranslationManager returns cached result without calling provider', async () => {
    const mockProvider: TranslationProvider = {
      name: 'gemini',
      type: 'gemini',
      requiresApiKey: true,
      isLlm: true,
      cacheNamespace: 'gemini:test',
      configure: vi.fn(),
      translate: vi.fn().mockResolvedValue('Переведённый текст'),
      translateBatch: vi.fn().mockResolvedValue([
        { id: 1, start: 0, end: 2, text: 'Переведённый текст' },
      ]),
    };

    const manager = new TranslationManager(2, 50, 1);
    // Override provider and cache directly
    (manager as any).provider = mockProvider;
    (manager as any).cache.get = vi.fn().mockResolvedValue(null);
    (manager as any).cache.set = vi.fn().mockResolvedValue(undefined);

    const req: BatchTranslationRequest = {
      segments: [{ id: 1, start: 0, end: 2, text: 'Cached subtitle test' }],
      source: 'en',
      target: 'ru',
    };

    // First call -> calls provider
    const res1 = await manager.translateBatch(req);
    expect(res1.segments[0].text).toBe('Переведённый текст');
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1);

    // Second call with same text -> cache hit, provider NOT called again
    const res2 = await manager.translateBatch(req);
    expect(res2.segments[0].text).toBe('Переведённый текст');
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1); // Still 1!
  });

  // -------------------------------------------------------------
  // Case 9: Prefetch upcoming batches
  // -------------------------------------------------------------
  it('Case 9: CueGrouper.groupAll partitions timeline into sequential batches suitable for prefetch', () => {
    const cues: ParsedCue[] = [
      { startTime: 0.0, endTime: 3.0, text: 'First batch cue 1' },
      { startTime: 3.0, endTime: 6.0, text: 'First batch cue 2.' },
      { startTime: 6.0, endTime: 9.0, text: 'Second batch cue 1' },
      { startTime: 9.0, endTime: 12.0, text: 'Second batch cue 2.' },
    ];

    const groups = CueGrouper.groupAll(cues, 3.0, 7.0, 3);
    expect(groups.length).toBe(2);
    // Second group has previousContext from the first group!
    expect(groups[1].previousContext.length).toBeGreaterThan(0);
    expect(groups[1].previousContext[groups[1].previousContext.length - 1]).toBe('First batch cue 2.');
  });

  // -------------------------------------------------------------
  // Case 10: Seek handling (clearing queued prefetch jobs)
  // -------------------------------------------------------------
  it('Case 10: cancelPending rejects queued low-priority prefetch jobs while preserving high-priority requests', async () => {
    const manager = new TranslationManager(1, 50, 1);

    let slowResolve: () => void;
    const slowProvider: TranslationProvider = {
      name: 'gemini',
      type: 'gemini',
      requiresApiKey: true,
      isLlm: true,
      cacheNamespace: 'gemini:test',
      configure: vi.fn(),
      translate: vi.fn(),
      translateBatch: vi.fn().mockImplementation((req: BatchTranslationRequest) => {
        if (req.segments[0]?.text === 'Active job') {
          return new Promise((resolve) => {
            slowResolve = () =>
              resolve(
                req.segments.map((s) => ({
                  id: s.id,
                  start: s.start,
                  end: s.end,
                  text: 'Перевод активной работы',
                }))
              );
          });
        }
        return Promise.resolve(
          req.segments.map((s) => ({
            id: s.id,
            start: s.start,
            end: s.end,
            text: `Перевод ${s.text}`,
          }))
        );
      }),
    };
    (manager as any).provider = slowProvider;
    (manager as any).cache.get = vi.fn().mockResolvedValue(null);
    (manager as any).cache.set = vi.fn().mockResolvedValue(undefined);

    // Enqueue an active job (will occupy concurrency slot 1)
    const activePromise = manager.translateBatch({
      segments: [{ id: 1, start: 0, end: 2, text: 'Active job' }],
      source: 'en',
      target: 'ru',
      priority: 'high',
    });

    // Enqueue low-priority prefetch job (will sit in batchQueue)
    const prefetchPromise = manager.translateBatch({
      segments: [{ id: 2, start: 100, end: 102, text: 'Prefetch job 1' }],
      source: 'en',
      target: 'ru',
      priority: 'low',
    });

    // Enqueue high-priority current job (will sit at front of batchQueue)
    const currentPromise = manager.translateBatch({
      segments: [{ id: 3, start: 500, end: 502, text: 'Seek target job' }],
      source: 'en',
      target: 'ru',
      priority: 'high',
    });

    // Yield so async cache checks finish and jobs enter the batch queue
    await new Promise((r) => setTimeout(r, 20));

    // User jumps in video -> cancel low-priority prefetch
    manager.cancelPending('low');

    // Prefetch job is rejected as cancelled — it must NOT resolve with the English original
    await expect(prefetchPromise).rejects.toMatchObject({ kind: 'cancelled' });
    expect(slowProvider.translateBatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ segments: [expect.objectContaining({ text: 'Prefetch job 1' })] })
    );

    // Resolve active slow request so high-priority seek job executes immediately
    slowResolve!();

    const activeRes = await activePromise;
    expect(activeRes.segments[0].text).toBe('Перевод активной работы');

    const currentRes = await currentPromise;
    expect(currentRes.segments[0].text).toBe('Перевод Seek target job');
  });
});

describe('SubtitleFormatter formatting rules', () => {
  it('attaches short Russian prepositions with non-breaking space', () => {
    const input = 'Мы перейдем к следующей теме в нашем курсе.';
    const formatted = SubtitleFormatter.format(input);
    expect(formatted).toContain('к\u00A0следующей');
    expect(formatted).toContain('в\u00A0нашем');
  });

  it('formats to HTML with safe escaping and <br>', () => {
    const input = 'Первая длинная строка субтитра которая обязательно должна переноситься на вторую строку';
    const html = SubtitleFormatter.formatHtml(input, 40);
    expect(html).toContain('<br>');
    expect(html).not.toContain('<script>');
  });
});

describe('TerminologyProcessor IT QA terminology corrections', () => {
  it('corrects literal QA terms to professional IT terminology', () => {
    const input = 'Мы создадим дело для испытаний чтобы проверить условия испытаний.';
    const result = TerminologyProcessor.process(input);
    expect(result).toContain('тест-кейс');
    expect(result).toContain('тестовые условия');
  });

  it('corrects branch, commit, endpoint context', () => {
    expect(TerminologyProcessor.process('новая branch в git')).toContain('ветка');
  });
});
