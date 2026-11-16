// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { GridStore } from './grid-store.js';
import { UnitsStore } from './units-store.js';

/**
 * The grid's MULTI-cell selection: the cells a bulk action from the context
 * menu applies to.
 *
 * It sits on top of the single selection rather than replacing it. The row in
 * `UnitsStore.selectedIndex` and the column in `GridStore.editLocale` still
 * follow every click, so the detail panel, the inline editor and ↑/↓ behave
 * exactly as before; this store only remembers which OTHER cells are marked.
 *
 * RANGES, NOT CELLS. A Shift+click from row 1 to row 20,000 across ten locales
 * is 200k cells, and building that many keys on a click, or comparing them on
 * every change-detection pass, is the cost the grid's scroll path cannot pay.
 * A selection is a list of rectangles in (row index, column index) space plus
 * the cells Cmd+click took back out of them; cells are only enumerated when a
 * menu opens or an action runs.
 *
 * Indexes are positions in the CURRENT id list and visible columns, so the
 * selection is dropped whenever either changes — a new filter or a new column
 * would otherwise silently re-aim it at different cells.
 */

export interface Cell {
  readonly row: number;
  readonly col: number;
}

/** Inclusive on all four sides, and normalised: r0 <= r1, c0 <= c1. */
export interface Rect {
  readonly r0: number;
  readonly r1: number;
  readonly c0: number;
  readonly c1: number;
}

export interface Selection {
  readonly rects: readonly Rect[];
  /** `"row col"` of cells Cmd+click removed from a rect. */
  readonly excluded: ReadonlySet<string>;
  /** Where a Shift+click or Shift+arrow extends FROM. */
  readonly anchor: Cell | null;
  /** Where the last extension ended — what Shift+arrow moves on from. */
  readonly focus: Cell | null;
  /** The anchor was set on a whole row (the id column), so extending keeps whole rows. */
  readonly rows: boolean;
  /**
   * The last rect is the one the anchor started, so a Shift+click REPLACES it.
   * False after a Cmd+click took a cell out: that anchor owns no rect yet, and
   * replacing the last one would silently drop an earlier range.
   */
  readonly open: boolean;
}

export const EMPTY_SELECTION: Selection = {
  rects: [],
  excluded: new Set(),
  anchor: null,
  focus: null,
  rows: false,
  open: false,
};

const key = (row: number, col: number): string => `${row} ${col}`;

function rectOf(a: Cell, b: Cell): Rect {
  return {
    r0: Math.min(a.row, b.row),
    r1: Math.max(a.row, b.row),
    c0: Math.min(a.col, b.col),
    c1: Math.max(a.col, b.col),
  };
}

function inRect(r: Rect, row: number, col: number): boolean {
  return row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;
}

/** Drop the exclusions a new rect covers again: marking a cell twice marks it. */
function without(excluded: ReadonlySet<string>, rect: Rect): ReadonlySet<string> {
  if (excluded.size === 0) return excluded;
  const next = new Set<string>();
  for (const k of excluded) {
    const [row, col] = k.split(' ').map(Number) as [number, number];
    if (!inRect(rect, row, col)) next.add(k);
  }
  return next;
}

export function isSelected(sel: Selection, row: number, col: number): boolean {
  return !sel.excluded.has(key(row, col)) && sel.rects.some((r) => inRect(r, row, col));
}

/** A plain click: just this cell, and the anchor for what follows. */
export function selectCell(cell: Cell): Selection {
  return { ...EMPTY_SELECTION, rects: [rectOf(cell, cell)], anchor: cell, focus: cell, open: true };
}

/** A plain-click-equivalent on a whole row, from the id column. */
export function selectRow(row: number, cols: number): Selection {
  const anchor = { row, col: 0 };
  return {
    ...EMPTY_SELECTION,
    rects: [{ r0: row, r1: row, c0: 0, c1: cols - 1 }],
    anchor,
    focus: anchor,
    rows: true,
    open: true,
  };
}

/**
 * Shift+click: the LAST rect becomes anchor → cell, the spreadsheet rule — the
 * earlier Cmd+click picks stay, the range being dragged out is replaced.
 */
