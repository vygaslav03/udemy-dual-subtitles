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
npm run dev    # Watch mode — rebuilds on changes
```

After rebuilding, go to `chrome://extensions/` and click the ↻ reload button on the extension.

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

Settings → **API Key** → paste your key. It's stored locally in `chrome.storage.local` and only sent to your chosen provider endpoint.

### 3. Enable Dual Subtitles

- Click the extension icon → toggle **ON**
- Or press **Alt + D**

### 4. Choose Languages

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
│   ├── background/       # Service worker
│   ├── translation/      # Translation providers, cache, queue
│   ├── popup/            # Extension popup
│   ├── options/          # Settings page
│   ├── dictionary/       # QA Dictionary page
│   └── shared/           # Types, storage, utilities
├── public/
│   ├── manifest.json     # Chrome Extension manifest
│   └── icons/            # Extension icons
├── vite.config.ts        # Build configuration
├── tsconfig.json         # TypeScript configuration
└── package.json
```

## Privacy

This extension:
- ✅ Works only on `udemy.com`
- ✅ Stores all data locally (settings, cache, dictionary)
- ✅ API key is stored in `chrome.storage.local` only
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
