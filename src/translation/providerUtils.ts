/**
 * Helpers shared by the translation providers: HTTP error mapping, timeouts,
 * endpoint validation and LLM response parsing.
 */
import type { SubtitleSegment, TranslatedSegment } from '../shared/types';
import { ProviderError } from './TranslationProvider';
import { logWarn } from '../shared/utils';

/**
 * fetch() with a timeout. Aborts map to ProviderError('timeout'), network failures to 'network'.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  providerName: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ProviderError('timeout', `${providerName}: request timed out after ${timeoutMs} ms`);
    }
    throw new ProviderError('network', `${providerName}: ${err instanceof Error ? err.message : 'network error'}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Converts a non-OK HTTP response into a typed ProviderError.
 */
export async function errorFromResponse(response: Response, providerName: string): Promise<ProviderError> {
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const json = JSON.parse(body);
    detail = json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || body;
  } catch {
    // body is not JSON
  }
  const message = `${providerName} error ${response.status}: ${detail || response.statusText}`.slice(0, 300);
  const status = response.status;

  if (status === 429 || status === 456) return new ProviderError('rate-limit', message, status);
  if (status === 401 || status === 403) return new ProviderError('auth', message, status);
  if (status === 400 && /api[ _-]?key/i.test(detail)) return new ProviderError('auth', message, status);
  if (status === 404) return new ProviderError('not-found', message, status);
  if (status >= 500) return new ProviderError('server', message, status);
  return new ProviderError('bad-response', message, status);
}

/**
 * Custom endpoints receive the API key, so only HTTPS (or plain HTTP to this machine) is allowed.
 */
export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Returns the endpoint if allowed, otherwise the provider's default (and logs why). */
export function resolveEndpoint(custom: string | undefined, fallback: string, providerName: string): string {
  const trimmed = custom?.trim();
  if (!trimmed) return fallback;
  if (isAllowedEndpoint(trimmed)) return trimmed;
  logWarn(`${providerName}: ignoring custom endpoint "${trimmed}" (must be https:// or http://localhost)`);
  return fallback;
}

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['«', '»'],
  ['“', '”'],
  ['„', '“'],
];

/**
 * Removes quotes an LLM wrapped around the WHOLE answer.
 * Quotes that are part of the text (`Нажмите «Сохранить»`) are kept.
 */
export function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      const inner = trimmed.slice(open.length, trimmed.length - close.length);
      if (!inner.includes(open) && !inner.includes(close)) return inner.trim();
    }
  }
  return trimmed;
}

/**
 * Extracts a plain-text translation from an LLM answer. Tolerates a model that
 * still answered with JSON (`{"translation": …}` or `{"segments": [...]}`) or a code fence.
 */
export function extractPlainTranslation(content: string): string {
  let text = content.trim().replace(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/, '$1').trim();
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const candidate =
        (typeof json.translation === 'string' && json.translation) ||
        (typeof json.text === 'string' && json.text) ||
        (Array.isArray(json.segments) ? json.segments.map((s: { text?: unknown }) => s?.text).filter(Boolean).join(' ') : '');
      if (typeof candidate === 'string' && candidate) text = candidate;
    } catch {
      // not JSON after all
    }
  }
  return stripWrappingQuotes(text);
}

/**
 * Parses an LLM batch answer and maps it onto the requested segments by id.
 * Missing or invalid entries become empty strings — never the original text.
 */
export function mapBatchResponse(
  content: string,
  segments: SubtitleSegment[],
  providerName: string
): TranslatedSegment[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new ProviderError('bad-response', `${providerName}: response is not JSON`);
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new ProviderError('bad-response', `${providerName}: response JSON is malformed`);
    }
  }

  const returned = (parsed as { segments?: unknown })?.segments;
  if (!Array.isArray(returned) || returned.length === 0) {
    throw new ProviderError('bad-response', `${providerName}: no segments in response`);
  }

  const byId = new Map<number, string>();
  for (const item of returned) {
    const id = Number((item as { id?: unknown })?.id);
    const text = (item as { text?: unknown })?.text;
    if (Number.isInteger(id) && typeof text === 'string') byId.set(id, text);
  }
  // Positional mapping is only safe when the model returned exactly one item per segment.
  const positional = byId.size === 0 && returned.length === segments.length;

  const result = segments.map((seg, index) => {
    const raw = byId.get(seg.id) ?? (positional ? (returned[index] as { text?: unknown })?.text : undefined);
    const text = typeof raw === 'string' ? stripWrappingQuotes(raw) : '';
    return { id: seg.id, start: seg.start, end: seg.end, text };
  });

  if (result.every((s) => !s.text)) {
    throw new ProviderError('bad-response', `${providerName}: segments could not be matched to the request`);
  }
  return result;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
