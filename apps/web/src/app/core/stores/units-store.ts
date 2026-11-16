// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Injectable,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { UnitRow, UnitsFacets, UnitsQueryResponse } from '@lexi/shared';

import { UnitsApi } from '../api/units-api.js';
import { EventsStore } from './events-store.js';
import { GridStore } from './grid-store.js';
import { ProjectStore } from './project-store.js';

/** Rows fetched per request, and how many are kept. See docs/architecture.md. */
const WINDOW = 200;
const CACHE_LIMIT = 2_000;

const EMPTY: UnitsQueryResponse = {
  total: 0,
  ids: [],
  scopeTotal: 0,
  facets: {},
  groupCounts: {},
};

/**
 * Where the selection lands when the filtered list changes underneath it.
 *
 * Exported and pure because it is the one piece of grid behaviour that is easy
 * to get subtly wrong and impossible to notice in a screenshot: the reviewer
 * ticks "untranslated", and either the list keeps their place or it throws them
 * back to row 0 and they lose it.
 *
 * The rule: follow the SAME UNIT if it survived the filter; otherwise hold the
 * POSITION, so the eye stays roughly where it was rather than jumping.
 */
export function nextSelectedIndex(
  ids: readonly string[],
  previous: { readonly source: readonly string[]; readonly value: number } | undefined,
): number {
  if (ids.length === 0) return -1;
  if (!previous) return 0;

  const wasSelected = previous.source[previous.value];
  if (wasSelected !== undefined) {
    const moved = ids.indexOf(wasSelected);
    if (moved !== -1) return moved;
  }
  return Math.min(Math.max(previous.value, 0), ids.length - 1);
}

/**
 * The grid's data: the ordered id list, the row bodies, and the selection.
 *
 * THE HYBRID (docs/architecture.md). The client owns the id list, the server owns the
 * bodies. One query returns every matching id — 20k at ~13 characters is about
 * 300 kB, negligible over loopback — and that buys an exact scroll height, a
 * stable row-to-index mapping, instant selection arithmetic, and a status-bar
 * count that is right rather than estimated. Bodies then arrive in windows
 * driven by what the viewport is actually showing.
 */
@Injectable({ providedIn: 'root' })
export class UnitsStore {
  readonly #api = inject(UnitsApi);
  readonly #grid = inject(GridStore);
  readonly #project = inject(ProjectStore);
  readonly #events = inject(EventsStore);

