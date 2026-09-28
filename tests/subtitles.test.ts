/**
 * Subtitle processing: WebVTT parser, sentence units, timeline search, track selection.
 */
import { describe, it, expect } from 'vitest';
import { parseWebVTT, parseTimestamp } from '../src/subtitles/VttParser';
import {
  assembleUnits,
  endsSentence,
  findActiveIndex,
  findUpcomingIndex,
  looksLikeCode,
} from '../src/subtitles/SentenceAssembler';
import { pickSourceTrack } from '../src/subtitles/trackSelection';
import { CueGrouper } from '../src/content/CueGrouper';

describe('parseWebVTT', () => {
  it('parses cues with identifiers, settings, NOTE blocks, BOM and CRLF', () => {
    const vtt =
      '﻿WEBVTT\r\n\r\nNOTE this is a comment\r\n\r\n1\r\n00:00:01.000 --> 00:00:02.500 align:start position:10%\r\nHello\r\nworld\r\n\r\n2\r\n00:03.000 --> 00:04.000\r\nSecond cue\r\n';
    expect(parseWebVTT(vtt)).toEqual([
      { startTime: 1, endTime: 2.5, text: 'Hello world' },
      { startTime: 3, endTime: 4, text: 'Second cue' },
    ]);
  });

  it('decodes entities and strips voice/class tags', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n<v Instructor>Tom &amp; Jerry use a &lt;div&gt; tag</v> <c.yellow>&#8212; ok</c>\n';
    expect(parseWebVTT(vtt)[0].text).toBe('Tom & Jerry use a <div> tag — ok');
  });

  it('keeps code, quotes, ellipsis and numbers intact', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nconst user = await getUser(id); "quoted"... 3.14\n';
    expect(parseWebVTT(vtt)[0].text).toBe('const user = await getUser(id); "quoted"... 3.14');
  });

  it('sorts out-of-order cues and drops empty or inverted cues', () => {
    const vtt =
      'WEBVTT\n\n00:05.000 --> 00:06.000\nlater\n\n00:01.000 --> 00:02.000\nearlier\n\n00:03.000 --> 00:04.000\n\n00:08.000 --> 00:07.000\ninverted\n';
    expect(parseWebVTT(vtt).map((c) => c.text)).toEqual(['earlier', 'later']);
  });

  it('handles garbage input without throwing', () => {
    expect(parseWebVTT('not a vtt file at all')).toEqual([]);
    expect(parseWebVTT('')).toEqual([]);
  });

  it('parses timestamps with hours, comma separator and long hours', () => {
    expect(parseTimestamp('01:02:03.500')).toBe(3723.5);
    expect(parseTimestamp('02:03,250')).toBe(123.25);
    expect(parseTimestamp('100:00:00.000')).toBe(360000);
  });
});

describe('assembleUnits (sentence units)', () => {
  const cue = (startTime: number, endTime: number, text: string) => ({ startTime, endTime, text });

  it('merges fragments of one sentence into one unit spanning their time', () => {
    const units = assembleUnits([
      cue(10, 11.5, "Today we're going to"),
      cue(11.5, 13, 'talk about APIs'),
      cue(13, 14.5, 'and how they work.'),
      cue(14.6, 16, 'Next topic.'),
    ]);
    expect(units).toEqual([
      { startTime: 10, endTime: 14.5, text: "Today we're going to talk about APIs and how they work." },
      { startTime: 14.6, endTime: 16, text: 'Next topic.' },
    ]);
  });

  it('does not merge across a pause', () => {
    const units = assembleUnits([cue(0, 1, 'first part'), cue(3, 4, 'after a pause')]);
    expect(units).toHaveLength(2);
  });

  it('splits very long sentences so a unit stays readable', () => {
    const cues = Array.from({ length: 8 }, (_, i) => cue(i, i + 1, 'this sentence keeps going on and on'));
    const units = assembleUnits(cues);
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) {
      expect(u.text.length).toBeLessThanOrEqual(110);
      expect(u.endTime - u.startTime).toBeLessThanOrEqual(7);
    }
  });

  it('keeps code lines on their own', () => {
    const units = assembleUnits([cue(0, 1, 'now type'), cue(1, 2, 'const user = await getUser();'), cue(2, 3, 'and run it.')]);
    expect(units.map((u) => u.text)).toContain('const user = await getUser();');
  });

  it('treats an ellipsis as a continuation, not a sentence end', () => {
    expect(endsSentence('so...')).toBe(false);
    expect(endsSentence('done.')).toBe(true);
    expect(endsSentence('really?"')).toBe(true);
    expect(looksLikeCode('npm install express')).toBe(true);
    expect(looksLikeCode('we install it')).toBe(false);
  });

  it('keeps cues unchanged when there is nothing to merge', () => {
    const cues = [cue(0, 1, 'One.'), cue(1, 2, 'Two.')];
    expect(assembleUnits(cues)).toEqual(cues);
  });
});

