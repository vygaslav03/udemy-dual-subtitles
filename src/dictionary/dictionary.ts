/**
 * Dictionary Page Script — Udemy Dual Subtitles.
 */
import {
  getDictionaryWords,
  deleteDictionaryWord,
  searchDictionary,
  exportDictionaryToCsv,
} from '../shared/storage';
import type { DictionaryEntry } from '../shared/types';

class DictionaryController {
  private allWords: DictionaryEntry[] = [];

  async init(): Promise<void> {
    await this.loadWords();
    this.bindEvents();
  }

  private async loadWords(): Promise<void> {
    this.allWords = await getDictionaryWords();
    this.renderWords(this.allWords);
  }

  private bindEvents(): void {
    // Search
    const searchInput = document.getElementById('searchInput') as HTMLInputElement;
    searchInput?.addEventListener('input', async () => {
      const query = searchInput.value.trim();
      if (query) {
        const results = await searchDictionary(query);
        this.renderWords(results);
      } else {
        this.renderWords(this.allWords);
      }
    });

    // Export CSV
    document.getElementById('exportCsv')?.addEventListener('click', () => {
      this.exportCsv();
    });

    // Auto-update when words are added/removed from content script
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['uds_dictionary']) {
        this.loadWords();
      }
    });
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

    // Bind delete buttons
    container.querySelectorAll('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-delete-id')!;
        await deleteDictionaryWord(id);
        this.allWords = this.allWords.filter((w) => w.id !== id);
        this.renderWords(this.allWords);
      });
    });
  }

  private renderWordCard(entry: DictionaryEntry): string {
    const date = new Date(entry.addedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    const escapeHtml = (s: string) => {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    };

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
          <button class="word-delete" data-delete-id="${entry.id}">🗑️ Delete</button>
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
    URL.revokeObjectURL(url);
  }
}

const dictionary = new DictionaryController();
dictionary.init().catch(console.error);
