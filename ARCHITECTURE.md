# Architecture — Udemy Dual Subtitles

## Overview

Chrome Extension (Manifest V3) that reads the English subtitles of the Udemy player, translates them and displays dual subtitles (original + translation) over the video.

## Technology Stack

- **TypeScript** (strict mode), **Vite** (two builds: extension pages + SW as ES modules, content script as a self-contained IIFE)
- **IndexedDB** (in the service worker) — translation cache
- **chrome.storage.local** — settings, per-provider credentials, QA dictionary (written only by the service worker)
- **Vitest** — unit tests, **ESLint** — lint; CI runs lint, type check (sources and tests), tests and the production build on every push and pull request

## Layout

```
src/
├── background/
│   ├── background.ts            Typed message router (payload validation, sender checks), shortcuts,
│   │                            SPA navigation → URL_CHANGED, settings pushes to Udemy tabs
│   └── SettingsStore.ts         Single writer of settings and the QA dictionary (serialized writes)
├── content/
│   ├── content.ts               Orchestrator: detection, per-player session, subtitle flow
│   ├── LiveTranslator.ts        Translation of the subtitle on screen (cache → prefetch → batch → single)
│   ├── SubtitleDetector.ts      Finds <video>, player container, caption container
│   ├── SubtitleObserver.ts      DOM caption observer (fallback source only)
│   ├── VTTPreFetcher.ts         VTT timeline source + prefetch of upcoming units
│   ├── CueGrouper.ts            Translation batches (prefetch windows / live batch)
│   ├── SentenceSegmenter.ts     Conservative English clean-up (DOM-only mode)
│   ├── SubtitleRenderer.ts      Overlay, "…" loading state, error + retry, fallback marker
│   ├── SubtitleFormatter.ts     ≤2 balanced lines, no dangling prepositions (NBSP)
│   ├── SelectionTranslator.ts, WordTooltip.ts
├── subtitles/                   Pure, unit-tested logic
│   ├── VttParser.ts             WebVTT → cues (tags stripped, entities decoded)
│   ├── SentenceAssembler.ts     Cues → sentence units; binary search on the timeline
│   ├── trackSelection.ts        Source-language track choice
│   └── vttMatching.ts           Identifies the player's caption file by the caption on screen
├── translation/
│   ├── TranslationManager.ts    Cache → priority queue → provider → optional fallback (SW)
│   ├── TranslationCache.ts      IndexedDB, keys namespaced by provider/model/prompt version
│   ├── TranslationClient.ts     Content-side memory cache + in-flight map
│   ├── TranslationProvider.ts   Provider interface + typed ProviderError
│   ├── providerUtils.ts         Timeouts, HTTP error mapping, endpoint checks, LLM parsing
│   ├── promptTemplates.ts       Batch (JSON) and single (plain text) prompts, per-language guidance
│   ├── TerminologyProcessor.ts  Case-preserving IT/QA fixes (machine translation into Russian only)
│   └── *Provider.ts             Google Free, Google Cloud, DeepL, OpenAI, Gemini, LibreTranslate
└── shared/
    ├── messages.ts              Typed message contract (background requests, tab messages)
    ├── settings.ts              Settings schema: validation, versioned migrations, public view
    ├── storage.ts               Read access for trusted contexts, dictionary helpers
    ├── types.ts, constants.ts, utils.ts, dom.ts
```

## Contexts and data flow

```
 popup / options / dictionary            service worker                        Udemy tab (content script)
 ─────────────────────────────           ───────────────────────────           ──────────────────────────
 read chrome.storage directly ──┐        SettingsStore (only writer)
 UPDATE_SETTINGS, UPDATE_PROVIDER_CONFIG ─► validate → write ──► storage.onChanged
 CLEAR_CACHE, DELETE_WORD, GET_CACHE_STATS                        │
                                         reconfigure TranslationManager
                                         SETTINGS_CHANGED (no credentials) ─────► apply settings
                                         CACHE_CLEARED ─────────────────────────► drop memory cache
                                         URL_CHANGED (tabs.onUpdated) ──────────► lesson change
                                         ◄──── GET_SETTINGS, TRANSLATE_TEXT/BATCH, CANCEL_PREFETCH,
                                               FETCH_VTT, SAVE_WORD
```

- **Every message is declared once** in `shared/messages.ts` with its payload and result type. `sendToBackground` / `sendToTab` are type-checked and the router has to handle every action.
- **Credentials never reach the Udemy page process.** Content scripts do not use `chrome.storage` at all (a storage listener would receive every change, keys included); they receive `PublicSettings` — settings without `providerConfigs`. Changes of the model, endpoint or key of the active provider reach them only as the `translationChanged` flag.
- **One writer.** `chrome.storage` has no transactions, so concurrent read → merge → write cycles from several contexts lost updates. All writes go through `SettingsStore` in the service worker, which applies them one after another, validates them and persists migrations.
- **Configuration and deletion actions** (`UPDATE_SETTINGS`, `UPDATE_PROVIDER_CONFIG`, `CLEAR_CACHE`, `DELETE_WORD`) are accepted only from extension pages, identified by their `chrome-extension://` origin (`sender.tab` is not a usable signal: the options page runs in a tab too). Payloads from content scripts are validated.

## Settings

