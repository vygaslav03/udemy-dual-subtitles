# Architecture — Udemy Dual Subtitles

## Overview

Chrome Extension (Manifest V3) that reads the English subtitles of the Udemy player, translates them and displays dual subtitles (original + translation) over the video.

## Technology Stack

- **TypeScript** (strict mode), **Vite** (two builds: extension pages + SW as ES modules, content script as a self-contained IIFE)
- **IndexedDB** (in the service worker) — translation cache
- **chrome.storage.local** — settings, per-provider credentials, QA dictionary
- **Vitest** — unit tests (`npm test`)

## Layout

```
src/
├── background/background.ts     Message router (sender checks), shortcuts, SPA navigation → URL_CHANGED
├── content/
│   ├── content.ts               Orchestrator: detection, per-player session, subtitle flow
│   ├── SubtitleDetector.ts      Finds <video>, player container, caption container
│   ├── SubtitleObserver.ts      DOM caption observer (fallback source only)
│   ├── VTTPreFetcher.ts         VTT timeline source + prefetch of upcoming units
│   ├── CueGrouper.ts            Translation batches (prefetch windows / live batch)
│   ├── SentenceSegmenter.ts     Conservative English clean-up (DOM-only mode)
│   ├── SubtitleRenderer.ts      Overlay, "…" loading state, error + retry
│   ├── SubtitleFormatter.ts     ≤2 balanced lines, no dangling prepositions (NBSP)
│   ├── NavigationWatcher.ts, SelectionTranslator.ts, WordTooltip.ts
├── subtitles/                   Pure, unit-tested logic
│   ├── VttParser.ts             WebVTT → cues (tags stripped, entities decoded)
│   ├── SentenceAssembler.ts     Cues → sentence units; binary search on the timeline
│   └── trackSelection.ts        Source-language track choice
├── translation/
│   ├── TranslationManager.ts    Cache → priority queue → provider → fallback (SW)
│   ├── TranslationCache.ts      IndexedDB, keys namespaced by provider/model/prompt version
│   ├── TranslationClient.ts     Content-side memory cache + in-flight map
│   ├── TranslationProvider.ts   Provider interface + typed ProviderError
│   ├── providerUtils.ts         Timeouts, HTTP error mapping, endpoint checks, LLM parsing
│   ├── promptTemplates.ts       Batch (JSON) and single (plain text) prompts
│   ├── TerminologyProcessor.ts  Case-preserving IT/QA fixes (machine translation only)
│   └── *Provider.ts             Google Free, Google Cloud, DeepL, OpenAI, Gemini, LibreTranslate
└── shared/                      types, constants, storage (settings migration), utils
```

## Subtitle pipeline

```
<track src> / video.textTracks ──► VttParser ──► cues
                                                  │
                    smartSentenceMode ─► SentenceAssembler ──► units (sentences, ≤7 s, ≤110 chars)
                                                  │
video clock (requestVideoFrameCallback + timeupdate) ──► active unit ──► Renderer
                                                  │
              CueGrouper ──► TRANSLATE_BATCH (low: prefetch windows ~30–75 s; high: live batch)
```

- **One source of truth.** While a VTT timeline is loaded, only the video clock drives the display; the DOM caption observer is a fallback for players without an accessible track.
- **Sentence units.** Fragments ("We need to configure" | "the server first.") are merged, translated and shown as one unit over the time span of their cues. Merging stops at sentence ends, pauses (>1 s), 7 s or 110 characters, or after a long clause ending in a comma. Code lines stay separate.
- **Timestamps** always come from the VTT; they are never sent to or read from the LLM.

## Translation pipeline

```
TranslationClient (content)                     TranslationManager (service worker)
  memCache hit? ─► show                           hot cache → IndexedDB (namespace = provider:model:promptVersion)
  pending prefetch? ─► await it                   priority queue (high > normal > low), shared concurrency limit
  live batch (high) ─► TRANSLATE_BATCH ─────────► only uncached segments go to the provider
  single request ───► TRANSLATE_TEXT ──────────►  circuit breaker (429: 60 s, 401/404: 5 min)
                                                  fallback → Google Free, flagged `fallback`, stored under its own namespace
```

Invariants:
- A failed, cancelled or dropped translation is an **error or an empty segment** — never the original text, and never cached.
- Cancellation (seek, lesson change, queue overflow) rejects with `ProviderError('cancelled')`.
- Fallback translations stay in the content cache for 2 minutes only, so the configured provider is retried soon.
- LLM output is used as is; regex terminology fixes apply to machine-translation providers only.

## Lifecycle

- Each detected player starts a **session** (`AbortController`): all video/track listeners and the frame loop are bound to it and removed on lesson change.
- Lesson changes are detected by NavigationWatcher and by the background (`tabs.onUpdated`), deduplicated by URL path — hash/query changes (lecture tabs) are ignored.
- Settings changes (provider, credentials, languages) clear the content cache and re-render the current subtitle.

## Security

- Permissions: `storage`, `unlimitedStorage` + host permissions for Udemy and the translation APIs.
- API keys are stored per provider in `chrome.storage.local` (plain text in the browser profile — use restricted keys with a spending limit). Gemini/Google Cloud keys are sent in the `x-goog-api-key` header.
- Custom endpoints must be `https://` (or `http://localhost`), otherwise the default endpoint is used.
- The background accepts messages from this extension only; `UPDATE_SETTINGS`/`CLEAR_CACHE` are refused from content scripts; `FETCH_VTT` only fetches `https://*.udemycdn.com` / `*.udemy.com`.
- All dynamic HTML is escaped before `innerHTML`.

## Known limitations

- Chrome Built-in (on-device) translation needs a window context; it is not offered until it runs in an offscreen document.
- The Udemy player (Shaka) renders captions itself and exposes no `<track>`/`textTracks`. The caption file is found instead through Resource Timing (content script) and `webRequest.onCompleted` (background), and is accepted only after one of its cues matches the caption on screen at the current time and it covers at least half of the video. Until then the extension works in DOM-only mode (per-cue translation).
