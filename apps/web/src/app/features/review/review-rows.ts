// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { SegmentDto, UnitRow, UnitState } from '@lexi/shared';

import { UnitsApi } from '../../core/api/units-api.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { ReviewStore, type Decision } from '../../core/stores/review-store.js';

/**
 * The bodies behind S11's queue rows (M14).
 *
 * Separate from `ReviewStore` on the same division of labour the grid already
 * uses: the store owns the ordered ID LIST, this owns the ROW BODIES, and they
 * arrive in windows driven by what is actually on screen. A batch job can leave
 * a four-figure queue behind, so fetching every body up front would be a
 * second, slower copy of the problem `UnitsStore` was built to avoid.
 */

const WINDOW = 100;

export interface QueueRow {
  readonly rowId: string;
  readonly unitId: string;
  readonly state: UnitState;
  readonly error: boolean;
  /** One line, ellipsised — the rail is a way back to a unit, not a reading surface. */
  readonly text: string;
  readonly findingCount: number;
  readonly status: string;
  readonly tone: 'muted' | 'warn' | 'danger';
  readonly decision: Decision | undefined;
}

/** Placeholder chips read as their label, so a chip-only draft is not a blank row. */
export function previewText(segments: readonly SegmentDto[]): string {
  let out = '';
  const walk = (list: readonly SegmentDto[]): void => {
    for (const s of list) {
      if (s.k === 't') out += s.v;
      else if (s.k === 'p') out += s.equivText ?? s.id;
      else walk(s.children);
    }
  };
  walk(segments);
  return out.trim();
}

/** The one-line verdict under a queue row. */
export function statusLine(
  decision: Decision | undefined,
  findings: readonly { readonly severity: 'error' | 'warning'; readonly message: string }[],
): { status: string; tone: QueueRow['tone'] } {
  if (decision === 'accepted') return { status: 'accepted', tone: 'muted' };
  if (decision === 'rejected') return { status: 'rejected', tone: 'muted' };

  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0)
    return { status: errors[0]?.message ?? 'Validation error', tone: 'danger' };
  if (findings.length > 0) {
    const n = findings.length;
    return { status: `${n} ${n === 1 ? 'warning' : 'warnings'}`, tone: 'warn' };
  }
  return { status: 'clean', tone: 'muted' };
}

@Injectable({ providedIn: 'root' })
export class ReviewRowsStore {
  readonly #api = inject(UnitsApi);
  readonly #review = inject(ReviewStore);
  readonly #drafts = inject(DraftStore);

  readonly #rows = signal<ReadonlyMap<string, UnitRow>>(new Map());
  readonly #inFlight = new Set<number>();

  constructor() {
    // A new queue invalidates every cached body: the cells are keyed by locale,
    // and a different scope is usually a different locale.
    effect(() => {
      this.#review.ids();
      this.#review.locale();
      untracked(() => {
        this.#rows.set(new Map());
        this.#inFlight.clear();
        this.ensureRange(0, WINDOW);
      });
    });
  }

  readonly queue = computed<readonly QueueRow[]>(() => {
    const locale = this.#review.locale();
    const rows = this.#rows();
    if (locale === null) return [];

    return this.#review.ids().map((rowId) => {
      const decision = this.#review.decisionFor(rowId);
      const row = rows.get(rowId);
      // The overlay wins over the server's copy, the same read order every
      // other surface uses — a draft the reviewer just edited must not show
      // its pre-edit text in the list they are working down.
      const draft = this.#drafts.draftFor(rowId, locale)?.target;
      const cell = draft ?? row?.cells[locale];
      const findings = draft?.findings ?? [];
      const { status, tone } = statusLine(decision, findings);
      return {
        rowId,
        unitId: row?.unitId ?? rowId,
        state: cell?.state ?? 'untranslated',
        error:
          draft === undefined
            ? (row?.cells[locale]?.error ?? false)
            : findings.some((f) => f.severity === 'error'),
        text: previewText(cell?.segments ?? []),
        findingCount: findings.length,
        status,
        tone,
        decision,
      } satisfies QueueRow;
    });
  });

  /** Fetch the bodies for a rendered range, aligned to windows. */
  ensureRange(start: number, end: number): void {
    const ids = this.#review.ids();
    if (ids.length === 0) return;
    const first = Math.floor(Math.max(0, start) / WINDOW);
    const last = Math.floor(Math.min(ids.length - 1, Math.max(0, end)) / WINDOW);
    for (let w = first; w <= last + 1; w += 1) void this.#fetchWindow(w);
  }

  async #fetchWindow(window: number): Promise<void> {
    const locale = this.#review.locale();
    if (locale === null || this.#inFlight.has(window)) return;
    const ids = this.#review.ids().slice(window * WINDOW, (window + 1) * WINDOW);
    const missing = ids.filter((id) => !this.#rows().has(id));
    if (missing.length === 0) return;

    this.#inFlight.add(window);
    try {
      const { rows } = await this.#api.rows(missing, [locale]);
      this.#rows.update((current) => {
        const next = new Map(current);
        for (const row of rows) next.set(row.rowId, row);
        return next;
      });
    } catch {
      // A failed window leaves those rows showing their id and nothing else,
      // which is retriable on the next scroll and never wrong.
    } finally {
      this.#inFlight.delete(window);
    }
  }
}
