# Udemy Dual Subtitles

A personal Chrome Extension that displays dual subtitles (English + Russian translation) on Udemy courses for QA learning.

## Features

- 🎯 **Dual Subtitles** — English original + Russian translation displayed simultaneously
- 🔄 **Multiple Translation Providers** — Google Translate (free), DeepL, Google Cloud, OpenAI, Gemini, LibreTranslate
- 🧩 **Sentence units** — subtitle fragments are merged into sentences before translation, so Russian word order and context survive
- 💾 **Translation Cache** — IndexedDB cache (per provider/model) to avoid redundant API calls
- 📖 **QA Dictionary** — Save and review QA-specific terminology
- 🎓 **QA Learning Mode** — Click any word in subtitles for translation + QA context
- 🌐 **Selection Translation** — Translate any selected text on the page
- ⌨️ **Keyboard Shortcuts** — Quick toggles and size adjustments
- 🎨 **Customizable Appearance** — Font size, colors, opacity, position
- 🔒 **Privacy-First** — No analytics, no telemetry, no data collection
- ⚡ **SPA-Aware** — Works seamlessly across lesson changes

## Installation

### Quick install (no Node.js needed)

1. Open the repository's **Releases** page and download `udemy-dual-subtitles.zip` from the latest release
2. Unzip it into a folder you will keep (Chrome loads the extension from that folder)
3. Open `chrome://extensions/`, enable **Developer mode** (top right)
4. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`)

To update: download the new zip, replace the folder contents, and click ↻ on the extension in `chrome://extensions/`.

> Note: **Code → Download ZIP** gives you the source code, not the extension. Chrome will say the manifest is missing. Use the zip from Releases or build it yourself (below).

### Publishing a release (for the maintainer)

Bump nothing by hand — push a version tag and GitHub Actions builds the extension, sets the manifest version from the tag, and attaches the zip to a release:

```bash
git tag v1.0.1
git push origin v1.0.1
```

## Building from source

### Prerequisites

- Node.js 18+
- npm 9+
- Google Chrome

### Build

```bash
cd udemy-dual-subtitles
npm install
npm run build
```

### Load into Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `dist` folder

### Development

```bash
npm run dev    # Watch mode — rebuilds on changes (with debug logging)
npm run check  # Lint, type check (sources + tests) and unit tests — what CI runs before the build
```

After rebuilding, go to `chrome://extensions/` and click the ↻ reload button on the extension.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together.

## Configuration

### 1. Choose Translation Provider

Open the extension popup → click **⚙ Settings** → **Translation Provider**.

| Provider | API Key Required | Notes |
|:---|:---|:---|
| Google Translate (Free) | No | Default. Uses unofficial endpoint. Good for personal use. |
| Google Cloud | Yes | Official API. 500K chars/month free tier. |
| DeepL | Yes | High quality translations. |
| OpenAI | Yes | GPT-based translation. |
| Gemini | Yes | Google Gemini AI. |
| LibreTranslate | Optional | Self-hosted, open source. |

### 2. Add API Key (if needed)

Settings → **API Key** → paste your key. It's stored locally in `chrome.storage.local`, read only by the extension's background worker and pages (never by the script running on Udemy pages), and only sent to your chosen provider endpoint.

A **custom endpoint** (e.g. a self-hosted LibreTranslate or an OpenAI-compatible server) must be `https://` or `http://localhost`; Chrome asks for access to its host when you save it.

### 3. Fallback to Google Translate (optional)

Settings → **Translation Behavior** → **Fall back to Google Translate on errors**. Off by default: subtitle text is then sent only to the provider you chose, and errors (missing key, quota, outage) are shown under the subtitle. When on, failed requests are retried with Google Translate (free) and those translations are marked "· Google".

### 4. Enable Dual Subtitles

- Click the extension icon → toggle **ON**
- Or press **Alt + D**

### 5. Choose Languages

Popup → select **Source** (English) and **Translation** (Russian) languages.

## Keyboard Shortcuts

| Shortcut | Action |
|:---|:---|
| `Alt + D` | Toggle dual subtitles (ON / OFF) |
| `Alt + T` | Toggle translation line visibility |
| `Alt + Up` | Increase subtitle font size |
| `Alt + Down` | Decrease subtitle font size |

Customize shortcuts: `chrome://extensions/shortcuts`

## QA Learning Mode

1. Enable in Settings → **QA Learning Mode**
2. Click any word in subtitles to see:
   - Translation
   - QA-specific meaning (for terms like "severity", "regression", "assertion")
   - Usage example
3. Save words to your personal **QA Dictionary**
4. Export saved words as CSV

## Project Structure

```
udemy-dual-subtitles/
├── src/
│   ├── content/          # Content script (injected into Udemy)
│   ├── background/       # Service worker: message router, settings store
│   ├── subtitles/        # Pure subtitle logic (VTT parsing, sentence units)
│   ├── translation/      # Translation providers, cache, queue
│   ├── popup/            # Extension popup
│   ├── options/          # Settings page
│   ├── dictionary/       # QA Dictionary page
│   └── shared/           # Types, settings schema, message contract, storage, utilities
├── tests/                # Vitest unit tests
├── public/
│   ├── manifest.json     # Chrome Extension manifest
│   └── icons/            # Extension icons
├── vite.config.ts        # Build configuration
├── eslint.config.js      # Lint configuration
├── tsconfig.json         # TypeScript configuration
└── package.json
```

## Privacy

This extension:
- ✅ Works only on `udemy.com`
- ✅ Stores all data locally (settings, cache, dictionary)
- ✅ API key is stored in `chrome.storage.local` only and never passed to the script running on Udemy pages
- ✅ Subtitle text goes only to the provider you choose (unless you enable the Google fallback)
- ✅ No analytics or telemetry
- ✅ No data collection
- ❌ Does not access other sites
- ❌ Does not bypass DRM or security mechanisms
- ⚠️ Caches subtitle text and its translation locally (IndexedDB, TTL from settings, 30 days by default); clear it in Settings → Cache
- ⚠️ Subtitle text is sent to the translation provider you choose

## Disclaimer

This is an independent, unofficial project. It is not affiliated with, endorsed by, or connected to Udemy, Inc.

- It only reads the subtitles that the Udemy player already shows to a logged-in user, for that user's own viewing.
- It does not download, store for redistribution, or share course videos or subtitles, and it does not bypass DRM or any access control.
- Translation requests are sent to the provider you choose, with your own API key. Check that provider's terms and your course's terms before use.

## License

No license has been chosen yet, so all rights are reserved by the author. Open an issue if you would like to reuse the code.
