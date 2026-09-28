# PROJECT AUDIT: Udemy Dual Subtitles

> **Historical document (16.09.2026).** All issues listed below have since been fixed; see ARCHITECTURE.md for the current design.

**Дата аудита:** 16 сентября 2026 г.  
**Аудитор:** Senior Chrome Extension Engineer & Full-stack TypeScript Developer  
**Проект:** Udemy Dual Subtitles

---

## 1. Текущее состояние

Проект существует и частично разработан. Использован стек:
* **Chrome Extension Manifest V3**
* **TypeScript** (strict mode)
* **Vite 6** (custom multi-entry rollup config)
* **HTML / Vanilla CSS**

`npm run build` (`tsc --noEmit && vite build`) формально выполняется без синтаксических ошибок TypeScript, однако собранный бандл **неработоспособен в Chrome** из-за критических архитектурных ошибок Manifest V3.

---

## 2. Что уже реализовано

* [x] **Структура проекта:** Четкое разделение на `content`, `background`, `popup`, `options`, `dictionary`, `shared`, `translation`.
* [x] **UI Pages:**
  * `popup.html/ts/css` — переключатель ON/OFF, выбор языков, статус обнаружения, переход в настройки/словарь.
  * `options.html/ts/css` — выбор провайдера, API-ключи, стилизация субтитров (шрифты, цвета, прозрачность, позиция).
  * `dictionary.html/ts/css` — список терминов, поиск, удаление, экспорт в CSV.
* [x] **Настройки (`shared/storage.ts`):** Типизированный `chrome.storage.local` с дефолтными значениями и подпиской на изменения `chrome.storage.onChanged`.
* [x] **Словарь QA-терминов (`WordTooltip.ts`):** 30+ готовых определений терминов (severity, regression, assertion, mock, blocker и др.).
* [x] **Провайдеры перевода:** Созданы базовые классы:
  * `GoogleFreeProvider` (web API `translate.googleapis.com`)
  * `ChromeBuiltinProvider` (Window AI / Gemini Nano)
  * `DeepLProvider` (DeepL API v2)
  * `OpenAIProvider` (Chat Completions)
  * `GeminiProvider` (generateContent)
  * `LibreTranslateProvider`
  * `GoogleCloudProvider`
* [x] **Горячие клавиши:** В `manifest.json` и `background.ts` объявлены `Alt+D`, `Alt+Plus`, `Alt+Minus`.

---

## 3. Что сломано (Критические баги)

### 🔴 1. Блокирующий баг: Content Script использует ES Module `import` (SyntaxError)
* **Проблема:** Vite при сборке multi-entry разделяет общий код (`shared/storage.ts`, `shared/utils.ts`) в отдельный чанк `dist/shared/storage-DecOg2Ad.js` и вставляет в начало `dist/content/content.js`:
  ```javascript
  import { S as E, ... } from "../shared/storage-DecOg2Ad.js";
  ```
* **Последствие:** Chrome Manifest V3 **не поддерживает** `type: "module"` для `content_scripts`. При попытке запуска на Udemy в консоли Chrome возникнет:
  `Uncaught SyntaxError: Cannot use import statement outside a module`.
  Расширение **вообще не запускается**.
* **Решение:** Настроить сборку Vite / Rollup так, чтобы `content.ts` компилировался в единый самодостаточный IIFE-бандл без импорта внешних чанков.

---

### 🔴 2. Архитектурный баг: Обход CSP Udemy и CORS для Translation API
* **Проблема:** Все запросы к внешним Translation API (`translate.googleapis.com`, `api.openai.com`, `api.deepl.com`) вызываются внутри `content.ts` (Content Script).
* **Последствие:** Content Script исполняется в контексте страницы `https://www.udemy.com/*` и жестко ограничен заголовками Content Security Policy (`connect-src`) Udemy. Браузер заблокирует любой внешний `fetch()`:
  `Refused to connect to '...' because it violates the document's Content Security Policy`.
* **Решение:** Вызовы сетевых API перевода должны выполняться в **Background Service Worker** (`background.ts`), который наделен `host_permissions` и не подчиняется CSP страницы Udemy, а Content Script общается с ним через `chrome.runtime.sendMessage`.

---

### 🔴 3. Изоляция данных: IndexedDB Origin Mismatch
* **Проблема:** `saveDictionaryWord()` вызывается из Content Script и открывает IndexedDB в origin `https://www.udemy.com`. Страница словаря `dictionary.html` открывается в origin `chrome-extension://<id>` и обращается к IndexedDB расширения.
* **Последствие:** Базы данных физически изолированы браузером. Слова, сохраненные во время урока, **никогда не появятся** в QA Dictionary!
* **Решение:** Для словаря и кэша использовать общее хранилище: `chrome.storage.local` (хранит до 10MB данных, синхронизируется между всеми контекстами расширения и не зависит от origin) либо выполнять все операции с IndexedDB централизованно через Background Service Worker.

---

### 🔴 4. Ложноотрицательное обнаружение субтитров (`hasVisibleText`)
* **Проблема:** В `SubtitleDetector.detect()` стоит проверка:
  ```typescript
  if (element && this.hasVisibleText(element))
  ```
