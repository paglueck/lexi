// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import type { Term, TermImportMode, TermImportRow, TermPatchRequest } from '@lexi/shared';
import { localeValue } from '@lexi/shared/termbase-csv';

import { TermBaseApi } from '../api/termbase-api.js';
import { messageOf } from '../api/server-message.js';

export const TERM_FILTERS = ['all', 'translated', 'dnt', 'fallback'] as const;
export type TermFilter = (typeof TERM_FILTERS)[number];

/** How long a text edit waits for the next keystroke before it is written. */
const SAVE_DELAY_MS = 300;

/**
 * The Term Base tab (FR-5.8, FR-5.9).
 *
 * Every edit saves — there is no save button. An edit lands in `terms` at
 * once, so the table and the prompt line follow the keyboard, and reaches the
 * server after `SAVE_DELAY_MS` of quiet, merged per term: typing a word writes
 * `.lexi/termbase.csv` once, not once per letter. A toggle is written at once.
 *
 * A server answer replaces the local term only when nothing newer is queued
 * for it; otherwise it would put back the letters typed while it was in flight.
 */
@Injectable({ providedIn: 'root' })
export class TermBaseStore {
  readonly #api = inject(TermBaseApi);

  readonly #terms = signal<readonly Term[]>([]);
  readonly #path = signal('.lexi/termbase.csv');
  readonly #linked = signal(false);
  readonly #available = signal(true);
  readonly #loaded = signal(false);
  readonly #error = signal<string | null>(null);
  readonly #selectedId = signal<string | null>(null);

  readonly terms = this.#terms.asReadonly();
  readonly path = this.#path.asReadonly();
  /** True while the Term Base comes from a shared folder; `available` is false when it is missing. */
  readonly linked = this.#linked.asReadonly();
  readonly available = this.#available.asReadonly();
  readonly loaded = this.#loaded.asReadonly();
  readonly error = this.#error.asReadonly();
  readonly selectedId = this.#selectedId.asReadonly();

  readonly filter = signal<TermFilter>('all');
  readonly query = signal('');

  /** Locales the "Uses source" filter and the table count over. Set by the page. */
  readonly locales = signal<readonly string[]>([]);

  readonly #pending = new Map<
    string,
    { patch: TermPatchRequest; timer: ReturnType<typeof setTimeout> }
  >();

  readonly selected = computed(() => this.#terms().find((t) => t.id === this.#selectedId()));

  readonly counts = computed<Record<TermFilter, number>>(() => {
    const terms = this.#terms();
    const out = { all: 0, translated: 0, dnt: 0, fallback: 0 };
    for (const t of terms) {
      for (const f of TERM_FILTERS) if (this.#passes(t, f)) out[f] += 1;
    }
    return out;
  });

  /** The table: the filter, then the search over the term and every translation. */
  readonly rows = computed(() => {
    const filter = this.filter();
    const q = this.query().trim().toLowerCase();
    return this.#terms().filter(
      (t) =>
        this.#passes(t, filter) &&
        (q === '' ||
          t.term.toLowerCase().includes(q) ||
          Object.values(t.translations).some((v) => v.toLowerCase().includes(q))),
    );
  });

  #passes(t: Term, filter: TermFilter): boolean {
    switch (filter) {
      case 'all':
        return true;
      case 'translated':
        return !t.dnt;
      case 'dnt':
        return t.dnt;
      case 'fallback':
        return !t.dnt && this.locales().some((l) => localeValue(t.translations, l) === '');
    }
  }

  async load(): Promise<void> {
    this.#error.set(null);
    try {
      const response = await this.#api.list();
      this.#terms.set(response.terms);
      this.#path.set(response.path);
      this.#linked.set(response.linked);
      this.#available.set(response.available);
      if (this.selected() === undefined) this.#selectedId.set(response.terms[0]?.id ?? null);
    } catch (error) {
      this.#error.set(messageOf(error, 'The term base could not be loaded.'));
    } finally {
      this.#loaded.set(true);
    }
  }

