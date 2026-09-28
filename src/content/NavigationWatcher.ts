/**
 * NavigationWatcher — detects SPA navigation and page changes on Udemy.
 *
 * Udemy is a React SPA. When switching between lessons, the URL changes
 * but the page doesn't fully reload. We need to detect these transitions
 * to re-initialize subtitle detection.
 */
import { log } from '../shared/utils';

export type NavigationCallback = (url: string) => void;

export class NavigationWatcher {
  private callback: NavigationCallback;
  private lastUrl: string;
  private observer: MutationObserver | null = null;
  private destroyed = false;

  constructor(callback: NavigationCallback) {
    this.callback = callback;
    this.lastUrl = window.location.href;
  }

  /**
   * Starts watching for navigation changes.
   */
  start(): void {
    this.destroyed = false;
    this.lastUrl = window.location.href;

    // Note: history.pushState/replaceState patching was removed because content
    // scripts run in an isolated world and cannot intercept React's history calls
    // in the main world. Primary SPA detection is via chrome.tabs.onUpdated in
    // background.ts which sends URL_CHANGED messages.

    // 1. Listen for popstate (back/forward navigation)
    window.addEventListener('popstate', this.handleNavigation);

    // 2. MutationObserver on <title> as a backup
    // Udemy changes the page title when navigating between lessons
    const titleElement = document.querySelector('title');
    if (titleElement) {
      this.observer = new MutationObserver(() => {
        this.checkUrlChange();
      });
      this.observer.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    log('NavigationWatcher started');
  }

  /**
   * Checks if URL has changed and triggers callback.
   */
  private handleNavigation = (): void => {
    if (this.destroyed) return;

    // Use setTimeout to let the DOM update
    setTimeout(() => {
      this.checkUrlChange();
    }, 100);
  };

  /**
   * Compares current URL with last known URL.
   */
  private checkUrlChange(): void {
    const currentUrl = window.location.href;
    if (currentUrl !== this.lastUrl) {
      log(`Navigation detected: ${this.lastUrl} → ${currentUrl}`);
      this.lastUrl = currentUrl;
      this.callback(currentUrl);
    }
  }

  /**
   * Stops watching for navigation.
   */
  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('popstate', this.handleNavigation);

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    log('NavigationWatcher destroyed');
  }
}
