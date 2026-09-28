/**
 * TerminologyProcessor — fixes notorious machine-translation blunders in IT/QA subtitles,
 * where technical terms come out as industrial or bureaucratic Russian
 * (e.g. "условия испытаний" -> "тестовые условия").
 *
 * Applied only to machine-translation providers (LLMs follow the prompt's rules).
 *
 * Every replacement keeps the grammatical case/number of the matched phrase:
 * inflected endings are captured and mapped, never normalized to the nominative.
 * The processor never changes capitalization — a segment may continue a sentence.
 */
import type { LanguageCode } from '../shared/types';

type Replacer = (match: string, ...groups: string[]) => string;

interface TermReplacement {
  pattern: RegExp;
  replacement: string | Replacer;
}

// Unicode-aware word boundaries (\b does not work for Cyrillic).
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const rule = (body: string, replacement: string | Replacer): TermReplacement => ({
  pattern: new RegExp(`${B}${body}${E}`, 'giu'),
  replacement,
});

/** Picks a form by the captured ending; unknown endings keep the first form. */
const byEnding =
  (forms: Record<string, string>, groupIndex = 0): Replacer =>
  (match, ...groups) => {
    const ending = (groups[groupIndex] || '').toLowerCase();
    return forms[ending] ?? forms[''] ?? match;
  };

/**
 * "<adjective> испытания/испытаний/испытание" → "<type> тестирование/тестирования".
 * Genitive-plural adjectives (…ых) or "испытаний" → genitive "тестирования".
 */
const testingType =
  (name: string): Replacer =>
  (_match, adjEnding = '', nounEnding = '') => {
    const genitive = adjEnding.toLowerCase() === 'ых' || nounEnding.toLowerCase() === 'й';
    // "smoke-" / "E2E-" attach directly: "smoke-тестирование"
    const prefix = name.endsWith('-') ? name : `${name} `;
    if (!genitive) return `${prefix}тестирование`;
    // Adjectives agree with the noun: "регрессионного тестирования"
    return name.endsWith('-') ? `${prefix}тестирования` : `${name.replace(/ое$/, 'ого')} тестирования`;
  };

