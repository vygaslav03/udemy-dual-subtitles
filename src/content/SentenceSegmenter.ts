/**
 * SentenceSegmenter — light, conservative clean-up of English caption text before translation.
 *
 * Used only in DOM-only mode (no VTT timeline), when "Restore punctuation" is enabled.
 * The displayed original is never modified. Rules that guessed sentence structure (inserting
 * question marks, splitting sentences at phrases, commas before conjunctions, collapsing "...")
 * were removed: they corrupted code and changed meaning more often than they helped.
 */

// Common introductory clauses at the very start of a caption that take a comma
const INTRODUCTORY_PATTERNS: RegExp[] = [
  /^(before we start|before we begin|before jumping in)(?=\s+\w)(?![!?,.:])/i,
  /^(by the end of this (?:course|lesson|section|video))(?=\s+\w)(?![!?,.:])/i,
  /^(in this (?:video|lecture|section|course))(?=\s+\w)(?![!?,.:])/i,
  /^(for example|for instance|in other words|first of all|having said that)(?=\s+\w)(?![!?,.:])/i,
  /^(as you know|as we discussed|as mentioned earlier)(?=\s+\w)(?![!?,.:])/i,
];

export class SentenceSegmenter {
  /**
   * Restores obvious punctuation/capitalization on speech-to-text English.
   */
  restorePunctuation(rawText: string): string {
    let text = rawText.trim().replace(/\s+/g, ' ');
    if (!text) return '';

    // Standalone pronoun "i" / "i'm" in prose ("i think", "i'll show"),
    // never in code ("i = 0", "i++", "i < n", "for i in range").
    text = text.replace(/(^|\s)i(?=\s+[a-z])(?!\s+in\b)/g, '$1I');
    text = text.replace(/(^|\s)i('m|'ll|'ve|'d)(?=\s|$)/g, '$1I$2');

    // Introductory phrase comma (only at the start of the caption)
    for (const regex of INTRODUCTORY_PATTERNS) {
      text = text.replace(regex, '$1,');
    }

    // Duplicate "!!" / "??" and ", ," — but keep "..." (ellipsis) and "../" (paths)
    text = text.replace(/([!?])\1+/g, '$1');
    text = text.replace(/,\s*,/g, ',');

    return text.trim();
  }
}
