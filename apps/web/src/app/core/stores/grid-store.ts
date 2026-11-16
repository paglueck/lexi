// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import type { GridFilter, SearchScope, UnitsQueryRequest } from '@lexi/shared';

import { ProjectApi } from '../api/project-api.js';
import { ProjectStore } from './project-store.js';

/**
 * The grid's view state: what is being looked for, and through which columns.
 *
 * Kept apart from `UnitsStore` (which holds the ANSWERS) so that the thing the
 * query depends on is one small object with no network in it. `queryBody` is
 * the only computed that matters: `UnitsStore`'s `httpResource` reads it, so
 * every signal it touches is automatically a reason to re-query, and nothing
 * else is.
 *
 * FR-3.5 budgets 200 ms from the last keystroke to pixels. The search box feeds
 * `searchInput` on every character but `queryBody` reads the DEBOUNCED signal,
 * so a fast typist produces one request rather than one per key — and
 * `httpResource` aborts even that one if it is superseded.
 */
const SEARCH_DEBOUNCE_MS = 100;

@Injectable({ providedIn: 'root' })
export class GridStore {
  readonly #project = inject(ProjectStore);
  readonly #api = inject(ProjectApi);

  /** Bound to the search field. Updates on every keystroke. */
  readonly searchInput = signal('');
  /** What the query actually reads. Trails the input by the debounce. */
  readonly #search = signal('');
  readonly search = this.#search.asReadonly();

  readonly #scope = signal<SearchScope>('all');
  readonly #groups = signal<readonly string[]>([]);
  readonly #filters = signal<readonly GridFilter[]>([]);

  readonly scope = this.#scope.asReadonly();
  readonly groups = this.#groups.asReadonly();
  readonly filters = this.#filters.asReadonly();

  /**
   * The visible locale columns (FR-3.2).
   *
   * Seeded from the project — which has already had `.lexi/project.json`
   * applied server-side — and written back through PATCH so the choice
   * survives a restart.
   */
  readonly visibleLocales = computed<readonly string[]>(() => {
    const chosen = this.#columns();
    if (chosen !== null) return chosen;
    return this.#project.project()?.visibleLocales ?? [];
  });
  readonly #columns = signal<readonly string[] | null>(null);

  /**
   * Which locale the detail panel's ONE editor edits (M6).
   *
   * Null means "the first visible column". Clicking a target cell in the grid
   * sets it, which is how a ten-column project chooses what to work on without
   * needing ten editors — see the panel's own comment for why there is only one.
   */
  readonly #editLocale = signal<string | null>(null);
  readonly editLocale = computed<string | null>(() => {
    const chosen = this.#editLocale();
    // A column that has been hidden since it was chosen cannot stay the target.
    return chosen !== null && this.visibleLocales().includes(chosen) ? chosen : null;
  });

  readonly availableLocales = computed<readonly string[]>(() =>
    this.#project.targetLocales().map((l) => l.locale),
  );

  #timer: ReturnType<typeof setTimeout> | undefined;

  /** The `httpResource` body. Everything it reads is a reason to re-query. */
  readonly queryBody = computed<UnitsQueryRequest>(() => ({
    search: this.#search(),
    scope: this.#scope(),
    groups: [...this.#groups()],
    locales: [...this.visibleLocales()],
    filters: [...this.#filters()],
  }));

  readonly hasActiveFilters = computed(
    () => this.#filters().length > 0 || this.#groups().length > 0 || this.#search() !== '',
  );

  setSearch(text: string): void {
    this.searchInput.set(text);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#search.set(text), SEARCH_DEBOUNCE_MS);
  }

  setScope(scope: SearchScope): void {
    this.#scope.set(scope);
  }

  /** The namespace tree is single-select today; the wire shape allows more. */
  toggleGroup(group: string): void {
    this.#groups.update((groups) => (groups.includes(group) ? [] : [group]));
  }

  clearGroups(): void {
    this.#groups.set([]);
  }

  /**
   * Point the grid at one locale and one question — the dashboard's quick
   * actions (FR-2.3, FR-3.4).
   *
   * Replaces the columns and the filters rather than adding to them. A quick
   * action means "show me the 140 untranslated German strings"; leaving the
   * previous filters on would answer a different question and leave the user to
   * work out why the count does not match the button they just pressed.
   */
  focusLocale(locale: string, filters: readonly GridFilter[] = []): void {
    this.#columns.set(this.availableLocales().includes(locale) ? [locale] : []);
    this.#filters.set([...filters]);
    this.#groups.set([]);
    this.searchInput.set('');
    this.#search.set('');
    this.#editLocale.set(locale);
    void this.#persist();
  }

  toggleFilter(filter: GridFilter): void {
    this.#filters.update((filters) =>
      filters.includes(filter) ? filters.filter((f) => f !== filter) : [...filters, filter],
    );
    void this.#persist();
  }

  clearFilters(): void {
    this.#filters.set([]);
    void this.#persist();
  }

  /**
   * Take away everything that narrows the rows (filters, the namespace and the
   * search) but leave the columns alone. What "Open in grid" does when the row
   * it was sent to is filtered out.
   */
  clearView(): void {
    clearTimeout(this.#timer);
    this.searchInput.set('');
    this.#search.set('');
    this.#groups.set([]);
    this.clearFilters();
  }

  setVisibleLocales(locales: readonly string[]): void {
    this.#columns.set([...locales]);
    void this.#persist();
  }

  toggleLocale(locale: string): void {
    const current = this.visibleLocales();
    const next = current.includes(locale)
      ? current.filter((l) => l !== locale)
      : // Keep the project's own locale order rather than click order, so the
        // columns do not shuffle as the user ticks boxes.
        this.availableLocales().filter((l) => l === locale || current.includes(l));
    this.setVisibleLocales(next);
  }

  /** Reset everything that is not persisted. Called when a project closes. */
  setEditLocale(locale: string | null): void {
    this.#editLocale.set(locale);
  }

  reset(): void {
    clearTimeout(this.#timer);
    this.searchInput.set('');
    this.#search.set('');
    this.#scope.set('all');
    this.#groups.set([]);
    this.#filters.set([]);
    this.#columns.set(null);
    // A different project may have a different locale count, so a Focus scope
    // that was valid there is not automatically valid here (M12).
  }

  /**
   * Write the view back to `.lexi/project.json` (FR-3.2).
   *
   * Fire and forget: losing a column preference to a failed PATCH is not worth
   * a dialog, and the server is the same process on the same machine.
   */
  async #persist(): Promise<void> {
    if (!this.#project.isOpen()) return;
    try {
      const updated = await this.#api.patch({
        visibleLocales: [...this.visibleLocales()],
        filters: [...this.#filters()],
      });
      this.#project.set(updated);
    } catch {
      // Ignored deliberately — see above.
    }
  }
}
