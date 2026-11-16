// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import type { UnitCell } from '@lexi/shared';

import { UnitsApi } from '../../core/api/units-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { ToastStore } from '../../core/stores/toast-store.js';
import { UnitDetailStore } from '../../core/stores/unit-detail-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { LxModalService } from '../../ui/modal.js';
import { LxDeleteUnitConfirm, type DeleteUnitConfirmData } from './delete-unit-confirm.js';

/**
 * What the context menu does to a MULTI-cell selection: the single-cell
 * actions, looped. Every one of them lands in the unsaved overlay, as the
 * single-cell versions do, so Save is still the one moment anything is written
 * — which is why none of them asks first. "Delete keys" is the exception, as
 * its single-unit version is: it writes to disk at once, behind a modal.
 *
 * Kept out of `LxCellMenu` so the menu stays a menu. The predicates are here
 * too, so the counts the menu shows and the cells an action touches cannot
 * disagree.
 */

/** One marked cell, with the row body the menu fetched for it. */
export interface BulkCell {
  readonly rowId: string;
  readonly locale: string;
  /** Undefined when the row could not be read; such a cell is skipped. */
  readonly cell: UnitCell | undefined;
  /** Has an unsaved edit. */
  readonly dirty: boolean;
}

/** A job drafts any cell; FR-6.10's overwrite guard skips a human translation itself. */
export const translatable = (c: BulkCell): boolean => c.cell !== undefined;
export const approvable = (c: BulkCell): boolean =>
  c.cell?.state === 'draftMachine' || c.cell?.state === 'needsReview';
export const revertable = (c: BulkCell): boolean => c.dirty;
export const clearable = (c: BulkCell): boolean =>
  c.cell !== undefined && !c.cell.missing && c.cell.segments.length > 0;

/** The distinct units of a selection, in order. */
export function unitsOf(cells: readonly BulkCell[]): string[] {
  return [...new Set(cells.filter((c) => c.cell !== undefined).map((c) => c.rowId))];
}

function byLocale(cells: readonly BulkCell[]): { locale: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const c of cells) groups.set(c.locale, [...(groups.get(c.locale) ?? []), c.rowId]);
  return [...groups].map(([locale, ids]) => ({ locale, ids }));
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

@Injectable({ providedIn: 'root' })
export class SelectionActions {
  readonly #drafts = inject(DraftStore);
  readonly #session = inject(EditSessionStore);
  readonly #grid = inject(GridStore);
  readonly #jobs = inject(JobsStore);
  readonly #toasts = inject(ToastStore);
  readonly #detail = inject(UnitDetailStore);
  readonly #units = inject(UnitsStore);
  readonly #api = inject(UnitsApi);
  readonly #project = inject(ProjectStore);
  readonly #modal = inject(LxModalService);