  /**
   * The first `httpResource` in the codebase, and the reason `ProjectApi` has
   * been carrying a comment about it since M4.
   *
   * What it buys over an awaited POST: when the request parameters change it
   * ABORTS the one in flight. A fast typist therefore never queues requests,
   * and — the part that actually matters — a slow response for "inv" can never
   * land after a fast one for "invoice" and overwrite it.
   */
  readonly query = httpResource<UnitsQueryResponse>(
    () =>
      this.#project.isOpen()
        ? { url: '/api/units/query', method: 'POST', body: this.#grid.queryBody() }
        : undefined,
    { defaultValue: EMPTY },
  );

  readonly ids = computed<readonly string[]>(() => this.query.value().ids);
  readonly total = computed(() => this.query.value().total);
  readonly scopeTotal = computed(() => this.query.value().scopeTotal);
  readonly facets = computed<UnitsFacets>(() => this.query.value().facets);
  readonly groupCounts = computed(() => this.query.value().groupCounts);
  readonly isLoading = computed(() => this.query.isLoading());
  readonly error = computed(() => this.query.error());

  /** rowId -> body, for whatever is currently cached. */
  readonly #rows = signal<ReadonlyMap<string, UnitRow>>(new Map());
  readonly rows = this.#rows.asReadonly();

  /** Least-recently-touched first. Trimmed to CACHE_LIMIT. */
  #recency: string[] = [];
  readonly #inFlight = new Set<number>();

  /**
   * Selection as an INDEX into the filtered list, not a row id — because
   * `Cmd+Enter → next filtered row` is index arithmetic and must not cost a
   * lookup.
   *
   * `linkedSignal` because it has to be both: derived from the id list (a new
   * filter invalidates it) and user-writable in between. The computation
   * receives the previous value AND the previous source, which is what lets
   * selection follow the SAME UNIT across a filter change rather than snapping
   * back to row 0 — the behaviour that makes "tick untranslated" not lose the
   * reviewer's place.
   */
  readonly selectedIndex = linkedSignal<readonly string[], number>({
    source: this.ids,
    computation: nextSelectedIndex,
  });

  readonly selectedRowId = computed<string | null>(() => this.ids()[this.selectedIndex()] ?? null);

  /**
   * A row somebody asked to see from another screen (S12's "Open in grid").
   * `cleared` records that the view was already widened once, so a row that
   * is genuinely not in the project cannot make this loop.
   */
  readonly #reveal = signal<{ readonly rowId: string; readonly cleared: boolean } | null>(null);

  constructor() {
    // A different query or a different set of columns invalidates every cached
    // body: the cells are keyed by locale, so a new column means every row is
    // incomplete. Cheaper and far safer than trying to patch them in place.
    effect(() => {
      this.ids();
      this.#grid.visibleLocales();
      this.#rows.set(new Map());
      this.#recency = [];
      this.#inFlight.clear();
    });

    // A reload (FR-1.5) rebuilds the row model server-side: ids can appear,
    // disappear or be re-hashed, so the query is re-run rather than the cache
    // patched. The id list that comes back is a new array, which the effect
    // above turns into a cache flush — so this is the only wiring needed.
    effect(() => {
      if (this.#events.reloadedAt() === 0) return;
      this.query.reload();
    });

    // "Open in grid": select the row once an answer that contains it arrives,
    // widening the view once if the current filters hide it.
    effect(() => {
      const reveal = this.#reveal();
      if (reveal === null || this.query.isLoading()) return;
      const ids = this.ids();
      untracked(() => {
        if (ids.includes(reveal.rowId)) {
          this.selectRowId(reveal.rowId);
          this.#reveal.set(null);
        } else if (!reveal.cleared && this.#grid.hasActiveFilters()) {
          this.#reveal.set({ ...reveal, cleared: true });
          this.#grid.clearView();
        } else {
          this.#reveal.set(null);
        }
      });
    });
  }

  /**
   * Show one row with one locale's target cell selected, from another screen.
   *
   * The columns change only if that locale is not showing, and the filters
   * only if they hide the row. Both are the least the grid can do to put the
   * row on screen, and both persist like any other change to the view.
   */
  reveal(rowId: string, locale: string): void {
    if (
      this.#grid.availableLocales().includes(locale) &&
      !this.#grid.visibleLocales().includes(locale)
    ) {
      this.#grid.toggleLocale(locale);
    }
    this.#grid.setEditLocale(locale);
    this.#reveal.set({ rowId, cleared: false });
  }

  /**
   * Select a row once the next answer contains it — a key just created — and
   * widen the view once if the current filters hide it. Columns are untouched.
   */
  revealRow(rowId: string): void {
    this.#reveal.set({ rowId, cleared: false });
  }

  rowFor(rowId: string): UnitRow | undefined {
    return this.#rows().get(rowId);
  }

  /**
   * Re-run the query after the row model changed on the server — a unit was
   * deleted. The fresh id list flushes the row cache (see the constructor), the
   * same wiring a reload uses.
   */
  reload(): void {
    this.query.reload();
  }

  /**
   * Re-fetch one row's body (M6).
   *
   * The server substitutes a cell's pending edit into the row payload, so after
   * a commit the cached copy is the only thing still showing the old text. This
   * is deliberately a refetch of ONE row rather than a draft lookup inside
   * `LxGridRow`: the row is the component benchmarked at 20k x 10, and
   * adding a per-cell map lookup to it would change the thing the benchmark
   * was about. A commit is human-paced; a scroll frame is not.
   */
  async refreshRow(rowId: string): Promise<void> {
    return this.refreshRows([rowId]);
  }

  /** `refreshRow` for a bulk action: the cached ones among them, in one request. */
  async refreshRows(rowIds: readonly string[]): Promise<void> {
    const cached = rowIds.filter((id) => this.#rows().has(id));
    if (cached.length === 0) return;
    const res = await this.#api.rows(cached, this.#grid.visibleLocales());
    const next = new Map(this.#rows());
    for (const row of res.rows) next.set(row.rowId, row);
    this.#rows.set(next);
  }

  select(index: number): void {
    const ids = this.ids();
    if (index < 0 || index >= ids.length) return;
    this.selectedIndex.set(index);
  }

  selectRowId(rowId: string): void {
    const at = this.ids().indexOf(rowId);
    if (at !== -1) this.selectedIndex.set(at);
  }

  /** Move the selection by `delta`, clamped. The keyboard contract's spine. */
  moveSelection(delta: number): void {
    const ids = this.ids();
    if (ids.length === 0) return;
    const next = Math.min(Math.max(this.selectedIndex() + delta, 0), ids.length - 1);
    this.selectedIndex.set(next);
  }

  /**
   * Make sure the bodies for a rendered range are on their way.
   *
   * Aligned to fixed windows so that a scroll of one row does not produce a
   * new request every time, and the window either side is prefetched so a fling
   * is already fed by the time it arrives there.
   */
  ensureRange(start: number, end: number): void {
    const ids = this.ids();
    if (ids.length === 0) return;

    const first = Math.floor(Math.max(0, start) / WINDOW);
    const last = Math.floor(Math.min(ids.length - 1, Math.max(0, end)) / WINDOW);
    for (let w = first - 1; w <= last + 1; w++) {
      if (w >= 0) void this.#fetchWindow(w);
    }
  }

  async #fetchWindow(window: number): Promise<void> {
    if (this.#inFlight.has(window)) return;
    const ids = this.ids();
    const slice = ids.slice(window * WINDOW, (window + 1) * WINDOW);
    if (slice.length === 0) return;

    const cached = this.#rows();
    const missing = slice.filter((id) => !cached.has(id));
    if (missing.length === 0) {
      // Still a hit: touching them keeps the visible window out of the LRU's
      // way, so scrolling back and forth over a boundary cannot evict what is
      // on screen.
      this.#touch(slice);
      return;
    }

    this.#inFlight.add(window);
    try {
      const { rows } = await this.#api.rows(missing, this.#grid.visibleLocales());
      // The id list may have changed while this was in flight; merging rather
      // than replacing means a stale window costs memory, never correctness,
      // and the LRU reclaims it.
      this.#rows.update((current) => {
        const next = new Map(current);
        for (const row of rows) next.set(row.rowId, row);
        return next;
      });
      this.#touch(slice);
      this.#evict();
    } catch {
      // A failed window leaves its rows blank and retriable; the grid shows a
      // skeleton row rather than an error, because one bad window is not a
      // reason to take the screen away.
    } finally {
      this.#inFlight.delete(window);
    }
  }

  #touch(ids: readonly string[]): void {
    const touched = new Set(ids);
    this.#recency = this.#recency.filter((id) => !touched.has(id)).concat(ids);
  }

  #evict(): void {
    if (this.#recency.length <= CACHE_LIMIT) return;
    const drop = this.#recency.splice(0, this.#recency.length - CACHE_LIMIT);
    this.#rows.update((current) => {
      const next = new Map(current);
      for (const id of drop) next.delete(id);
      return next;
    });
  }
}
