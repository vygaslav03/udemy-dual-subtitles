/**
 * WebVTT parser (pure, DOM-free).
 */
import { cleanCueText } from '../shared/utils';
import type { TimedText } from './SentenceAssembler';

const TIMING_REGEX = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/;

/**
 * Parses WebVTT text into cues sorted by start time.
 * Cue settings, identifiers, NOTE/STYLE blocks and tags are ignored; entities are decoded.
 */
export function parseWebVTT(vttText: string): TimedText[] {
  const lines = vttText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: TimedText[] = [];

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(TIMING_REGEX);
    i++;
    if (!match) continue;

    const startTime = parseTimestamp(match[1]);
    const endTime = parseTimestamp(match[2]);

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i].trim());
      i++;
    }

    const text = cleanCueText(textLines.join(' '));
    if (text && endTime > startTime) {
      cues.push({ startTime, endTime, text });
    }
  }

  return cues.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Converts a WebVTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) to seconds.
 */
export function parseTimestamp(timeStr: string): number {
  const parts = timeStr.replace(',', '.').split(':').map(parseFloat);
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
