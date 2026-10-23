/**
 * Small DOM helpers shared by the extension pages (popup, options).
 */
import { SUPPORTED_LANGUAGES } from './constants';

/** Fills a <select> with the supported languages (the single source is SUPPORTED_LANGUAGES). */
export function fillLanguageSelect(select: HTMLSelectElement | null, selected: string): void {
  if (!select) return;
  select.replaceChildren(
    ...SUPPORTED_LANGUAGES.map((lang) => new Option(`${lang.flag} ${lang.name}`, lang.code, false, lang.code === selected))
  );
  select.value = selected;
}
