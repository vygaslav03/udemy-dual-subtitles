/**
 * Shared utility functions
 */

/**
 * Creates a debounced version of a function.
 * The function will only execute after `delay` ms have passed
 * since the last invocation.
 */
export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Normalizes text for cache key generation.
 * Trims whitespace, lowercases, collapses multiple spaces.
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Generates a cache key from language pair and text.
 * `namespace` separates translations made by different providers/models/prompts.
 */
export function makeCacheKey(source: string, target: string, text: string, namespace = ''): string {
  const base = `${source}:${target}:${normalizeText(text)}`;
  return namespace ? `${namespace}|${base}` : base;
}

/**
 * Normalizes subtitle cue text: strips VTT/HTML tags, decodes entities, collapses whitespace.
 */
export function cleanCueText(raw: string): string {
  return decodeHtmlEntities(raw.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

/**
 * Decodes the HTML/WebVTT character references that appear in cue text.
 * Works without a DOM (the parser is also unit-tested in Node).
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

/**
 * Identifies a lesson by origin + path: hash/query changes (lecture tabs, `?start=`)
 * are not lesson changes.
 */
export function lessonKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/**
 * Generates a unique ID (for dictionary entries).
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Escapes HTML to prevent XSS when inserting user text into DOM.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Checks if the current page is a Udemy course/lesson page.
 */
export function isUdemyCoursePage(): boolean {
  const url = window.location.href;
  if (url.includes('udemy.com')) {
    return url.includes('/learn') || url.includes('/lecture') || url.includes('/course/') || !!document.querySelector('video');
  }
  return false;
}

/** Debug logging is compiled in for `npm run dev` (and tests) only; production builds stay quiet. */
const DEBUG = import.meta.env.DEV;

/**
 * Logs debug messages with extension prefix for easy filtering.
 * Subtitle text appears in these messages, so they must not reach the Udemy console in production.
 */
export function log(message: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  if (DEBUG) console.log(`[UDS] ${message}`, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  console.error(`[UDS] ${message}`, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  console.warn(`[UDS] ${message}`, ...args);
}
