/**
 * Subtitle translation prompts for LLM providers (Gemini, OpenAI).
 *
 * - Batch: JSON in / JSON out ({ "segments": [{ id, text }] }). Timestamps are NOT sent:
 *   timing always comes from the source VTT, so echoing it would only cost tokens.
 * - Single: plain text in / plain text out (selection translation, word tooltip, DOM-only mode).
 * - Language-specific guidance (form of address, IT terminology, example) is added only for
 *   the target language it is written for.
 *
 * Bump PROMPT_VERSION (shared/constants.ts) whenever these prompts change.
 */
import type { BatchTranslationRequest, LanguageCode } from '../shared/types';
import { SUPPORTED_LANGUAGES } from '../shared/constants';

export function languageName(code: LanguageCode): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name || code;
}

interface TargetGuide {
  /** Form of address / tone */
  tone: string;
  /** Established IT terms in this language */
  terms: string;
  /** Translations of EXAMPLE_INPUT */
  example: [string, string];
}

const EXAMPLE_INPUT: [string, string] = ['We need to configure the server first.', 'After that we can deploy the application.'];

const TARGET_GUIDES: Partial<Record<LanguageCode, TargetGuide>> = {
  ru: {
    tone: 'Address the viewer politely ("вы") or use impersonal constructions ("нужно", "можно") where that sounds more natural.',
    terms: 'branch → ветка, pull request, commit, deploy → развернуть/деплой, endpoint, test case → тест-кейс, pipeline → пайплайн',
    example: ['Сначала нужно настроить сервер.', 'После этого можно развернуть приложение.'],
  },
  uk: {
    tone: 'Address the viewer politely ("ви") or use impersonal constructions ("потрібно", "можна") where that sounds more natural.',
    terms: 'branch → гілка, pull request, commit, deploy → розгорнути/деплой, endpoint, test case → тест-кейс, pipeline → пайплайн',
    example: ['Спочатку потрібно налаштувати сервер.', 'Після цього можна розгорнути застосунок.'],
  },
};

function styleRules(target: LanguageCode): string {
  const name = languageName(target);
  const guide = TARGET_GUIDES[target];
  return [
    `- Translate by meaning, not word-for-word. Use the word order and constructions that are natural in ${name}.`,
    `- Keep the speaker's conversational tone.${guide ? ` ${guide.tone}` : ''}`,
    guide
      ? `- Keep established IT terms in their standard industry form (${guide.terms}).`
      : `- Keep established IT terms in the form ${name}-speaking developers use; leave English terms as they are where that is the industry norm.`,
    '- Never translate or alter code, commands, URLs, file names, identifiers or product names (e.g. `npm install`, `const user = await getUser(id)`, Docker, Kubernetes).',
    '- Fix obvious speech-recognition errors when the intended meaning is clear. Do not add or drop information.',
    `- Use correct ${name} punctuation.`,
  ].join('\n');
}

function batchExample(target: LanguageCode): string {
  const input = JSON.stringify(EXAMPLE_INPUT.map((text, i) => ({ id: i + 1, text })));
  const translations = TARGET_GUIDES[target]?.example ?? [
    `<${languageName(target)} translation of segment 1>`,
    `<${languageName(target)} translation of segment 2>`,
  ];
  const output = JSON.stringify({ segments: translations.map((text, i) => ({ id: i + 1, text })) });
  return `Input: ${input}\nOutput: ${output}`;
}

export function getBatchSubtitleSystemPrompt(source: LanguageCode = 'en', target: LanguageCode = 'ru'): string {
  return `You translate ${languageName(source)} subtitles of technical video courses (programming, IT, QA, DevOps) into ${languageName(target)}.

You receive consecutive subtitle segments with ids. A segment is usually a full sentence, but a sentence may continue into the next segment. Understand the whole passage first, then translate each segment.

RULES:
${styleRules(target)}
- Return exactly one translation per input id. Each translation must cover the meaning of its own segment; do not move content between segments.
- If a segment continues in the next one, do not end it with a period; end a finished thought with . ? or !
- Stay consistent with the PREVIOUS TRANSLATION block (terminology, tone), if present.

EXAMPLE
${batchExample(target)}

Return ONLY JSON: {"segments":[{"id":<number>,"text":"<translation>"}]}`;
}

export function buildBatchSubtitleUserPrompt(request: BatchTranslationRequest): string {
  const parts: string[] = [];

  if (request.previousContext && request.previousContext.length > 0) {
    parts.push(`PREVIOUS CONTEXT (do not translate):\n${request.previousContext.map((t) => `- ${t}`).join('\n')}`);
  }
  if (request.previousTranslations && request.previousTranslations.length > 0) {
    parts.push(`PREVIOUS TRANSLATION (for consistency):\n${request.previousTranslations.map((t) => `- ${t}`).join('\n')}`);
  }

  const compact = request.segments.map((s) => ({ id: s.id, text: s.text }));
  parts.push(`SEGMENTS:\n${JSON.stringify(compact)}`);

  if (request.nextContext && request.nextContext.length > 0) {
    parts.push(`NEXT CONTEXT (do not translate):\n${request.nextContext.map((t) => `- ${t}`).join('\n')}`);
  }

  parts.push(`Translate SEGMENTS into ${languageName(request.target)}. Return JSON only.`);
  return parts.join('\n\n');
}

export function getSubtitleSystemPrompt(source: LanguageCode = 'en', target: LanguageCode = 'ru'): string {
  const name = languageName(target);
  return `You translate ${languageName(source)} text from technical video courses (programming, IT, QA, DevOps) into ${name}.

RULES:
${styleRules(target)}
- The text may be a fragment of a longer sentence; translate it as a fragment, without adding a final period that is not in the source.

Answer with the ${name} translation ONLY: no quotes, no JSON, no notes, no alternatives.`;
}

export function buildSubtitleUserPrompt(
  text: string,
  context?: { previous?: string; upcoming?: string }
): string {
  const parts: string[] = [];
  if (context?.previous) parts.push(`Previous line (context only): ${context.previous}`);
  if (context?.upcoming) parts.push(`Next line (context only): ${context.upcoming}`);
  parts.push(`Translate:\n${text}`);
  return parts.join('\n');
}
