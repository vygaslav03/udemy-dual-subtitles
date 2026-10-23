/**
 * Google Gemini Translation Provider.
 *
 * Uses the Gemini API (generateContent) for LLM-powered translation.
 *
 * Requires an API key from https://aistudio.google.com/apikey
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType, BatchTranslationRequest, TranslatedSegment } from '../shared/types';
import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_FALLBACK_MODEL,
  LLM_TIMEOUT_MS,
  LLM_BATCH_TIMEOUT_MS,
  PROMPT_VERSION,
} from '../shared/constants';
import { logWarn } from '../shared/utils';
import {
  getSubtitleSystemPrompt,
  buildSubtitleUserPrompt,
  getBatchSubtitleSystemPrompt,
  buildBatchSubtitleUserPrompt,
} from './promptTemplates';
import { errorFromResponse, extractPlainTranslation, fetchWithTimeout, mapBatchResponse } from './providerUtils';

const BATCH_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          text: { type: 'STRING' },
        },
        required: ['id', 'text'],
      },
    },
  },
  required: ['segments'],
};

export class GeminiProvider implements TranslationProvider {
  readonly name = 'Google Gemini';
  readonly type: TranslationProviderType = 'gemini';
  readonly requiresApiKey = true;
  readonly isLlm = true;

  private apiKey = '';
  private model = GEMINI_DEFAULT_MODEL;

  get cacheNamespace(): string {
    return `gemini:${this.model}:p${PROMPT_VERSION}`;
  }

  private get endpoint(): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
  }

  private async generate(
    systemPrompt: string,
    userPrompt: string,
    generationConfig: Record<string, unknown>,
    timeoutMs: number
  ): Promise<string> {
    if (!this.apiKey) {
      throw new ProviderError('auth', 'Gemini API key is not configured');
    }

    const response = await fetchWithTimeout(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header instead of ?key= so the key never appears in URLs/logs
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.1, ...generationConfig },
        }),
      },
      timeoutMs,
      this.name
    );

    if (!response.ok) {
      if (response.status === 404 && this.model === GEMINI_DEFAULT_MODEL) {
        logWarn(`${GEMINI_DEFAULT_MODEL} returned 404, falling back to ${GEMINI_FALLBACK_MODEL}`);
        this.model = GEMINI_FALLBACK_MODEL;
        return this.generate(systemPrompt, userPrompt, generationConfig, timeoutMs);
      }
      throw await errorFromResponse(response, this.name);
    }

    const data = await response.json().catch(() => null);
    const candidate = data?.candidates?.[0];
    const finishReason: string | undefined = candidate?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      throw new ProviderError('bad-response', 'Gemini: response was truncated (MAX_TOKENS)');
    }
    if (finishReason && finishReason !== 'STOP') {
      throw new ProviderError('bad-response', `Gemini: generation stopped (${finishReason})`);
    }

    // Thinking models may return several parts; thought summaries are flagged with `thought`.
    const parts: Array<{ text?: string; thought?: boolean }> = candidate?.content?.parts || [];
    const content = parts
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();

    if (!content) {
      throw new ProviderError('bad-response', 'Gemini: empty response');
    }
    return content;
  }

  async translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<string> {
    const content = await this.generate(
      getSubtitleSystemPrompt(source, target),
      buildSubtitleUserPrompt(text, context),
      // Output tokens include the reasoning tokens of thinking models — leave headroom.
      { maxOutputTokens: 2048 },
      LLM_TIMEOUT_MS
    );
    const translation = extractPlainTranslation(content);
    if (!translation) throw new ProviderError('bad-response', 'Gemini: empty translation');
    return translation;
  }

  async translateBatch(request: BatchTranslationRequest): Promise<TranslatedSegment[]> {
    if (!request.segments || request.segments.length === 0) return [];

    const content = await this.generate(
      getBatchSubtitleSystemPrompt(request.source, request.target),
      buildBatchSubtitleUserPrompt(request),
      {
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: BATCH_RESPONSE_SCHEMA,
      },
      LLM_BATCH_TIMEOUT_MS
    );
    return mapBatchResponse(content, request.segments, this.name);
  }

  configure(config: ProviderConfig): void {
    if (config.apiKey !== undefined) this.apiKey = config.apiKey.trim();
    this.model = config.model?.trim() || GEMINI_DEFAULT_MODEL;
  }
}