export function extendTo(sel: Selection, cell: Cell, cols: number): Selection {
  if (sel.anchor === null) return selectCell(cell);
  const rect = sel.rows
    ? {
        r0: Math.min(sel.anchor.row, cell.row),
        r1: Math.max(sel.anchor.row, cell.row),
        c0: 0,
        c1: cols - 1,
      }
    : rectOf(sel.anchor, cell);
  return {
    ...sel,
    rects: [...(sel.open ? sel.rects.slice(0, -1) : sel.rects), rect],
    excluded: without(sel.excluded, rect),
    focus: cell,
    open: true,
  };
}

/** Cmd/Ctrl+click: take one cell in or out, and move the anchor there. */
export function toggleCell(sel: Selection, cell: Cell): Selection {
  const k = key(cell.row, cell.col);
  if (isSelected(sel, cell.row, cell.col)) {
    return {
      ...sel,
      excluded: new Set([...sel.excluded, k]),
      anchor: cell,
      focus: cell,
      rows: false,
      open: false,
    };
  }
  const covered = sel.rects.some((r) => inRect(r, cell.row, cell.col));
  const excluded = new Set(sel.excluded);
  excluded.delete(k);
  return {
    ...sel,
    rects: covered ? sel.rects : [...sel.rects, rectOf(cell, cell)],
    excluded,
    anchor: cell,
    focus: cell,
    rows: false,
    open: !covered,
  };
}

/** Cmd/Ctrl+click on the id column: the whole row in, or — if it already is — out. */
export function toggleRow(sel: Selection, row: number, cols: number): Selection {
  const rect: Rect = { r0: row, r1: row, c0: 0, c1: cols - 1 };
  const anchor = { row, col: 0 };
  let all = true;
  for (let c = 0; c < cols; c++) all &&= isSelected(sel, row, c);
  if (all) {
    const excluded = new Set(sel.excluded);
    for (let c = 0; c < cols; c++) excluded.add(key(row, c));
    return { ...sel, excluded, anchor, focus: anchor, rows: true, open: false };
  }
  return {
    ...sel,
    rects: [...sel.rects, rect],
    excluded: without(sel.excluded, rect),
    anchor,
    focus: anchor,
    rows: true,
    open: true,
  };
}

