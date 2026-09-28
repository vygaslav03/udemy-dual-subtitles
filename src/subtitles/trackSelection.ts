/**
 * Picks the subtitle track in the source language among <track> elements or TextTracks.
 */
import { SUPPORTED_LANGUAGES } from '../shared/constants';

export interface TrackInfo {
  kind: string;
  language: string;
  label: string;
}

const NON_SUBTITLE_KINDS = new Set(['metadata', 'chapters', 'descriptions']);

/**
 * Returns the index of the best track for `sourceLang`, or -1.
 *
 * - language code match beats a label match ("English", "English [Auto]")
 * - human captions beat auto-generated ones
 * - another language is never picked, except when it is the only subtitle track
 *   and carries no language information at all
 */
export function pickSourceTrack(tracks: TrackInfo[], sourceLang: string): number {
  const lang = sourceLang.toLowerCase();
  const langName = (SUPPORTED_LANGUAGES.find((l) => l.code === lang)?.name || lang).toLowerCase();

  let bestIndex = -1;
  let bestScore = 0;
  const candidates: number[] = [];

  tracks.forEach((track, index) => {
    if (NON_SUBTITLE_KINDS.has(track.kind)) return;
    candidates.push(index);

    const trackLang = (track.language || '').toLowerCase();
    const label = (track.label || '').toLowerCase();
    const isAuto = /\bauto\b|auto-generated|автомат/.test(label);

    let score = 0;
    if (trackLang === lang || trackLang.startsWith(`${lang}-`)) score = 4;
    else if (label.includes(langName)) score = 2;
    if (score > 0 && !isAuto) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestIndex !== -1) return bestIndex;

  if (candidates.length === 1) {
    const only = tracks[candidates[0]];
    if (!only.language && !only.label) return candidates[0];
  }
  return -1;
}
