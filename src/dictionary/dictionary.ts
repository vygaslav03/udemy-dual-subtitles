/**
 * Dictionary Page Script — Udemy Dual Subtitles.
 *
 * Reads the dictionary from storage (trusted extension page); deletions go through the background.
 */
import { exportDictionaryToCsv, onDictionaryChanged, readDictionary, searchEntries } from '../shared/storage';
import { sendToBackground } from '../shared/messages';
import { escapeHtml } from '../shared/utils';
import type { DictionaryEntry } from '../shared/types';

class DictionaryController {
  private allWords: DictionaryEntry[] = [];
  private query = '';

  async init(): Promise<void> {
    await this.loadWords();
    this.bindEvents();
  }

  private async loadWords(): Promise<void> {
    this.allWords = await readDictionary();
    this.render();
  }

  /** Renders the words matching the current search (kept across deletions and live updates). */
  private render(): void {
    this.renderWords(searchEntries(this.allWords, this.query));
  }

  private bindEvents(): void {
    // Search
    const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
    searchInput?.addEventListener('input', () => {
      this.query = searchInput.value;
      this.render();
    });

    // Export CSV
    document.getElementById('exportCsv')?.addEventListener('click', () => {
      this.exportCsv();
    });

    // Delete (one delegated listener for all cards)
    document.getElementById('wordList')?.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-delete-id]');
      const id = btn?.dataset.deleteId;
      if (!id) return;
      await sendToBackground('DELETE_WORD', { id });
      this.allWords = this.allWords.filter((w) => w.id !== id);
      this.render();
    });

    // Auto-update when words are added from a Udemy tab
    onDictionaryChanged(() => this.loadWords());
  }

  private renderWords(words: DictionaryEntry[]): void {
    const container = document.getElementById('wordList')!;
    const emptyState = document.getElementById('emptyState');
    const wordCount = document.getElementById('wordCount');

    if (wordCount) {
      wordCount.textContent = `${words.length} word${words.length !== 1 ? 's' : ''}`;
    }

    if (words.length === 0) {
      container.innerHTML = '';
      if (emptyState) {
        container.appendChild(emptyState);
        emptyState.style.display = '';
      }
      return;
    }

    container.innerHTML = words.map((word) => this.renderWordCard(word)).join('');
  }

  private renderWordCard(entry: DictionaryEntry): string {
    const date = new Date(entry.addedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    let qaSection = '';
    if (entry.qaMeaning) {
      qaSection = `
        <div class="word-qa">
          <div class="word-qa-label">QA Meaning</div>
          <div>${escapeHtml(entry.qaMeaning)}</div>
        </div>
      `;
    }

    let exampleSection = '';
    if (entry.example) {
      exampleSection = `<div class="word-example">"${escapeHtml(entry.example)}"</div>`;
    }

    return `
      <div class="dict-word">
        <div class="word-top">
          <span class="word-main">${escapeHtml(entry.word)}</span>
        </div>
        <div class="word-translation">${escapeHtml(entry.translation)}</div>
        ${qaSection}
        ${exampleSection}
        <div class="word-meta">
          <span class="word-date">${date}</span>
          <button class="word-delete" data-delete-id="${escapeHtml(entry.id)}">🗑️ Delete</button>
        </div>
      </div>
    `;
  }

  private exportCsv(): void {
    if (this.allWords.length === 0) {
      alert('No words to export');
      return;
    }

    const csv = exportDictionaryToCsv(this.allWords);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qa-dictionary-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    // Revoke after the download has started
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const dictionary = new DictionaryController();
dictionary.init().catch(console.error);
