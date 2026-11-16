// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type ElementRef,
  type OnDestroy,
} from '@angular/core';
import type { Term } from '@lexi/shared';
import { localeValue, termPromptLine } from '@lexi/shared/termbase-csv';

import { localeName } from '../../core/locale-name.js';
import { EventsStore } from '../../core/stores/events-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { TERM_FILTERS, TermBaseStore, type TermFilter } from '../../core/stores/termbase-store.js';
import { LxButton } from '../../ui/button.js';
import { LxInput } from '../../ui/field.js';
import { LxSharedSourceControl } from '../shared-sources/shared-source-control.js';
import { LxImportDialog } from './import-dialog.js';

const FILTER_LABEL: Record<TermFilter, string> = {
  all: 'All',
  translated: 'Translated',
  dnt: 'DNT',
  fallback: 'Uses source',
};

export interface TermLocale {
  readonly code: string;
  readonly name: string;
  readonly rtl: boolean;
}

const TERM_PX = 200;
const DNT_PX = 60;
const LOCALE_MIN_PX = 160;

/**
 * S13, the Term Base (FR-5.8, FR-5.9) — formerly the glossary pane on S6.
 *
 * One row per term, one column per project locale. A term either has a fixed
 * translation per locale or is DNT. THE FALLBACK RULE: an empty locale keeps
 * the source term as written — the table shows it as "= term", the prompt
 * says "keep as written", and validation holds the answer to it.
 *
 * DNT locks the translations, it does not delete them: toggling it off brings
 * them back.
 */
@Component({
  selector: 'lx-termbase-page',
  imports: [LxButton, LxInput, LxImportDialog, LxSharedSourceControl],
  templateUrl: './termbase-page.html',
  styleUrl: './termbase-page.css',
})
export class TermBasePage implements OnDestroy {
  protected readonly store = inject(TermBaseStore);
  readonly #project = inject(ProjectStore);

  /** The chosen CSV, read as UTF-8. The dialog is open while there is one. */
  protected readonly importFile = signal<{ readonly name: string; readonly text: string } | null>(
    null,
  );
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('file');
  protected readonly armedDelete = signal(false);

  protected readonly locales = computed<readonly TermLocale[]>(() =>
    this.#project
      .targetLocales()
      .map((l) => ({ code: l.locale, name: localeName(l.locale), rtl: l.isRtl })),
  );

  /**
   * Locale columns stretch to fill the table but never shrink below
   * LOCALE_MIN_PX; past that the table scrolls sideways, as the grid does.
   * `minWidth` keeps every row (and its border and highlight) as wide as the tracks.
   */
  protected readonly columns = computed(
    () =>
      `${TERM_PX}px ${DNT_PX}px repeat(${this.#localeCount()}, minmax(${LOCALE_MIN_PX}px, 1fr))`,
  );
  protected readonly minWidth = computed(
    () => TERM_PX + DNT_PX + this.#localeCount() * LOCALE_MIN_PX,
  );
  protected readonly termWidth = TERM_PX;
  readonly #localeCount = computed(() => Math.max(this.locales().length, 1));

  protected readonly filters = computed(() =>
    TERM_FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f], count: this.store.counts()[f] })),
  );

  /** The editor's "Prompt line" is the first target locale's — the README's "de run". */
  protected readonly promptLocale = computed(() => this.locales()[0]?.code ?? null);

  protected readonly selected = this.store.selected;

  protected readonly filled = computed(() => {
    const t = this.selected();
    return t === undefined
      ? 0
      : this.locales().filter((l) => localeValue(t.translations, l.code) !== '').length;
  });

  protected readonly status = computed(() => {
    const total = this.locales().length;
    const filled = this.filled();
    return filled === total
      ? 'All locales translated'
      : `${filled} translated · ${total - filled} as source`;
  });

  protected readonly storedNote = computed(() => {
    const n = this.filled();
    return `${n} stored ${n === 1 ? 'translation stays' : 'translations stay'} in termbase.csv and ${
      n === 1 ? 'comes' : 'come'
    } back if DNT is turned off.`;
  });

  protected readonly promptLine = computed(() => {
    const t = this.selected();
    const locale = this.promptLocale();
    if (t === undefined || locale === null) return '';
    return termPromptLine(
      {
        term: t.term.trim() || 'term',
        translation: t.dnt ? '' : localeValue(t.translations, locale),
        dnt: t.dnt,
        note: t.note,
      },
      locale,
    );
  });

  constructor() {
    void this.store.load();
    effect(() => this.store.locales.set(this.locales().map((l) => l.code)));
    // A different term disarms the delete; a click on a stale arm must not delete the new one.
    effect(() => {
      this.store.selectedId();
      this.armedDelete.set(false);
    });
    // A linked Term Base changed on disk. 0 is "never", not an event.
    const events = inject(EventsStore);
    effect(() => {
      if (events.sharedChangedAt().termbase === 0) return;
      untracked(() => void this.store.load());
    });
  }

  ngOnDestroy(): void {
    this.store.flushAll();
  }

  /** "Import CSV…" and "Choose another file…": the native picker first, the dialog after. */
  protected chooseFile(): void {
    const input = this.fileInput().nativeElement;
    input.value = '';
    input.click();
  }

  protected async onFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file === undefined) return;
    this.importFile.set({ name: file.name, text: await file.text() });
  }

  protected value(term: Term, code: string): string {
    return localeValue(term.translations, code);
  }

  protected sourceOf(term: Term): string {
    return term.term.trim() || 'term';
  }

  protected onQuery(event: Event): void {
    this.store.query.set((event.target as HTMLInputElement).value);
  }

  protected onTerm(id: string, event: Event): void {
    this.store.update(id, { term: (event.target as HTMLInputElement).value });
  }

  protected onNote(id: string, event: Event): void {
    this.store.update(id, { note: (event.target as HTMLInputElement).value });
  }

  protected onTranslation(id: string, code: string, event: Event): void {
    this.store.setTranslation(id, code, (event.target as HTMLInputElement).value);
  }

  protected toggleRowDnt(event: Event, id: string): void {
    // The row's own click selects it; the checkbox only toggles.
    event.stopPropagation();
    this.store.toggleDnt(id);
  }

  protected deleteSelected(): void {
    const t = this.selected();
    if (t === undefined) return;
    if (!this.armedDelete()) {
      this.armedDelete.set(true);
      return;
    }
    this.armedDelete.set(false);
    void this.store.remove(t.id);
  }

  /** ↑/↓ move the selection through the visible rows while the table has focus. */
  protected onTableKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const rows = this.store.rows();
    if (rows.length === 0) return;
    const at = rows.findIndex((t) => t.id === this.store.selectedId());
    const next = rows[Math.min(rows.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
    if (next !== undefined) {
      this.store.select(next.id);
      queueMicrotask(() =>
        document.getElementById(`term-row-${next.id}`)?.scrollIntoView({ block: 'nearest' }),
      );
    }
  }
}
