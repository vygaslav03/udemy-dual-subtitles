/**
 * Typed message contract between the service worker, content scripts and extension pages.
 *
 * Every action is declared once with its payload and result type; `sendToBackground` and
 * `sendToTab` check both at compile time, and the background router must handle every action.
 */
import type {
  BatchTranslationRequest,
  BatchTranslationResponse,
  CacheStats,
  DictionaryEntry,
  ExtensionSettings,
  LanguageCode,
  MessageResponse,
  ProviderSettings,
  PublicSettings,
  TranslationProviderType,
  TranslationResult,
} from './types';

export interface TranslationContext {
  previous?: string;
  upcoming?: string;
}

/** Requests handled by the service worker. */
export interface BackgroundRequests {
  /** Credential-free settings (content scripts) */
  GET_SETTINGS: { payload: void; result: PublicSettings };
  UPDATE_SETTINGS: { payload: Partial<PublicSettings>; result: ExtensionSettings };
  UPDATE_PROVIDER_CONFIG: {
    payload: { provider: TranslationProviderType; config: Partial<ProviderSettings> };
    result: ExtensionSettings;
  };
  TRANSLATE_TEXT: {
    payload: { text: string; source: LanguageCode; target: LanguageCode; context?: TranslationContext };
    result: TranslationResult;
  };
  TRANSLATE_BATCH: { payload: BatchTranslationRequest; result: BatchTranslationResponse };
  CANCEL_PREFETCH: { payload: void; result: void };
  CLEAR_CACHE: { payload: void; result: void };
  GET_CACHE_STATS: { payload: void; result: CacheStats };
  FETCH_VTT: { payload: { url: string }; result: string };
  SAVE_WORD: { payload: Omit<DictionaryEntry, 'id' | 'addedAt'>; result: DictionaryEntry };
  DELETE_WORD: { payload: { id: string }; result: void };
}

export type BackgroundAction = keyof BackgroundRequests;
export type PayloadOf<A extends BackgroundAction> = BackgroundRequests[A]['payload'];
export type ResultOf<A extends BackgroundAction> = BackgroundRequests[A]['result'];

/** Actions that change configuration or delete data: extension pages only, never content scripts. */
export const EXTENSION_PAGE_ONLY: ReadonlySet<BackgroundAction> = new Set<BackgroundAction>([
  'UPDATE_SETTINGS',
  'UPDATE_PROVIDER_CONFIG',
  'CLEAR_CACHE',
  'DELETE_WORD',
]);

export interface ContentStatus {
  enabled: boolean;
  detected: boolean;
  strategy: string;
  lastText: string;
}

/** Messages sent to the content script of a tab (by the background or the popup). */
export interface TabRequests {
  URL_CHANGED: { payload: { url: string }; result: void };
  VTT_RESOURCE: { payload: { url: string }; result: void };
  TOGGLE_TRANSLATION: { payload: void; result: { visible: boolean } };
  SETTINGS_CHANGED: {
    payload: { settings: PublicSettings; previous: PublicSettings; translationChanged: boolean };
    result: void;
  };
  CACHE_CLEARED: { payload: void; result: void };
  GET_STATUS: { payload: void; result: ContentStatus };
}

export type TabAction = keyof TabRequests;

export interface Message<A extends string = string, P = unknown> {
  action: A;
  payload?: P;
}

type PayloadArgs<P> = [P] extends [void] ? [] : [P];

/** Error of a failed request; `code` carries the background's machine-readable kind. */
export class MessageError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'MessageError';
  }

  get cancelled(): boolean {
    return this.code === 'cancelled';
  }
}

function unwrap<T>(response: MessageResponse<T> | undefined): T {
  if (!response) throw new MessageError('No response from background');
  if (!response.success) throw new MessageError(response.error || 'Request failed', response.errorCode);
  return response.data as T;
}

/**
 * Sends a request to the service worker and resolves with its result.
 * Rejects with MessageError when the background answers with an error or is unreachable
 * (e.g. "Extension context invalidated" after the extension was reloaded).
 */
export function sendToBackground<A extends BackgroundAction>(
  action: A,
  ...[payload]: PayloadArgs<PayloadOf<A>>
): Promise<ResultOf<A>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ action, payload }, (response: MessageResponse<ResultOf<A>> | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new MessageError(chrome.runtime.lastError.message || 'Background worker unavailable'));
          return;
        }
        try {
          resolve(unwrap(response));
        } catch (err) {
          reject(err);
        }
      });
    } catch (err) {
      reject(new MessageError(err instanceof Error ? err.message : 'Background worker unavailable'));
    }
  });
}

/** Sends a request to the content script of a tab. Rejects if no content script answers. */
export async function sendToTab<A extends TabAction>(
  tabId: number,
  action: A,
  ...[payload]: PayloadArgs<TabRequests[A]['payload']>
): Promise<TabRequests[A]['result']> {
  const response = (await chrome.tabs.sendMessage(tabId, { action, payload })) as
    | MessageResponse<TabRequests[A]['result']>
    | undefined;
  return unwrap(response);
}