  select(id: string): void {
    this.#selectedId.set(id);
  }

  /** "Add term": an untitled term on top, selected, with the filter and search cleared. */
  async add(): Promise<void> {
    this.#error.set(null);
    try {
      const created = await this.#api.add({});
      this.#terms.set([created, ...this.#terms()]);
      this.#selectedId.set(created.id);
      this.filter.set('all');
      this.query.set('');
    } catch (error) {
      this.#error.set(messageOf(error, 'The term could not be added.'));
    }
  }

  /** Apply an edit now and write it after a pause, or at once with `immediate`. */
  update(
    id: string,
    patch: TermPatchRequest,
    { immediate = false }: { immediate?: boolean } = {},
  ): void {
    this.#terms.set(this.#terms().map((t) => (t.id === id ? { ...t, ...definedOf(patch) } : t)));

    const queued = this.#pending.get(id);
    if (queued !== undefined) clearTimeout(queued.timer);
    const merged = { ...queued?.patch, ...definedOf(patch) };
    const timer = setTimeout(() => void this.#flush(id), immediate ? 0 : SAVE_DELAY_MS);
    this.#pending.set(id, { patch: merged, timer });
  }

  setTranslation(id: string, locale: string, value: string): void {
    const term = this.#terms().find((t) => t.id === id);
    if (term === undefined) return;
    const translations = { ...term.translations };
    if (value === '') delete translations[locale];
    else translations[locale] = value;
    this.update(id, { translations });
  }

  toggleDnt(id: string): void {
    const term = this.#terms().find((t) => t.id === id);
    if (term !== undefined) this.update(id, { dnt: !term.dnt }, { immediate: true });
  }

  /** Write whatever is still queued — before the screen goes away. */
  flushAll(): void {
    for (const id of [...this.#pending.keys()]) void this.#flush(id);
  }

  async #flush(id: string): Promise<void> {
    const queued = this.#pending.get(id);
    if (queued === undefined) return;
    clearTimeout(queued.timer);
    this.#pending.delete(id);
    this.#error.set(null);
    try {
      const saved = await this.#api.patch(id, queued.patch);
      if (!this.#pending.has(id)) {
        this.#terms.set(this.#terms().map((t) => (t.id === id ? saved : t)));
      }
    } catch (error) {
      this.#error.set(messageOf(error, 'The term could not be saved.'));
    }
  }

  /** "Delete term": the first remaining term is selected next, or none. */
  async remove(id: string): Promise<void> {
    const queued = this.#pending.get(id);
    if (queued !== undefined) {
      clearTimeout(queued.timer);
      this.#pending.delete(id);
    }
    this.#error.set(null);
    try {
      const response = await this.#api.remove(id);
      this.#terms.set(response.terms);
      if (this.#selectedId() === id) this.#selectedId.set(response.terms[0]?.id ?? null);
    } catch (error) {
      this.#error.set(messageOf(error, 'The term could not be deleted.'));
    }
  }

  /** CSV import. Resolves true when it landed; the filter and search reset. */
  async import(
    rows: readonly TermImportRow[],
    mode: TermImportMode,
    locales: readonly string[],
  ): Promise<boolean> {
    this.flushAll();
    this.#error.set(null);
    try {
      const response = await this.#api.import({ rows: [...rows], mode, locales: [...locales] });
      this.#terms.set(response.terms);
      this.filter.set('all');
      this.query.set('');
      if (this.selected() === undefined) this.#selectedId.set(response.terms[0]?.id ?? null);
      return true;
    } catch (error) {
      this.#error.set(messageOf(error, 'The terms could not be imported.'));
      return false;
    }
  }
}

/** Only the keys that carry a value — a PATCH must not erase what it did not mention. */
function definedOf(patch: TermPatchRequest): Partial<Term> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<Term>;
}