- `shared/settings.ts` holds defaults, ranges and enums. `sanitizeSettings` runs on every read and write: unknown keys are dropped, invalid values fall back to defaults, numbers are clamped (an empty number field used to store `NaN`, which disabled cache expiry and eviction).
- `migrateSettings` upgrades stored settings step by step (`schemaVersion`); the store persists the result, so a migration runs once. v1 → v2 moves the legacy shared API key into the active provider's config, replaces retired Gemini models and the removed Chrome built-in provider.

## Subtitle pipeline

```
<track src> / video.textTracks ──► VttParser ──► cues
                                                  │
                    smartSentenceMode ─► SentenceAssembler ──► units (sentences, ≤7 s, ≤110 chars)
                                                  │
video clock (requestVideoFrameCallback + timeupdate) ──► active unit ──► LiveTranslator ──► Renderer
                                                  │
              CueGrouper ──► TRANSLATE_BATCH (low: prefetch windows ~30–75 s; high: live batch)
```

- **One source of truth.** While a VTT timeline is loaded, only the video clock drives the display; the DOM caption observer is a fallback for players without an accessible track.
- **Sentence units.** Fragments ("We need to configure" | "the server first.") are merged, translated and shown as one unit over the time span of their cues. Merging stops at sentence ends, pauses (>1 s), 7 s or 110 characters, or after a long clause ending in a comma. Code lines stay separate.
- **Timestamps** always come from the VTT; they are never sent to or read from the LLM.
- **Two clocks on purpose:** `requestVideoFrameCallback` gives frame-accurate updates while playing; `timeupdate` keeps the timeline correct while paused/seeking, where the frame callback does not fire, and loads the timeline lazily.

## Translation pipeline

```
LiveTranslator / TranslationClient (content)      TranslationManager (service worker)
  memCache hit? ─► show                             hot cache → IndexedDB (namespace = provider:model:promptVersion)
  pending prefetch? ─► await it                     priority queue (high > normal > low), shared concurrency limit
  live batch (high) ─► TRANSLATE_BATCH ───────────► only uncached segments go to the provider
  single request ───► TRANSLATE_TEXT ────────────►  circuit breaker (429: 60 s, 401/404: 5 min)
                                                    fallback → Google Free only if `fallbackToGoogle` is on,
                                                    flagged `fallback`, stored under its own namespace
```

Invariants:
- A failed, cancelled or dropped translation is an **error or an empty segment** — never the original text, and never cached.
- Cancellation (seek, lesson change, queue overflow) rejects with `ProviderError('cancelled')`.
- Only the latest live request renders; older ones are stale (`LiveTranslator`).
- **Fallback is opt-in.** Without it, subtitle text goes to the selected provider only; while a provider's breaker is open, requests fail fast with the error that opened it. With it, fallback translations are marked in the overlay ("· Google") and stay in the content cache for 2 minutes only, so the configured provider is retried soon.
- LLM output is used as is; regex terminology fixes apply to machine-translation providers translating into Russian.
- Prompts add language-specific guidance (form of address, IT terms, example) only for the target language it is written for (Russian, Ukrainian); other languages get neutral rules. Bump `PROMPT_VERSION` when prompts change.

Why three caches: the content memory cache answers synchronously within a video frame (a message round-trip cannot); the service worker hot cache saves IndexedDB reads; IndexedDB persists across sessions and survives the service worker being stopped.

## Lifecycle

- Each detected player starts a **session** (`AbortController`): all video/track listeners and the frame loop are bound to it and removed on lesson change.
- Lesson changes are detected by the background (`tabs.onUpdated` → `URL_CHANGED`) and deduplicated by URL path — hash/query changes (lecture tabs) are ignored. Content scripts run in an isolated world and cannot observe the page's `history.pushState`, so they do not watch navigation themselves.
- Settings pushes with `translationChanged` (provider, model, endpoint, key, languages, fallback policy) clear the content cache and re-render the current subtitle.
- The service worker can be stopped at any time; its queue, hot cache and breakers are in memory and start empty again, while settings and the translation cache are persistent.

## Security and privacy

- Permissions: `storage`, `unlimitedStorage`, `webRequest` (observes caption-file downloads only) + host permissions for Udemy and the translation APIs. Custom endpoints on other hosts are requested as optional host permissions when saved.
- API keys are stored per provider in `chrome.storage.local` (plain text in the browser profile — use restricted keys with a spending limit) and are only read by the service worker and extension pages. Gemini/Google Cloud keys are sent in the `x-goog-api-key` header.
- Custom endpoints must be `https://` (or `http://localhost`), otherwise the default endpoint is used.
- `FETCH_VTT` only fetches `https://*.udemycdn.com` / `*.udemy.com`.
- All dynamic HTML is escaped before `innerHTML`; CSV export neutralizes spreadsheet formulas.
- Debug logging (which prints subtitle text) is compiled into development builds only.

## Known limitations

- The Udemy player (Shaka) renders captions itself and exposes no `<track>`/`textTracks`. The caption file is found instead through Resource Timing (content script) and `webRequest.onCompleted` (background; also sees requests made outside the page's main document), and is accepted only after one of its cues matches the caption on screen at the current time and it covers at least half of the video. Until then the extension works in DOM-only mode (per-cue translation).
- The Google Translate free endpoint is unofficial and may be rate-limited or changed without notice.
