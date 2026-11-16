// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  DiscardRequestSchema,
  type ChangedCell,
  type DiscardResponse,
  type HistoryStatus,
  type HistoryStepResponse,
} from '@lexi/shared';

import { refreshIndexCell } from '../lib/commit.js';
import { writeDrafts } from '../lib/drafts.js';
import { StepRecorder, restoreStep, type UndoStep } from '../lib/history.js';
import { conflict, notFound } from '../lib/http-error.js';
import { writeMachineOrigins } from '../lib/machine-origin.js';
import { fileNotesOf } from '../lib/notes.js';
import { writeReviewNotes } from '../lib/review-notes.js';
import { writeReviewStats } from '../lib/review-stats.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';

/**
 * Throwing unsaved work away, and taking that — or any other step — back.
 *
 * Nothing here writes into the user's repository. A discard only empties the
 * overlay, and undo and redo only move it between snapshots (`lib/history.ts`);
 * what they write is `.lexi/`, so a restart finds the same state.
 */
export function registerHistory(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
): void {
  const requireOpen = (): void => {
    if (!projects.current || !projects.index) throw notFound('no project is open');
  };

  app.get('/api/history', async (): Promise<HistoryStatus> => projects.historyStatus);

  /**
   * Discard the given cells' drafts, or — with no body — every unsaved edit,
   * note edits included. One undo step either way.
   */
  app.post('/api/drafts/discard', async (req): Promise<DiscardResponse> => {
    requireOpen();
    const body = DiscardRequestSchema.parse(req.body ?? {});
    const all = body.cells === undefined;
    const step = new StepRecorder(projects, all ? 'Discard all' : 'Revert');

    const refs =
      body.cells ??
      [...projects.pending.values()].map((p) => ({ rowId: p.rowId, locale: p.locale }));
    const touched = refs.filter((c) => projects.pendingFor(c.rowId, c.locale) !== undefined);
    for (const c of touched) {
      step.cell(c.rowId, c.locale);
      projects.clearPending(c.rowId, c.locale);
    }
    const noteRows = all ? [...projects.pendingNotes.keys()] : [];
    for (const rowId of noteRows) {
      step.notes(rowId);
      projects.clearPendingNotes(rowId);
    }

    const index = projects.index;
    const cells: ChangedCell[] = touched.map((c) => {
      const row = index?.byRowId.get(c.rowId);
      const target = row === undefined ? undefined : refreshIndexCell(projects, row, c.locale);
      return { ...c, target: target ?? null, pending: false };
    });
    for (const rowId of noteRows) {
      const row = index?.byRowId.get(rowId);
      if (row !== undefined) index?.patchNotes(rowId, fileNotesOf(row));
    }

    step.finish();
    await writeDrafts(cfg, projects);
    return {
      cells,
      noteRows,
      unsavedCount: projects.unsavedCount,
      history: projects.historyStatus,
    };
  });

  /**
   * Restore one step and file its inverse on the other stack. Every `.lexi/`
   * file a step can touch is rewritten, since a step may have moved any of them.
   */
  const travel = async (
    take: () => UndoStep | undefined,
    put: (inverse: UndoStep) => void,
    nothing: string,
  ): Promise<HistoryStepResponse> => {
    requireOpen();
    const project = projects.current;
    const step = take();
    if (project === null || step === undefined) throw conflict(nothing);

    const { inverse, cells, noteRows } = restoreStep(projects, step);
    put(inverse);

    await writeDrafts(cfg, projects);
    await writeMachineOrigins(cfg, project.path, projects.machineOrigins);
    await writeReviewNotes(cfg, project.path, projects.reviewNotes);
    await writeReviewStats(cfg, project.path, projects.reviewStats);
    return {
      label: step.label,
      cells,
      noteRows,
      unsavedCount: projects.unsavedCount,
      history: projects.historyStatus,
    };
  };

  app.post('/api/history/undo', () =>
    travel(
      () => projects.takeUndo(),
      (inverse) => projects.pushRedo(inverse),
      'There is nothing to undo.',
    ),
  );

  app.post('/api/history/redo', () =>
    travel(
      () => projects.takeRedo(),
      (inverse) => projects.pushUndo(inverse),
      'There is nothing to redo.',
    ),
  );
}
