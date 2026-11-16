// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ChangedCell, HistoryStatus } from '@lexi/shared';

import { refreshIndexCell } from './commit.js';
import { originKey, type MachineOrigin } from './machine-origin.js';
import { fileNotesOf } from './notes.js';
import type { ReviewStats } from './review-stats.js';
import type { PendingEdit, PendingNotes, ProjectService } from '../services/project-service.js';

/**
 * Undo and redo for unsaved work (⌘Z / ⌘⇧Z).
 *
 * SNAPSHOTS, NOT REPLAYS. A step holds what the cells it touched looked like
 * BEFORE, and undoing puts exactly that back. Replaying an inverse PATCH from
 * the browser was the obvious alternative and is wrong for the same reasons the
 * reject path restores its own snapshot: a commit also forgets the
 * machine-origin marker, clears review reasons and moves the edit-rate counter,
 * and a second PATCH would count once more instead of uncounting. So a step
 * carries all four — the overlay entry, the marker, the reasons and the
 * counter — and an undo restores them together.
 *
 * Only what a PERSON did is recorded. A machine draft arriving from a job is
 * not a step, and it prunes the cell out of the steps that are, so an undo
 * never silently overwrites a draft the user has not even looked at yet.
 *
 * The history lasts until the files change underneath it — a save, a reload, a
 * key created or deleted — because a pending edit carries bytes cut from the
 * document it was written against, and a snapshot from before a rewrite would
 * put those stale bytes back.
 */

export interface CellSnapshot {
  readonly rowId: string;
  readonly locale: string;
  readonly pending: PendingEdit | undefined;
  readonly origin: MachineOrigin | undefined;
  readonly reasons: readonly string[];
}

export interface NotesSnapshot {
  readonly rowId: string;
  readonly pending: PendingNotes | undefined;
}

export interface UndoStep {
  /** What the toolbar calls it: "Undo Edit". */
  readonly label: string;
  readonly cells: readonly CellSnapshot[];
  readonly notes: readonly NotesSnapshot[];
  /** Immutable (`recordOutcome` returns a new map), so a reference is a snapshot. */
  readonly stats: ReviewStats;
}

/** How many steps are kept. Older ones fall off the bottom. */
export const HISTORY_LIMIT = 100;

const cellKey = (rowId: string, locale: string): string => originKey(rowId, locale);

function snapshotCell(projects: ProjectService, rowId: string, locale: string): CellSnapshot {
  return {
    rowId,
    locale,
    pending: projects.pendingFor(rowId, locale),
    origin: projects.machineOrigins.get(originKey(rowId, locale)),
    reasons: projects.reasonsFor(rowId, locale),
  };
}

function snapshotNotes(projects: ProjectService, rowId: string): NotesSnapshot {
  return { rowId, pending: projects.pendingNotesFor(rowId) };
}

const sameReasons = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((r, i) => r === b[i]);

function cellUnchanged(projects: ProjectService, before: CellSnapshot): boolean {
  const now = snapshotCell(projects, before.rowId, before.locale);
  return (
    now.pending === before.pending &&
    now.origin === before.origin &&
    sameReasons(now.reasons, before.reasons)
  );
}

/**
 * Collects one step while a route mutates.
 *
 * Call `cell` / `notes` BEFORE touching each one — the first call wins, so a
 * cell visited twice keeps its earliest state — and `finish` once it is done.
 * Cells that ended up exactly as they were are left out, and a step with
 * nothing left in it is not recorded at all: a bulk approve that skipped every
 * row must not leave an "Undo Approve" that does nothing.
 */
export class StepRecorder {
  readonly #projects: ProjectService;
  readonly #label: string;
  readonly #stats: ReviewStats;
  readonly #cells = new Map<string, CellSnapshot>();
  readonly #notes = new Map<string, NotesSnapshot>();

  constructor(projects: ProjectService, label: string) {
    this.#projects = projects;
    this.#label = label;
    this.#stats = projects.reviewStats;
  }

  cell(rowId: string, locale: string): void {
    const key = cellKey(rowId, locale);
    if (!this.#cells.has(key)) this.#cells.set(key, snapshotCell(this.#projects, rowId, locale));
  }

  notes(rowId: string): void {
    if (!this.#notes.has(rowId)) this.#notes.set(rowId, snapshotNotes(this.#projects, rowId));
  }

  finish(): void {
    const cells = [...this.#cells.values()].filter((c) => !cellUnchanged(this.#projects, c));
    const notes = [...this.#notes.values()].filter(
      (n) => this.#projects.pendingNotesFor(n.rowId) !== n.pending,
    );
    if (cells.length === 0 && notes.length === 0) return;
    this.#projects.recordStep({ label: this.#label, cells, notes, stats: this.#stats });
  }
}

export interface RestoreResult {
  /** The same cells as they were just before the restore — what undoes the undo. */
  readonly inverse: UndoStep;
  readonly cells: ChangedCell[];
  readonly noteRows: string[];
}

/** Put a step's snapshots back, and patch the index cells they moved. */
export function restoreStep(projects: ProjectService, step: UndoStep): RestoreResult {
  const inverse: UndoStep = {
    label: step.label,
    cells: step.cells.map((c) => snapshotCell(projects, c.rowId, c.locale)),
    notes: step.notes.map((n) => snapshotNotes(projects, n.rowId)),
    stats: projects.reviewStats,
  };

  for (const c of step.cells) {
    if (c.pending === undefined) projects.clearPending(c.rowId, c.locale);
    else projects.setPending(c.pending);
    if (c.origin === undefined) projects.clearMachineOrigin(c.rowId, c.locale);
    else projects.setMachineOrigin(c.rowId, c.locale, c.origin);
    projects.setReviewReasons(c.rowId, c.locale, c.reasons);
  }
  projects.replaceReviewStats(step.stats);

  const index = projects.index;
  const cells: ChangedCell[] = step.cells.map((c) => {
    const row = index?.byRowId.get(c.rowId);
    const target = row === undefined ? undefined : refreshIndexCell(projects, row, c.locale);
    return {
      rowId: c.rowId,
      locale: c.locale,
      target: target ?? null,
      pending: projects.pendingFor(c.rowId, c.locale) !== undefined,
    };
  });

  for (const n of step.notes) {
    if (n.pending === undefined) projects.clearPendingNotes(n.rowId);
    else projects.setPendingNotes(n.pending);
    const row = index?.byRowId.get(n.rowId);
    if (row !== undefined) index?.patchNotes(n.rowId, n.pending?.notes ?? fileNotesOf(row));
  }

  return { inverse, cells, noteRows: step.notes.map((n) => n.rowId) };
}

/** Drop one cell from every step, and the steps left with nothing in them. */
export function pruneSteps(steps: readonly UndoStep[], rowId: string, locale?: string): UndoStep[] {
  const out: UndoStep[] = [];
  for (const step of steps) {
    const cells = step.cells.filter(
      (c) => c.rowId !== rowId || (locale !== undefined && c.locale !== locale),
    );
    const notes = locale === undefined ? step.notes.filter((n) => n.rowId !== rowId) : step.notes;
    if (cells.length === 0 && notes.length === 0) continue;
    out.push(
      cells.length === step.cells.length && notes.length === step.notes.length
        ? step
        : { ...step, cells, notes },
    );
  }
  return out;
}

export function statusOf(undo: readonly UndoStep[], redo: readonly UndoStep[]): HistoryStatus {
  return {
    canUndo: undo.length > 0,
    canRedo: redo.length > 0,
    undoLabel: undo.at(-1)?.label ?? null,
    redoLabel: redo.at(-1)?.label ?? null,
  };
}
