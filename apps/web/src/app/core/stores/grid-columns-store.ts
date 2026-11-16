// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { ProjectStore } from './project-store.js';

/** `'id'`, `'source'`, or a locale code. */
export type ColumnKey = 'id' | 'source' | (string & {});

export const DEFAULT_WIDTHS = { id: 118, source: 280, locale: 220 } as const;
export const MIN_WIDTH = 72;
export const MAX_WIDTH = 1200;

const STORAGE_PREFIX = 'lexi.grid.cols:';
const SAVE_DEBOUNCE_MS = 250;

export function defaultWidth(key: ColumnKey): number {
  return key === 'id'
    ? DEFAULT_WIDTHS.id
    : key === 'source'
      ? DEFAULT_WIDTHS.source
      : DEFAULT_WIDTHS.locale;
}

export function clampWidth(px: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)));
}

/**
 * The value of `--lx-grid-cols`: one fixed track per column, then an empty
 * `minmax(0, 1fr)` filler. The filler has no cell. It soaks up the leftover
 * width when only a few columns are visible, so the row's border and its
 * selected background still reach the right edge. When the columns are wider
 * than the viewport it collapses to zero and the viewport scrolls instead.
 */
export function trackList(
  widths: Readonly<Record<string, number>>,
  locales: readonly string[],
): string {
  const w = (key: ColumnKey): string => `${widths[key] ?? defaultWidth(key)}px`;
  return [w('id'), w('source'), ...locales.map(w), 'minmax(0, 1fr)'].join(' ');
}

/** `prefix` separates one table's widths from another's (the grid, S12's findings). */
export function storageKey(projectPath: string, prefix = STORAGE_PREFIX): string {
  return prefix + projectPath;
}

/** Anything unreadable becomes "nothing stored", so a bad entry means defaults rather than an error. */
export function readWidths(projectPath: string, prefix = STORAGE_PREFIX): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey(projectPath, prefix));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = clampWidth(value);
    }
    return out;
  } catch {
    return {};
  }
}

export function writeWidths(
  projectPath: string,
  widths: Readonly<Record<string, number>>,
  prefix = STORAGE_PREFIX,
): void {
  try {
    if (Object.keys(widths).length === 0) localStorage.removeItem(storageKey(projectPath, prefix));
    else localStorage.setItem(storageKey(projectPath, prefix), JSON.stringify(widths));
  } catch {
    // Private window or blocked site data: the widths still apply for this
    // session, they just do not survive a reload.
  }
}

/**
 * The grid's column widths, as the user dragged them.
 *
 * Keyed by `'id'`, `'source'` or a locale code. A missing key means "never
 * dragged" and falls back to the default. Hiding a column keeps its key, so
 * showing it again brings back the width it had.
 *
 * Kept in localStorage per project rather than in `.lexi/project.json`. A
 * width is one person's preference on one screen, and the project file is
 * committed: writing it there would hand every teammate this person's layout
 * and put a changed line in their diffs.
 */
@Injectable({ providedIn: 'root' })
export class GridColumnsStore {
  readonly #project = inject(ProjectStore);
  readonly #path = computed(() => this.#project.project()?.path ?? null);

  readonly #widths = signal<Readonly<Record<string, number>>>({});
  readonly widths = this.#widths.asReadonly();

  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // A different project brings its own widths. A save still pending for the
    // old one is written to the old key first, never to the new one.
    effect(() => {
      const path = this.#path();
      untracked(() => {
        this.#flush();
        this.#widths.set(path === null ? {} : readWidths(path));
      });
    });
  }

  width(key: ColumnKey): number {
    return this.#widths()[key] ?? defaultWidth(key);
  }

  setWidth(key: ColumnKey, px: number): void {
    const next = clampWidth(px);
    if (this.#widths()[key] === next) return;
    this.#widths.update((w) => ({ ...w, [key]: next }));
    this.#scheduleSave();
  }

  /** Back to the default, which is also what a double-click on the border does. */
  reset(key: ColumnKey): void {
    if (!(key in this.#widths())) return;
    this.#widths.update(({ [key]: _, ...rest }) => rest);
    this.#scheduleSave();
  }

  // A drag calls setWidth on every pointermove. Writing localStorage that often
  // is pointless, so the write trails the last move.
  #pendingPath: string | null = null;

  #scheduleSave(): void {
    this.#pendingPath = this.#path();
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#flush(), SAVE_DEBOUNCE_MS);
  }

  #flush(): void {
    clearTimeout(this.#timer);
    const path = this.#pendingPath;
    this.#pendingPath = null;
    if (path !== null) writeWidths(path, this.#widths());
  }
}