  /**
   * ONE job over every locale the marked cells touch, the toolbar's shape
   * (FR-6.6, S15). A locale an active draft job already holds is left out —
   * the server would refuse the whole job for it — and the toast says so.
   */
  async translate(cells: readonly BulkCell[]): Promise<void> {
    const locked = this.#jobs.locked('draft');
    const all = byLocale(cells.filter(translatable));
    const groups = all.filter((g) => !locked.has(g.locale));
    const held = all
      .filter((g) => locked.has(g.locale))
      .map((g) => `${g.locale} is in #${locked.get(g.locale)}`);
    if (groups.length === 0) {
      if (held.length > 0)
        this.#toasts.show({
          tone: 'warn',
          title: 'Already being drafted',
          detail: held.join(' · '),
        });
      return;
    }
    for (const { locale, ids } of groups) {
      for (const rowId of ids) this.#releaseBuffer(rowId, locale);
    }
    try {
      const job = await this.#jobs.create({
        task: 'draft',
        locales: groups.map((g) => ({ locale: g.locale, ids: [...g.ids] })),
      });
      const count = groups.reduce((n, g) => n + g.ids.length, 0);
      this.#toasts.show({
        tone: 'accent',
        title: `Drafting ${plural(count, 'cell')}`,
        detail: [`Job #${job.number}: ${groups.map((g) => g.locale).join(', ')}`, ...held].join(
          ' · ',
        ),
        action: { label: 'View jobs', route: '/jobs' },
      });
    } catch (error) {
      this.#toasts.show({
        tone: 'danger',
        title: 'The job could not be queued.',
        detail: messageOf(error, ''),
      });
    }
  }

  /** One bulk-approve per locale; the server re-checks every row. */
  async approve(cells: readonly BulkCell[]): Promise<void> {
    let approved = 0;
    let skipped = 0;
    let failed = 0;
    for (const { locale, ids } of byLocale(cells.filter(approvable))) {
      const res = await this.#drafts.approveMany(ids, locale);
      if (res === null) failed += ids.length;
      else {
        approved += res.approved;
        skipped += res.skipped;
      }
    }
    this.#report(`Approved ${plural(approved, 'cell')}`, approved, skipped + failed, failed > 0);
  }

  /** One request, so one ⌘Z brings the whole selection back. */
  async revert(cells: readonly BulkCell[]): Promise<void> {
    const dirty = cells.filter(revertable);
    for (const c of dirty) this.#releaseBuffer(c.rowId, c.locale);
    const done = await this.#drafts.revertMany(dirty);
    if (done === null) this.#report('Nothing was reverted', 0, dirty.length, true);
    else this.#report(`Reverted ${plural(done, 'cell')}`, done, dirty.length - done, false);
  }

  async clear(cells: readonly BulkCell[]): Promise<void> {
    let done = 0;
    let failed = 0;
    for (const c of cells.filter(clearable)) {
      this.#releaseBuffer(c.rowId, c.locale);
      if ((await this.#drafts.commit(c.rowId, c.locale, [])) === null) failed++;
      else done++;
    }
    this.#report(`Cleared ${plural(done, 'translation')}`, done, failed, failed > 0);
  }

  /**
   * Every note of every marked unit (FR-4.2) — the empty list, into the
   * overlay. A unit with no source unit (an orphan) has nowhere to keep notes
   * and is refused by the server; it is counted, not fatal.
   */
  async removeNotes(rowIds: readonly string[]): Promise<void> {
    let done = 0;
    let failed = 0;
    for (const rowId of rowIds) {
      if ((await this.#drafts.putNotes(rowId, [])) === null) failed++;
      else done++;
    }
    const selected = this.#units.selectedRowId();
    if (selected !== null && rowIds.includes(selected)) this.#detail.reload();
    this.#report(`Removed the notes of ${plural(done, 'unit')}`, done, failed, failed > 0, 'unit');
  }

  /**
   * Delete every marked unit from the source and each locale file — on disk,
   * at once, after one confirmation for all of them. One request per unit, the
   * single-unit route: a unit whose file changed on disk is reported, not
   * forced, exactly as the single delete does.
   */
  async deleteUnits(units: readonly { rowId: string; unitId: string }[]): Promise<void> {
    if (units.length === 0) return;
    const data: DeleteUnitConfirmData = {
      unitIds: units.map((u) => u.unitId),
      files: null,
      inSource: true,
    };
    const ref = this.#modal.open<LxDeleteUnitConfirm, boolean>(LxDeleteUnitConfirm, { data });
    const confirmed = await new Promise<boolean>((resolve) => {
      ref.closed.subscribe((value) => resolve(value === true));
    });
    if (!confirmed) return;

    const selected = this.#units.selectedRowId();
    let deleted = 0;
    const partial: string[] = [];
    const failed: string[] = [];
    let reason = '';
    for (const { rowId, unitId } of units) {
      try {
        const res = await this.#api.deleteUnit(rowId);
        if (rowId === selected) {
          this.#session.clearBuffer();
          this.#session.closeInline();
        }
        this.#drafts.forgetRow(rowId, res.unsavedCount);
        if (res.skipped.length === 0) deleted++;
        else partial.push(unitId);
      } catch (error) {
        failed.push(unitId);
        reason ||= messageOf(error, '');
      }
    }
    this.#units.reload();
    void this.#project.refresh();

    const left = [...partial, ...failed];
    this.#toasts.show(
      left.length === 0
        ? { tone: 'accent', title: `Deleted ${plural(deleted, 'key')}` }
        : {
            tone: deleted === 0 && partial.length === 0 ? 'danger' : 'warn',
            title: `Deleted ${plural(deleted, 'key')} of ${units.length.toLocaleString()}`,
            detail: [
              partial.length > 0
                ? `Only partly removed — a file changed on disk since it was read: ${partial.join(', ')}.`
                : '',
              failed.length > 0
                ? `Not deleted: ${failed.join(', ')}${reason ? ` — ${reason}` : '.'}`
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          },
    );
  }

  /** A buffered keystroke in the panel for a cell belongs to its old text. */
  #releaseBuffer(rowId: string, locale: string): void {
    if (this.#units.selectedRowId() === rowId && this.#grid.editLocale() === locale) {
      this.#session.clearBuffer();
    }
  }

  #report(title: string, done: number, left: number, error: boolean, noun = 'cell'): void {
    const reason = error ? this.#drafts.error() : null;
    this.#toasts.show({
      tone: left === 0 ? 'accent' : done === 0 ? 'danger' : 'warn',
      title,
      ...(left === 0
        ? {}
        : {
            detail: `${plural(left, noun)} left unchanged${reason ? ` — ${reason}` : '.'}`,
          }),
    });
  }
}
