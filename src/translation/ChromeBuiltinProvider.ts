/**
 * Chrome Built-in Translator provider.
 *
 * Uses the Chrome 138+ on-device Translator API.
 *
 * LIMITATION: translation runs in the background service worker, and the Translator API is
 * only exposed to window contexts. Until translation for this provider is moved to an
 * offscreen document, it fails fast here and the manager falls back to Google Translate.
 */
import type { TranslationProvider, ProviderConfig } from './TranslationProvider';
import { ProviderError } from './TranslationProvider';
import type { LanguageCode, TranslationProviderType } from '../shared/types';

// Chrome Built-in AI types (not yet in @types/chrome)
interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy(): void;
}

interface ChromeTranslatorFactory {
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>;
}

export class ChromeBuiltinProvider implements TranslationProvider {
  readonly name = 'Chrome Built-in (On-Device)';
  readonly type: TranslationProviderType = 'chrome-builtin';
  readonly requiresApiKey = false;
  readonly isLlm = false;
  readonly cacheNamespace = 'chrome-builtin';

  private translatorCache = new Map<string, ChromeTranslator>();

  private async getOrCreateTranslator(source: LanguageCode, target: LanguageCode): Promise<ChromeTranslator> {
    const key = `${source}:${target}`;

    const cached = this.translatorCache.get(key);
    if (cached) return cached;

    // `globalThis` works in both window and worker scopes (`window` does not exist in the SW).
    const factory = (globalThis as { Translator?: ChromeTranslatorFactory }).Translator;
    if (!factory) {
      throw new ProviderError('not-found', 'Chrome Built-in Translator API is not available in this context');
    }

    const translator = await factory.create({
      sourceLanguage: source,
      targetLanguage: target,
    });

    this.translatorCache.set(key, translator);
    return translator;
  }

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    const translator = await this.getOrCreateTranslator(source, target);
    return translator.translate(text);
  }

  configure(_config: ProviderConfig): void {
    // No configuration needed
  }
}
