/**
 * CueGrouper — groups consecutive subtitle units (sentence units or raw cues) into
 * translation batches with surrounding context.
 *
 * - groupAll: large windows for prefetch (fewer requests, the system prompt is paid once per window)
 * - createBatchAtTime: a small batch around the playback position for the live display
 */
import type { LanguageCode, SubtitleSegment, BatchTranslationRequest, BatchPriority } from '../shared/types';
import type { TimedText } from '../subtitles/SentenceAssembler';
import { endsSentence, findActiveIndex, findUpcomingIndex } from '../subtitles/SentenceAssembler';

export interface CueGroup {
  segments: SubtitleSegment[];
  previousContext: string[];
  nextContext: string[];
  startTime: number;
  endTime: number;
}

const CONTEXT_ITEMS = 2;

function toSegments(items: TimedText[]): SubtitleSegment[] {
  return items.map((c, idx) => ({ id: idx + 1, start: c.startTime, end: c.endTime, text: c.text }));
}

function contextAround(items: TimedText[], firstIndex: number, lastIndex: number) {
  return {
    previousContext: items.slice(Math.max(0, firstIndex - CONTEXT_ITEMS), firstIndex).map((c) => c.text),
    nextContext: items.slice(lastIndex + 1, lastIndex + 1 + CONTEXT_ITEMS).map((c) => c.text),
  };
}

export class CueGrouper {
  /**
   * Partitions the whole timeline into consecutive batches.
   * A batch closes at `maxItemsPerBatch`, at `maxDurationSec`, or — once it lasts `minDurationSec` —
   * at a sentence end or a pause.
   */
  static groupAll(
    items: TimedText[],
    minDurationSec = 4.0,
    maxDurationSec = 10.0,
    maxItemsPerBatch = 5
  ): CueGroup[] {
    if (!items || items.length === 0) return [];

    const groups: CueGroup[] = [];
    let firstIndex = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const batchDuration = item.endTime - items[firstIndex].startTime;
      const next = items[i + 1];
      const hasPauseAfter = next ? next.startTime - item.endTime > 1.2 : true;
      const count = i - firstIndex + 1;

      const shouldClose =
        count >= maxItemsPerBatch ||
        batchDuration >= maxDurationSec ||
        (batchDuration >= minDurationSec && (endsSentence(item.text) || hasPauseAfter)) ||
        i === items.length - 1;

      if (shouldClose) {
        const batch = items.slice(firstIndex, i + 1);
        groups.push({
          segments: toSegments(batch),
          ...contextAround(items, firstIndex, i),
          startTime: items[firstIndex].startTime,
          endTime: item.endTime,
        });
        firstIndex = i + 1;
      }
    }

    return groups;
  }

  /**
   * Creates a small batch around the playback position: the active item (or the next one),
   * the previous item if it is an unfinished sentence, and following items up to a sentence end.
   */
  static createBatchAtTime(
    items: TimedText[],
    currentTime: number,
    source: LanguageCode,
    target: LanguageCode,
    priority: BatchPriority = 'high',
    maxItems = 4
  ): BatchTranslationRequest | null {
    if (!items || items.length === 0) return null;

    let activeIdx = findActiveIndex(items, currentTime);
    if (activeIdx === -1) activeIdx = findUpcomingIndex(items, currentTime);
    if (activeIdx === -1) activeIdx = items.length - 1;

    let startIdx = activeIdx;
    if (startIdx > 0 && !endsSentence(items[startIdx - 1].text)) {
      startIdx--;
    }

    let endIdx = startIdx;
    while (endIdx < items.length - 1 && endIdx - startIdx + 1 < maxItems) {
      const count = endIdx - startIdx + 1;
      const duration = items[endIdx].endTime - items[startIdx].startTime;
      if (endIdx >= activeIdx && count >= 2 && (duration >= 6.0 || endsSentence(items[endIdx].text))) break;
      endIdx++;
    }

    return {
      segments: toSegments(items.slice(startIdx, endIdx + 1)),
      ...contextAround(items, startIdx, endIdx),
      source,
      target,
      priority,
    };
  }
}
