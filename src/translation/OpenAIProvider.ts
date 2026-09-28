/**
 * OpenAI Translation Provider.
 *
 * Uses the OpenAI Chat Completions API (or any compatible endpoint) for LLM-powered translation.
 *
 * Requires an API key from https://platform.openai.com/
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType, BatchTranslationRequest, TranslatedSegment } from '../shared/types';
import {
  LLM_TIMEOUT_MS,
  LLM_BATCH_TIMEOUT_MS,
  OPENAI_DEFAULT_MODEL,
  PROMPT_VERSION,
  SUPPORTED_LANGUAGES,
} from '../shared/constants';
import {
  getSubtitleSystemPrompt,
  buildSubtitleUserPrompt,
  getBatchSubtitleSystemPrompt,
  buildBatchSubtitleUserPrompt,
} from './promptTemplates';
import {
  errorFromResponse,
  extractPlainTranslation,
  fetchWithTimeout,
  mapBatchResponse,
  resolveEndpoint,
} from './providerUtils';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider implements TranslationProvider {
  readonly name = 'OpenAI';
  readonly type: TranslationProviderType = 'openai';
  readonly requiresApiKey = true;
  readonly isLlm = true;

  private apiKey = '';
  private endpoint = DEFAULT_ENDPOINT;
  private model = OPENAI_DEFAULT_MODEL;

  get cacheNamespace(): string {
    return `openai:${this.model}:p${PROMPT_VERSION}`;
  }

  private getLanguageName(code: LanguageCode): string {
    return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name || code;
  }

  private async complete(
    systemPrompt: string,
    userPrompt: string,
    options: { json: boolean; timeoutMs: number; maxTokens: number }
  ): Promise<string> {
    if (!this.apiKey) {
      throw new ProviderError('auth', 'OpenAI API key is not configured');
    }

    const response = await fetchWithTimeout(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          temperature: 0.1,
          max_tokens: options.maxTokens,
        }),
      },
      options.timeoutMs,
      this.name
    );

    if (!response.ok) {
      throw await errorFromResponse(response, this.name);
    }

    const data = await response.json().catch(() => null);
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new ProviderError('bad-response', 'OpenAI: response was truncated (max_tokens)');
    }
    const content = choice?.message?.content?.trim();
    if (!content) {
      throw new ProviderError('bad-response', 'OpenAI: empty response');
    }
    return content;
  }

  async translate(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    context?: { previous?: string; upcoming?: string }
  ): Promise<string> {
    const content = await this.complete(
      getSubtitleSystemPrompt(this.getLanguageName(source), this.getLanguageName(target)),
      buildSubtitleUserPrompt(text, context),
      { json: false, timeoutMs: LLM_TIMEOUT_MS, maxTokens: 1000 }
    );
    const translation = extractPlainTranslation(content);
    if (!translation) throw new ProviderError('bad-response', 'OpenAI: empty translation');
    return translation;
  }

  async translateBatch(request: BatchTranslationRequest): Promise<TranslatedSegment[]> {
    if (!request.segments || request.segments.length === 0) return [];

    const targetName = this.getLanguageName(request.target);
    const content = await this.complete(
      getBatchSubtitleSystemPrompt(this.getLanguageName(request.source), targetName),
      buildBatchSubtitleUserPrompt(request, targetName),
      { json: true, timeoutMs: LLM_BATCH_TIMEOUT_MS, maxTokens: 4096 }
    );
    return mapBatchResponse(content, request.segments, this.name);
  }

  configure(config: ProviderConfig): void {
    if (config.apiKey !== undefined) this.apiKey = config.apiKey.trim();
    this.endpoint = resolveEndpoint(config.endpoint, DEFAULT_ENDPOINT, this.name);
    this.model = config.model?.trim() || OPENAI_DEFAULT_MODEL;
  }
}
