# Testing Checklist — Udemy Dual Subtitles

## Prerequisites

- Chrome with Developer mode enabled
- Extension loaded via "Load unpacked" from `dist/` folder
- Udemy account with a course that has English subtitles

---

## Build

- [ ] `npm install` completes without errors
- [ ] `npm run build` completes without errors
- [ ] TypeScript `tsc --noEmit` passes with 0 errors
- [ ] `dist/` folder contains all expected files

## Extension Loading

- [ ] Extension loads in Chrome without errors
- [ ] Extension icon appears in toolbar
- [ ] No errors in `chrome://extensions/` page
- [ ] Service worker is "Active"

## Subtitle Detection

- [ ] English subtitles detected on Udemy course page
- [ ] Detection works after page refresh
- [ ] Detection works after initial page load
- [ ] Detection retries if player not loaded yet
- [ ] Console shows detection strategy used

## Translation

- [ ] Translation appears below English subtitle
- [ ] "…" indicator appears if a translation takes longer than ~0.4 s
- [ ] Translation updates when subtitle changes
- [ ] Original English text never disappears
- [ ] Cache hit — repeated subtitle shows instantly
- [ ] Cache miss — new subtitle triggers translation
- [ ] Duplicate subtitle text doesn't trigger extra requests

## Error Handling

- [ ] API failure shows "Translation unavailable"
- [ ] Retry button appears on error
- [ ] Retry button triggers re-translation
- [ ] Extension doesn't break video playback on error
- [ ] No unhandled exceptions in console

## Long Subtitles

- [ ] Long text wraps correctly
- [ ] No text overflow outside container
- [ ] No horizontal scrollbar appears
- [ ] Multi-line subtitles display properly

## Empty/Edge Cases

- [ ] Empty subtitle handled gracefully
- [ ] Very short subtitle (1-2 words) works
- [ ] Very long subtitle (100+ words) wraps properly
- [ ] Special characters in subtitle displayed correctly

## Navigation

- [ ] Lesson change: subtitles re-detected
- [ ] Page refresh: extension re-initializes
- [ ] SPA navigation: no page reload needed
- [ ] Back/Forward navigation works

## Fullscreen

- [ ] Subtitles visible in fullscreen mode
- [ ] Subtitles positioned correctly in fullscreen
- [ ] Exit fullscreen: subtitles still work
- [ ] Window resize: subtitles adjust

## Popup

- [ ] Popup opens on icon click
- [ ] Toggle ON/OFF works
- [ ] Language selection changes saved
- [ ] Status indicator updates correctly
- [ ] Settings button opens options page
- [ ] Dictionary button opens dictionary page
- [ ] Provider name displayed

## Options Page

- [ ] Opens via popup or direct URL
- [ ] All settings load correctly
- [ ] Changes auto-save
- [ ] "Settings saved" toast appears
- [ ] Font size slider works
- [ ] Color picker works
- [ ] Background opacity slider works
- [ ] Position selector works
- [ ] Provider change shows/hides API fields
- [ ] Cache stats displayed
- [ ] Clear cache button works

## QA Learning Mode

- [ ] Enable/disable in settings
- [ ] Click word in subtitle shows tooltip
- [ ] Tooltip shows translation
- [ ] QA terms show meaning and example
- [ ] "Save" button saves word to dictionary
- [ ] "Saved" confirmation shown
- [ ] Tooltip closes on "Close" click
- [ ] Non-QA terms show translation only

## QA Dictionary

- [ ] Dictionary page opens
- [ ] Saved words displayed
- [ ] Search filters words
- [ ] Delete button removes word
- [ ] Word count updates
- [ ] CSV export downloads file
- [ ] Exported CSV contains correct data
- [ ] Empty state shown when no words

## Selection Translation

- [ ] Select text on Udemy page
- [ ] "Translate" button appears
- [ ] Click translates selected text
- [ ] Translation popup shows result
- [ ] Close button works
- [ ] "Save word" button works (if QA mode on)

## Keyboard Shortcuts

- [ ] Alt+D toggles dual subtitles
- [ ] Alt+T toggles translation line
- [ ] Alt+Up increases font size
- [ ] Alt+Down decreases font size
- [ ] Shortcuts work during video playback

## Performance

- [ ] No visible lag during video playback
- [ ] No excessive CPU usage
- [ ] MutationObserver: no infinite loops
- [ ] Network: cached translations not re-requested
- [ ] Extension doesn't slow page load

## Privacy

- [ ] Extension only active on udemy.com
- [ ] No network requests to unexpected domains
- [ ] API key not leaked to console/network
- [ ] No analytics or tracking requests