* **Последствие:** Если пользователь запустил видео или видео находится на паузе/между фразами, контейнер субтитров `[data-purpose="captions-display"]` уже есть в DOM, но текста в нем временно нет. Детектор бракует его, считает, что субтитров нет, после 20 попыток (~30 сек) сдается и засыпает навсегда.
* **Решение:** Обнаруживать контейнер субтитров независимо от наличия текста в текущую миллисекунду, привязывать `MutationObserver` к найденному контейнеру и ждать появления текста cue.

---

### 🔴 5. Наложение субтитров (Дублирование английского текста)
* **Проблема:** `SubtitleRenderer` создает свой плавающий блок и отображает там английский + русский текст, но **не скрывает** родные субтитры Udemy.
* **Последствие:** На экране одновременно видны и родные субтитры Udemy, и субтитры расширения, перекрывающие друг друга.
* **Решение:** Родные субтитры Udemy визуально скрывать (через `opacity: 0 !important` или `visibility: hidden !important`), оставляя их в DOM, чтобы `MutationObserver` продолжал считывать текст без сбоев.

---

### 🟡 6. SPA Навигация в Isolated World
* **Проблема:** `NavigationWatcher.ts` перехватывает `history.pushState` в isolated world контекста расширения. React на странице Udemy работает в main world, поэтому переопределение `pushState` в content script не перехватывает роутинг Udemy.
* **Решение:** Слушать обновления таба в `background.ts` через `chrome.tabs.onUpdated` (при смене URL) и слать сообщение в Content Script, плюс отслеживать изменения `document.title` и DOM-элементов плеера.

---

### 🟡 7. Провайдеры не зарегистрированы в `TranslationManager`
* **Проблема:** Файлы `DeepLProvider.ts`, `OpenAIProvider.ts`, `GeminiProvider.ts`, `LibreTranslateProvider.ts`, `GoogleCloudProvider.ts` созданы, но в `TranslationManager.ts` прописаны только `google-free` и `chrome-builtin`.
* **Решение:** Подключить и зарегистрировать все реализованные провайдеры в фабрике/мапе `TranslationManager`.

---

## 4. Архитектура проекта

```text
udemy-dual-subtitles/
├── public/
│   ├── manifest.json              # MV3 конфигурация
│   └── icons/                     # Иконки 16, 32, 48, 128
├── src/
│   ├── background/
│   │   └── background.ts          # Service Worker: сетевые запросы к API, шорткаты, роутинг сообщений
│   ├── content/
│   │   ├── content.ts             # Оркестратор Content Script (должен быть IIFE)
│   │   ├── SubtitleDetector.ts    # Обнаружение контейнера субтитров Udemy
│   │   ├── SubtitleObserver.ts    # Отслеживание смены фраз через MutationObserver
│   │   ├── SubtitleRenderer.ts    # Рендеринг двух строк (EN+RU) + скрытие нативных
│   │   ├── NavigationWatcher.ts   # SPA-навигация
│   │   ├── SelectionTranslator.ts # Перевод выделенного фрагмента
│   │   └── WordTooltip.ts         # QA Learning Mode
│   ├── translation/
│   │   ├── TranslationManager.ts  # Очередь, дедупликация, кэш
│   │   ├── TranslationCache.ts    # Локальный кэш переведенных фраз
│   │   ├── TranslationProvider.ts # Базовый интерфейс провайдера
│   │   └── *Provider.ts           # Реализации провайдеров
│   ├── popup/                     # Минималистичный Popup UI
│   ├── options/                   # Options / Settings UI
│   ├── dictionary/                # Страница словаря QA
│   └── shared/
│       ├── types.ts               # Общие типы данных
│       ├── constants.ts           # Селекторы, тайминги, настройки по умолчанию
│       ├── storage.ts             # Единый слой хранения (chrome.storage.local)
│       └── utils.ts               # Утилиты
```

---

## 5. План устранения проблем и перехода к Phase 2

1. **Phase 2 (Architecture & Build Fixes):**
   * Перенастроить `vite.config.ts`: собрать `content.ts` как автономный скрипт без внешних `import` (решение блокирующего бага №1).
   * Реализовать проксирование переводов через Background Service Worker для обхода CSP Udemy (решение бага №2).
   * Перевести хранилище QA Dictionary и кэша на `chrome.storage.local` (или централизованный service worker) для устранения origin mismatch (решение бага №3).
   * Зарегистрировать все провайдеры в `TranslationManager`.

2. **Phase 3 & 4 (Subtitle Detection & Rendering):**
   * Исправить `SubtitleDetector`: находить и закреплять контейнер `[data-purpose="captions-display"]` даже когда он пуст (решение бага №4).
   * Скрывать нативные субтитры Udemy (`opacity: 0 !important`), рендерить наш синхронизированный блок (решение бага №5).

3. **Phase 5 & 6 (Translation & Cache):**
   * Обеспечить стабильный перевод через Background proxy + дедупликация + кэш повторных фраз.

4. **Phase 7-14:**
   * Проверка MVP, доработка настроек, полноэкранного режима, SPA навигации, QA режима и финальное тестирование.
