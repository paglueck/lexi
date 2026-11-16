// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { clampWidth, readWidths, writeWidths } from './grid-columns-store.js';
import { ProjectStore } from './project-store.js';

/**
 * S12's resizable findings columns. The badge stays 22 px and the target is the
 * handoff's `1fr`: it takes what the other three leave, so widening the finding
 * narrows the target first and only scrolls the table once the target is at
 * its minimum.
 */
export const ISSUE_COLUMNS = ['unit', 'finding', 'state'] as const;
export type IssueColumn = (typeof ISSUE_COLUMNS)[number];

/** The handoff's 180 / 180 / 96, with the finding given room to read. */
export const ISSUE_DEFAULT_WIDTHS: Readonly<Record<IssueColumn, number>> = {
  unit: 160,
  finding: 240,
  state: 100,
};

/** The target never gets narrower than this; below it the table scrolls sideways. */
export const ISSUE_TARGET_MIN = 120;

/** Four 12 px gaps between five tracks, plus the row's 18 px padding either side. */
const ROW_CHROME = 4 * 12 + 2 * 18;

const PREFIX = 'lexi.issues.cols:';
const SAVE_DEBOUNCE_MS = 250;

const widthOf = (widths: Readonly<Record<string, number>>, c: IssueColumn): number =>
  widths[c] ?? ISSUE_DEFAULT_WIDTHS[c];

/** The value of `--lx-issues-cols`: badge, unit, the flexible target, finding, state. */
export function issueTrackList(widths: Readonly<Record<string, number>>): string {
  const px = (c: IssueColumn): string => `${widthOf(widths, c)}px`;
  return [
    '22px',
    px('unit'),
    `minmax(${ISSUE_TARGET_MIN}px, 1fr)`,
    px('finding'),
    px('state'),
  ].join(' ');
}

/** The value of `--lx-issues-min`: the row's width with the target at its minimum. */
export function issueMinWidth(widths: Readonly<Record<string, number>>): number {
  return (
    22 +
    ISSUE_TARGET_MIN +
    ROW_CHROME +
    ISSUE_COLUMNS.reduce((sum, c) => sum + widthOf(widths, c), 0)
  );
}

/**
 * The findings table's column widths, per project in localStorage, for the
 * same reason the grid's are: a width is one person's preference, and the
 * project file is committed.
 */
@Injectable({ providedIn: 'root' })
export class IssuesColumnsStore {
  readonly #project = inject(ProjectStore);
  readonly #path = computed(() => this.#project.project()?.path ?? null);

  readonly #widths = signal<Readonly<Record<string, number>>>({});
  readonly widths = this.#widths.asReadonly();
  readonly tracks = computed(() => issueTrackList(this.#widths()));
  readonly minWidth = computed(() => issueMinWidth(this.#widths()));

  #timer: ReturnType<typeof setTimeout> | undefined;
  #pendingPath: string | null = null;

  constructor() {
    effect(() => {
      const path = this.#path();
      untracked(() => {
        this.#flush();
        this.#widths.set(path === null ? {} : readWidths(path, PREFIX));
      });
    });
  }

  width(column: IssueColumn): number {
    return this.#widths()[column] ?? ISSUE_DEFAULT_WIDTHS[column];
  }

  setWidth(column: IssueColumn, px: number): void {
    const next = clampWidth(px);
    if (this.#widths()[column] === next) return;
    this.#widths.update((w) => ({ ...w, [column]: next }));
    this.#scheduleSave();
  }

  reset(column: IssueColumn): void {
    if (!(column in this.#widths())) return;
    this.#widths.update(({ [column]: _, ...rest }) => rest);
    this.#scheduleSave();
  }

  #scheduleSave(): void {
    this.#pendingPath = this.#path();
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#flush(), SAVE_DEBOUNCE_MS);
  }

  #flush(): void {
    clearTimeout(this.#timer);
    const path = this.#pendingPath;
    this.#pendingPath = null;
    if (path !== null) writeWidths(path, this.#widths(), PREFIX);
  }
}
