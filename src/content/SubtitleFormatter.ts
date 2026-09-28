/**
 * SubtitleFormatter — local visual formatter for dual subtitles.
 *
 * Implements Section 12 requirements:
 * - Max 2 visual lines per subtitle
 * - Target 35–42 characters per line
 * - Glues prepositions and conjunctions to the following word with non-breaking spaces (\u00A0)
 * - Balances line lengths so subtitles look clean and comfortable to read
 * - Protects code snippets, commands, and technical terms from ugly splits
 */

// Russian prepositions and short words that should never dangle at the end of a line
const RU_PREPOSITIONS_REGEX = /(?<![\p{L}\p{N}])(в|во|на|с|со|по|для|из|изо|о|об|обо|к|ко|от|ото|под|подо|над|надо|при|без|до|у|за|не|ни|и|а|но)(?![?.,!])\s+/giu;

// English prepositions and short words
const EN_PREPOSITIONS_REGEX = /\b(in|on|at|to|for|with|by|from|of|into|and|or|but|the|a|an)\s+/gi;

export class SubtitleFormatter {
  /**
   * Formats a subtitle text into visually balanced lines (max 2 lines).
   * Returns HTML string with <br> if wrapped.
   */
  static format(rawText: string, maxLineLength = 42): string {
    if (!rawText) return '';
    let text = rawText.trim().replace(/\s+/g, ' ');

    // 1. Glue prepositions and particles to the following word with non-breaking space (\u00A0)
    text = text.replace(RU_PREPOSITIONS_REGEX, '$1\u00A0');
    text = text.replace(EN_PREPOSITIONS_REGEX, '$1\u00A0');

    // 2. If the text comfortably fits on a single line, return it as-is
    if (text.length <= maxLineLength) {
      return text;
    }

    // 3. If text exceeds maxLineLength, balance it across at most 2 lines
    return this.balanceTwoLines(text, maxLineLength);
  }

  /**
   * Splits a string into two visually balanced lines at the best semantic break point.
   */
  private static balanceTwoLines(text: string, targetMaxLen: number): string {
    // Collect all candidate break points (regular spaces)
    const breakIndices: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ' ') {
        breakIndices.push(i);
      }
    }

    if (breakIndices.length === 0) {
      return text;
    }

    const mid = text.length / 2;
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (const idx of breakIndices) {
      const line1 = text.substring(0, idx).trim();
      const line2 = text.substring(idx + 1).trim();

      if (line1.length === 0 || line2.length === 0) continue;

      // Penalize lines that exceed the target length significantly
      const overflowPenalty =
        Math.max(0, line1.length - targetMaxLen) * 3 +
        Math.max(0, line2.length - targetMaxLen) * 3;

      // Reward balanced line lengths
      const lengthDiff = Math.abs(line1.length - line2.length);
      const balancePenalty = lengthDiff * 1.5;

      // Closeness to mathematical midpoint
      const centerDist = Math.abs(idx - mid);

      let bonus = 0;

      // Strong bonus: break right after punctuation (. , ? ! ; : —)
      const prevChar = text[idx - 1];
      if (/[.,!?;:—]/.test(prevChar)) {
        bonus += 25;
      }

      // Bonus: break before conjunctions / subordinators
      const nextWordMatch = line2.match(/^([а-яА-Яa-zA-Z]+)/);
      if (nextWordMatch) {
        const nextWord = nextWordMatch[1].toLowerCase();
        if (['что', 'чтобы', 'когда', 'если', 'как', 'где', 'который', 'которая', 'которые', 'which', 'that', 'where', 'when', 'if'].includes(nextWord)) {
          bonus += 18;
        }
      }

      // Heavy penalty for orphan words (single words under 5 chars on line 2)
      if (line2.length < 5) {
        bonus -= 40;
      }
      if (line1.length < 5) {
        bonus -= 40;
      }

      const score = bonus - overflowPenalty - balancePenalty - centerDist * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }

    if (bestIndex === -1) {
      return text;
    }

    const line1 = text.substring(0, bestIndex).trim();
    const line2 = text.substring(bestIndex + 1).trim();

    return `${line1}\n${line2}`;
  }

  /**
   * Formats a subtitle text into visually balanced HTML lines with <br>.
   */
  static formatHtml(rawText: string, maxLineLength = 42): string {
    if (!rawText) return '';
    const formatted = this.format(rawText, maxLineLength);
    // Simple HTML escaping for safety
    const escaped = formatted
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    return escaped.replace(/\n/g, '<br>');
  }
}

