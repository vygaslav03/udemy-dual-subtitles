/**
 * Subtitle translation prompts for LLM providers (Gemini, OpenAI).
 *
 * - Batch: JSON in / JSON out ({ "segments": [{ id, text }] }). Timestamps are NOT sent:
 *   timing always comes from the source VTT, so echoing it would only cost tokens.
 * - Single: plain text in / plain text out (selection translation, word tooltip, DOM-only mode).
 *
 * Bump PROMPT_VERSION (shared/constants.ts) whenever these prompts change.
 */
import type { BatchTranslationRequest } from '../shared/types';

const STYLE_RULES = (targetName: string) => `- Translate by meaning, not word-for-word. Use the word order and constructions that are natural in ${targetName}.
- Keep the speaker's conversational tone. Address the viewer politely ("вы" in Russian) or use impersonal constructions ("нужно", "можно") where that sounds more natural.
- Keep established IT terms in their standard industry form (branch → ветка, pull request, commit, deploy → развернуть/деплой, endpoint, test case → тест-кейс, pipeline → пайплайн).
- Never translate or alter code, commands, URLs, file names, identifiers or product names (e.g. \`npm install\`, \`const user = await getUser(id)\`, Docker, Kubernetes).
- Fix obvious speech-recognition errors when the intended meaning is clear. Do not add or drop information.
- Use correct ${targetName} punctuation.`;

export function getBatchSubtitleSystemPrompt(sourceName = 'English', targetName = 'Russian'): string {
  return `You translate ${sourceName} subtitles of technical video courses (programming, IT, QA, DevOps) into ${targetName}.

You receive consecutive subtitle segments with ids. A segment is usually a full sentence, but a sentence may continue into the next segment. Understand the whole passage first, then translate each segment.

RULES:
${STYLE_RULES(targetName)}
- Return exactly one translation per input id. Each translation must cover the meaning of its own segment; do not move content between segments.
- If a segment continues in the next one, do not end it with a period; end a finished thought with . ? or !
- Stay consistent with the PREVIOUS TRANSLATION block (terminology, tone), if present.

EXAMPLE
Input: [{"id":1,"text":"We need to configure the server first."},{"id":2,"text":"After that we can deploy the application."}]
Output: {"segments":[{"id":1,"text":"Сначала нужно настроить сервер."},{"id":2,"text":"После этого можно развернуть приложение."}]}

Return ONLY JSON: {"segments":[{"id":<number>,"text":"<translation>"}]}`;
}

export function buildBatchSubtitleUserPrompt(request: BatchTranslationRequest, targetName = 'Russian'): string {
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

  parts.push(`Translate SEGMENTS into ${targetName}. Return JSON only.`);
  return parts.join('\n\n');
}

export function getSubtitleSystemPrompt(sourceName = 'English', targetName = 'Russian'): string {
  return `You translate ${sourceName} text from technical video courses (programming, IT, QA, DevOps) into ${targetName}.

RULES:
${STYLE_RULES(targetName)}
- The text may be a fragment of a longer sentence; translate it as a fragment, without adding a final period that is not in the source.

Answer with the ${targetName} translation ONLY: no quotes, no JSON, no notes, no alternatives.`;
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