describe('timeline search', () => {
  const items = [
    { startTime: 0, endTime: 2, text: 'a' },
    { startTime: 2, endTime: 4, text: 'b' },
    { startTime: 6, endTime: 8, text: 'c' },
  ];

  it('finds the active item, including boundaries and gaps', () => {
    expect(findActiveIndex(items, 1)).toBe(0);
    expect(findActiveIndex(items, 3)).toBe(1);
    expect(findActiveIndex(items, 5)).toBe(-1);
    expect(findActiveIndex(items, 9)).toBe(-1);
    expect(findActiveIndex([], 1)).toBe(-1);
  });

  it('finds overlapping cues', () => {
    const overlapping = [
      { startTime: 0, endTime: 10, text: 'long' },
      { startTime: 1, endTime: 2, text: 'short' },
    ];
    expect(findActiveIndex(overlapping, 5)).toBe(0);
  });

  it('finds the upcoming item', () => {
    expect(findUpcomingIndex(items, 4.5)).toBe(2);
    expect(findUpcomingIndex(items, 7)).toBe(-1);
  });
});

describe('CueGrouper.createBatchAtTime', () => {
  it('includes the unfinished previous item and stops at a sentence end', () => {
    const items = [
      { startTime: 0, endTime: 1, text: 'If you do not do this,' },
      { startTime: 1, endTime: 2, text: 'the application' },
      { startTime: 2, endTime: 3, text: 'will not work.' },
      { startTime: 3, endTime: 4, text: 'Another sentence.' },
    ];
    const batch = CueGrouper.createBatchAtTime(items, 1.5, 'en', 'ru');
    expect(batch!.segments.map((s) => s.text)).toEqual(['If you do not do this,', 'the application', 'will not work.']);
    expect(batch!.nextContext).toEqual(['Another sentence.']);
  });
});

describe('pickSourceTrack', () => {
  it('prefers a human English track over an auto-generated one', () => {
    const index = pickSourceTrack(
      [
        { kind: 'subtitles', language: 'en', label: 'English [Auto]' },
        { kind: 'subtitles', language: 'en', label: 'English' },
      ],
      'en'
    );
    expect(index).toBe(1);
  });

  it('never picks an auto-generated track of another language', () => {
    const index = pickSourceTrack(
      [
        { kind: 'subtitles', language: 'es', label: 'Español [Auto]' },
        { kind: 'subtitles', language: '', label: 'English [Auto]' },
      ],
      'en'
    );
    expect(index).toBe(1);
  });

  it('returns -1 when no track is in the source language', () => {
    expect(pickSourceTrack([{ kind: 'subtitles', language: 'fr', label: 'Français' }], 'en')).toBe(-1);
  });

  it('skips metadata tracks and accepts a single unlabeled subtitle track', () => {
    expect(
      pickSourceTrack(
        [
          { kind: 'metadata', language: '', label: 'thumbnails' },
          { kind: 'subtitles', language: '', label: '' },
        ],
        'en'
      )
    ).toBe(1);
  });
});

import { cueMatchesText, isMatchingCaptionFile, isVttResourceUrl } from '../src/subtitles/vttMatching';

describe('caption file matching (player without <track>)', () => {
  const cues = [
    { startTime: 10, endTime: 12, text: "Today we're going to talk about APIs." },
    { startTime: 12, endTime: 14, text: 'Let’s start with REST.' },
    { startTime: 590, endTime: 595, text: 'See you in the next lecture.' },
  ];

  it('matches the caption on screen near the current time, ignoring punctuation and case', () => {
    expect(isMatchingCaptionFile(cues, "today we're going to talk about APIs", 11, 600)).toBe(true);
    expect(cueMatchesText('Let’s start with REST.', 'Let’s start with REST')).toBe(true);
  });

  it('rejects the right text at the wrong time (another lesson using the same phrase)', () => {
    expect(isMatchingCaptionFile(cues, 'Let’s start with REST.', 300, 600)).toBe(false);
  });

  it('rejects a file in another language', () => {
    expect(isMatchingCaptionFile(cues, 'Hoy vamos a hablar de APIs.', 11, 600)).toBe(false);
  });

  it('rejects a partial file (HLS segment) that does not cover the video', () => {
    expect(isMatchingCaptionFile(cues.slice(0, 2), "Today we're going to talk about APIs.", 11, 600)).toBe(false);
  });

  it('accepts only Udemy subtitle URLs', () => {
    expect(isVttResourceUrl('https://vtt-c.udemycdn.com/123/en_US/2024.vtt?Expires=1&Signature=x')).toBe(true);
    expect(isVttResourceUrl('https://vtt-c.udemycdn.com/thumb-sprites.vtt')).toBe(false);
    expect(isVttResourceUrl('https://evil.example.com/a.vtt')).toBe(false);
    expect(isVttResourceUrl('https://www.udemy.com/api/captions.json')).toBe(false);
  });
});