/** Every selected cell once, in row-then-column order. Only when it is needed. */
export function cellsOf(sel: Selection): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const r of sel.rects) {
    for (let row = r.r0; row <= r.r1; row++) {
      for (let col = r.c0; col <= r.c1; col++) {
        const k = key(row, col);
        if (seen.has(k) || sel.excluded.has(k)) continue;
        seen.add(k);
        out.push({ row, col });
      }
    }
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** More than one cell, without enumerating a 200k-cell rect to find out. */
export function isMultiple(sel: Selection): boolean {
  let first: string | null = null;
  for (const r of sel.rects) {
    for (let row = r.r0; row <= r.r1; row++) {
      for (let col = r.c0; col <= r.c1; col++) {
        const k = key(row, col);
        if (sel.excluded.has(k)) continue;
        if (first === null) first = k;
        else if (k !== first) return true;
      }
    }
  }
  return false;
}

/**
 * How many cells are marked. One rect — the common Shift+click case, possibly
 * spanning the whole list — is counted by area rather than enumerated.
 */
export function countOf(sel: Selection): number {
  const [only, ...rest] = sel.rects;
  if (only === undefined) return 0;
  if (rest.length > 0) return cellsOf(sel).length;
  let excluded = 0;
  for (const k of sel.excluded) {
    const [row, col] = k.split(' ').map(Number) as [number, number];
    if (inRect(only, row, col)) excluded++;
  }
  return (only.r1 - only.r0 + 1) * (only.c1 - only.c0 + 1) - excluded;
}

/** The selected column indexes of one row; empty when the row has none. */
export function colsAt(sel: Selection, row: number): number[] {
  const cols = new Set<number>();
  for (const r of sel.rects) {
    if (row < r.r0 || row > r.r1) continue;
    for (let col = r.c0; col <= r.c1; col++) {
      if (!sel.excluded.has(key(row, col))) cols.add(col);
    }
  }
  return [...cols].sort((a, b) => a - b);
}

export interface SelectedCell {
  readonly rowId: string;
  readonly locale: string;
}

export interface ClickModifiers {
  readonly shift: boolean;
  /** Cmd on a Mac, Ctrl elsewhere. */
  readonly meta: boolean;
}

@Injectable({ providedIn: 'root' })
export class GridSelectionStore {
  readonly #units = inject(UnitsStore);
  readonly #grid = inject(GridStore);

  readonly #sel = signal<Selection>(EMPTY_SELECTION);
  readonly selection = this.#sel.asReadonly();

  /** A bulk action needs at least two cells; one is the ordinary single selection. */
  readonly isMulti = computed(() => isMultiple(this.#sel()));
  readonly count = computed(() => countOf(this.#sel()));

  /**
   * One Set per distinct column pattern, so `localesAt` hands every row of a
   * rect the SAME instance — an `input()` compares by identity, and a fresh Set
   * per change-detection pass would re-render every visible row each time.
   */
  readonly #memo = computed(() => {
    this.#sel();
    this.#grid.visibleLocales();
    return new Map<string, ReadonlySet<string>>();
  });

  constructor() {
    effect(() => {
      this.#units.ids();
      this.#grid.visibleLocales();
      untracked(() => this.#sel.set(EMPTY_SELECTION));
    });
  }

  /** A click on a target cell, with the modifiers it was made with. */
  click(row: number, col: number, mods: ClickModifiers): void {
    const cell = { row, col };
    const sel = this.#sel();
    if (mods.shift) this.#sel.set(extendTo(sel, cell, this.#cols()));
    else if (mods.meta) this.#sel.set(toggleCell(sel, cell));
    else this.#sel.set(selectCell(cell));
  }

  /** A click on the unit id: whole rows. */
  clickRow(row: number, mods: ClickModifiers): void {
    const cols = this.#cols();
    if (cols === 0) return;
    const sel = this.#sel();
    if (mods.shift) {
      const base = sel.anchor === null ? selectRow(row, cols) : { ...sel, rows: true };
      this.#sel.set(extendTo(base, { row, col: cols - 1 }, cols));
    } else if (mods.meta) this.#sel.set(toggleRow(sel, row, cols));
    else this.#sel.set(selectRow(row, cols));
  }

  /**
   * Shift+↑/↓: move the far edge of the range by `delta` rows. Starts from the
   * selected row and edit column when nothing is anchored yet. Returns the row
   * the range now ends on, which the caller makes the selected row.
   */
  extend(delta: number): number | null {
    const total = this.#units.ids().length;
    if (total === 0) return null;
    let sel = this.#sel();
    if (sel.anchor === null || sel.focus === null) {
      const row = this.#units.selectedIndex();
      if (row < 0) return null;
      const edit = this.#grid.editLocale();
      const col = Math.max(0, edit === null ? 0 : this.#grid.visibleLocales().indexOf(edit));
      sel = selectCell({ row, col });
    }
    const focus = sel.focus ?? { row: 0, col: 0 };
    const row = Math.min(Math.max(focus.row + delta, 0), total - 1);
    this.#sel.set(extendTo(sel, { row, col: focus.col }, this.#cols()));
    return row;
  }

  clear(): void {
    if (this.#sel() !== EMPTY_SELECTION) this.#sel.set(EMPTY_SELECTION);
  }

  /** Is this target cell one of the marked ones? */
  has(row: number, locale: string): boolean {
    const col = this.#grid.visibleLocales().indexOf(locale);
    return col >= 0 && isSelected(this.#sel(), row, col);
  }

  /**
   * The marked locales of one row, for `LxGridRow`; null when the row has none
   * or there is no multi-selection — a single cell is already shown by the
   * edit-cell outline.
   */
  localesAt(row: number): ReadonlySet<string> | null {
    if (!this.isMulti()) return null;
    const cols = colsAt(this.#sel(), row);
    if (cols.length === 0) return null;
    const memo = this.#memo();
    const k = cols.join(',');
    let set = memo.get(k);
    if (set === undefined) {
      const locales = this.#grid.visibleLocales();
      set = new Set(cols.map((c) => locales[c]).filter((l): l is string => l !== undefined));
      memo.set(k, set);
    }
    return set;
  }

  /** The marked cells by row id and locale. Enumerates — call it on demand only. */
  cells(): SelectedCell[] {
    const ids = this.#units.ids();
    const locales = this.#grid.visibleLocales();
    const out: SelectedCell[] = [];
    for (const { row, col } of cellsOf(this.#sel())) {
      const rowId = ids[row];
      const locale = locales[col];
      if (rowId !== undefined && locale !== undefined) out.push({ rowId, locale });
    }
    return out;
  }

  #cols(): number {
    return this.#grid.visibleLocales().length;
  }
}