// Ordered rules: longer/more specific phrases first, then individual terms.
const QA_AND_IT_RULES_RU: TermReplacement[] = [
  // 1. Test conditions
  rule('условий\\s+испытани[йя]', 'тестовых условий'),
  rule('условия\\s+испытани[йя]', 'тестовые условия'),
  rule('условиях\\s+испытаний', 'тестовых условиях'),
  rule('условиям\\s+испытаний', 'тестовым условиям'),
  rule('условием\\s+испытаний', 'тестовым условием'),
  rule('условие\\s+испытания', 'тестовое условие'),

  // Test cases, suites, plans, runs
  rule('дело\\s+для\\s+испытаний', 'тест-кейс'),
  rule('случа(й|я|ю|ем|е|и|ев|ям|ями|ях)\\s+испытани(?:я|й)', byEnding({
    й: 'тест-кейс', я: 'тест-кейса', ю: 'тест-кейсу', ем: 'тест-кейсом', е: 'тест-кейсе',
    и: 'тест-кейсы', ев: 'тест-кейсов', ям: 'тест-кейсам', ями: 'тест-кейсами', ях: 'тест-кейсах',
  })),
  rule('набор(а|у|ом|е|ы|ов)?\\s+испытаний', (_m, e = '') => `набор${e} тестов`),
  rule('план(а|у|ом|е|ы|ов)?\\s+испытаний', (_m, e = '') => `тест-план${e}`),
  rule('прогон(а|у|ом|е|ы|ов)?\\s+испытаний', (_m, e = '') => `прогон${e} тестов`),
  rule('запуск(а|у|ом|е)?\\s+испытаний', (_m, e = '') => `запуск${e} тестов`),
  rule('выполнени(е|я|ю|ем|и)\\s+испытаний', (_m, e) => `выполнени${e} тестов`),
  rule('результат(а|у|ом|е|ы|ов|ам|ами|ах)?\\s+испытаний', (_m, e = '') => `результат${e} тестов`),
  rule('объект(а|у|ом|е|ы|ов)?\\s+испытаний', (_m, e = '') => `объект${e} тестирования`),
  rule('сред(а|ы|е|у|ой)\\s+испытаний', (_m, e) => `сред${e} тестирования`),
  rule('данн(ые|ых|ым|ыми)\\s+испытаний', byEnding({
    ые: 'тестовые данные', ых: 'тестовых данных', ым: 'тестовым данным', ыми: 'тестовыми данными',
  })),
  rule('покрыти(е|я|ю|ем)\\s+испытаниями', (_m, e) => `покрыти${e} тестами`),
  rule('охват(а|у|ом|е)?\\s+испытаниями', byEnding({ '': 'покрытие тестами', а: 'покрытия тестами', у: 'покрытию тестами', ом: 'покрытием тестами', е: 'покрытии тестами' })),

  // Testing types
  rule('дымов(ые|ых|ое)\\s+испытани(я|й|е)', testingType('smoke-')),
  rule('регрессионн(ые|ых|ое)\\s+испытани(я|й|е)', testingType('регрессионное')),
  rule('сквозн(ые|ых|ое)\\s+испытани(я|й|е)', testingType('E2E-')),
  rule('приемочн(ые|ых|ое)\\s+испытани(я|й|е)', testingType('приёмочное')),
  rule('нагрузочн(ые|ых|ое)\\s+испытани(я|й|е)', testingType('нагрузочное')),
  rule('модульн(ые|ых|ое)\\s+испытани(я|й|е)', testingType('модульное')),
  rule('автоматизированн(ые|ых|ое)\\s+испытани(я|й|е)', testingType('автоматизированное')),
  rule('испытани(я|е|й)\\s+на\\s+проникновение', (_m, e) => `тестировани${e === 'е' ? 'е' : 'я'} на проникновение`),
  rule('испытани(е|я)\\s+производительности', (_m, e) => `тестировани${e} производительности`),
  rule('испытани(е|я)\\s+безопасности', (_m, e) => `тестировани${e} безопасности`),
  rule('испытани(е|я)\\s+удобства\\s+использования', (_m, e) => `usability-тестировани${e}`),

  // General testing context
  rule('в\\s+процессе\\s+испытаний', 'в процессе тестирования'),
  rule('во\\s+время\\s+испытаний', 'во время тестирования'),
  rule('этап(а|у|ом|е|ы|ов)?\\s+испытаний', (_m, e = '') => `этап${e} тестирования`),
  rule('фаз(а|ы|е|у|ой)\\s+испытаний', (_m, e) => `фаз${e} тестирования`),

  // Prioritization
  rule('расстановк(а|и|у|ой|е)\\s+приоритетов', byEnding({ а: 'приоритизация', и: 'приоритизации', у: 'приоритизацию', ой: 'приоритизацией', е: 'приоритизации' })),

  // 3. Defects
  rule('крайн(ий|его|ему|им|ем|ие|их|ими)\\s+случа(?:й|я|ю|ем|е|и|ев|ям|ями|ях)', byEnding({
    ий: 'граничный случай', его: 'граничного случая', ему: 'граничному случаю', им: 'граничным случаем',
    ем: 'граничном случае', ие: 'граничные случаи', их: 'граничных случаев', ими: 'граничными случаями',
  })),
  rule('отчет(а|у|ом|е|ы|ов)?\\s+об\\s+ошибк(?:е|ах)', (_m, e = '') => `баг-репорт${e}`),
  {
    pattern: new RegExp(`${B}жук(а|и|ов)?(?=\\s+(?:в\\s+коде|в\\s+программе|в\\s+приложении|в\\s+системе))`, 'giu'),
    replacement: byEnding({ '': 'баг', а: 'бага', и: 'баги', ов: 'багов' }),
  },

  // 4. Git & DevOps
  {
    pattern: new RegExp(`${B}трубопровод(а|у|ом|е|ы|ов)?(?=\\s+(?:сборки|развертывания|развёртывания|CI|CD|деплоя|проекта))`, 'giu'),
    replacement: (_m, e = '') => `пайплайн${e}`,
  },
  {
    // "ветвь" is the same in nominative and accusative; an agreeing adjective ("новую") disambiguates.
    pattern: new RegExp(`${B}((?:\\p{L}+(?:ую|юю)\\s+)?)ветв(ь|и|ью|ей|ям|ями|ях)(?=\\s+(?:git|кода|репозитория|master|main|develop|feature))`, 'giu'),
    replacement: (_m, adjective = '', ending = '') => {
      const forms: Record<string, string> = { ь: 'ветка', и: 'ветки', ью: 'веткой', ей: 'веток', ям: 'веткам', ями: 'ветками', ях: 'ветках' };
      const noun = ending.toLowerCase() === 'ь' && adjective ? 'ветку' : forms[ending.toLowerCase()] ?? 'ветка';
      return `${adjective}${noun}`;
    },
  },
  {
    pattern: new RegExp(`${B}branch(?=\\s+(?:в\\s+git|git|кода|репозитория|master|main|develop|feature))`, 'giu'),
    replacement: 'ветка',
  },
  rule('запрос(а|у|ом|е|ы|ов)?\\s+на\\s+вытягивание', (_m, e = '') => `пулл-реквест${e}`),
  {
    pattern: new RegExp(`${B}конечн(ая|ой|ую|ые|ых|ым|ыми)\\s+точ(?:ка|ки|ке|ку|кой|ек|кам|ками|ках)(?=\\s+(?:API|сервера|запроса))`, 'giu'),
    replacement: byEnding({ ая: 'эндпоинт', ую: 'эндпоинт', ой: 'эндпоинта', ые: 'эндпоинты', ых: 'эндпоинтов', ым: 'эндпоинтам', ыми: 'эндпоинтами' }),
  },
  rule('слияни(е|я|ю|ем|и)\\s+веток', byEnding({ е: 'мёрдж веток', я: 'мёрджа веток', ю: 'мёрджу веток', ем: 'мёрджем веток', и: 'мёрдже веток' })),

  // 5. Code & Programming
  {
    pattern: new RegExp(`${B}обратн(ый|ого|ому|ым|ом)\\s+вызов(?:а|у|ом|е)?(?=\\s+(?:функции|callback))`, 'giu'),
    replacement: byEnding({ ый: 'колбэк', ого: 'колбэка', ому: 'колбэку', ым: 'колбэком', ом: 'колбэке' }),
  },
];

export class TerminologyProcessor {
  /**
   * Applies QA, IT, and software development terminology fixes to translated text.
   */
  static process(text: string, _sourceLang: LanguageCode = 'en', targetLang: LanguageCode = 'ru'): string {
    if (!text || !text.trim() || targetLang !== 'ru') return text;

    let result = text;
    for (const { pattern, replacement } of QA_AND_IT_RULES_RU) {
      result = result.replace(pattern, (match: string, ...args: unknown[]) => {
        const replaced =
          typeof replacement === 'string'
            ? replacement
            : replacement(match, ...(args.filter((a) => typeof a === 'string' || a === undefined) as string[]));
        return preserveInitialCase(match, replaced);
      });
    }
    return result;
  }
}

/** "Условия испытаний" → "Тестовые условия" (keep a capital letter the match started with). */
function preserveInitialCase(original: string, replaced: string): string {
  const first = original.charAt(0);
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replaced.charAt(0).toUpperCase() + replaced.slice(1);
  }
  return replaced;
}
