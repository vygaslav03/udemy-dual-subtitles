/**
 * SentenceAssembler — merges consecutive subtitle cues into sentence units.
 *
 * A Udemy cue is often a fragment ("We need to configure" | "the server first."). Translating
 * fragments one by one loses context and word order, so cues are merged into units that are
 * translated and displayed as a whole, over the time span of their cues.
 *
 * Merging stops at a sentence end, a pause, or when the unit would get too long to read,
 * so every unit still fits in about two subtitle lines.
 */
import {
  UNIT_CLAUSE_SPLIT_CHARS,
  UNIT_MAX_CHARS,
  UNIT_MAX_DURATION_SEC,
  UNIT_MAX_GAP_SEC,
} from '../shared/constants';

export interface TimedText {
  startTime: number;
  endTime: number;
  text: string;
}

export interface AssembleOptions {
  maxGapSec: number;
  maxDurationSec: number;
  maxChars: number;
  clauseSplitChars: number;
}

const DEFAULT_OPTIONS: AssembleOptions = {
  maxGapSec: UNIT_MAX_GAP_SEC,
  maxDurationSec: UNIT_MAX_DURATION_SEC,
  maxChars: UNIT_MAX_CHARS,
  clauseSplitChars: UNIT_CLAUSE_SPLIT_CHARS,
};

/** ". ! ?" (optionally followed by closing quotes/brackets) — but not an ellipsis, which usually continues. */
export function endsSentence(text: string): boolean {
  return /(?<!\.\.)[.!?]["'»”)\]]*$/.test(text.trim());
}

/** Lines that look like code or a shell command are kept on their own. */
export function looksLikeCode(text: string): boolean {
  return /[{};]\s*$|=>|\(\s*\)|^\s*(\$|>|npm |git |docker |kubectl |cd |ls )/.test(text);
}

export function assembleUnits<T extends TimedText>(cues: T[], options: Partial<AssembleOptions> = {}): TimedText[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const units: TimedText[] = [];
  let current: TimedText | null = null;

  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;

    if (current && canMerge(current, { startTime: cue.startTime, endTime: cue.endTime, text }, opts)) {
      current.text = `${current.text} ${text}`;
      current.endTime = Math.max(current.endTime, cue.endTime);
      continue;
    }

    if (current) units.push(current);
    current = { startTime: cue.startTime, endTime: cue.endTime, text };
  }

  if (current) units.push(current);
  return units;
}

function canMerge(unit: TimedText, next: TimedText, opts: AssembleOptions): boolean {
  if (endsSentence(unit.text)) return false;
  if (next.startTime - unit.endTime > opts.maxGapSec) return false;
  if (next.endTime - unit.startTime > opts.maxDurationSec) return false;
  if (unit.text.length + 1 + next.text.length > opts.maxChars) return false;
  // A long clause that ends with a comma/colon/dash is a natural place to split a long sentence.
  if (/[,;:—–]$/.test(unit.text) && unit.text.length >= opts.clauseSplitChars) return false;
  if (looksLikeCode(unit.text) || looksLikeCode(next.text)) return false;
  return true;
}

/**
 * Binary search for the item active at `time` (items sorted by startTime, possibly overlapping).
 */
export function findActiveIndex(items: TimedText[], time: number): number {
  let low = 0;
  let high = items.length - 1;
  let lastStarted = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (items[mid].startTime <= time) {
      lastStarted = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // Overlapping cues: look back a few items for one that is still running.
  for (let i = lastStarted; i >= 0 && i >= lastStarted - 3; i--) {
    if (time <= items[i].endTime) return i;
  }
  return -1;
}

/** Index of the first item starting after `time`, or -1. */
export function findUpcomingIndex(items: TimedText[], time: number): number {
  let low = 0;
  let high = items.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (items[mid].startTime > time) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}
