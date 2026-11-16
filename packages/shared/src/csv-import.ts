// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { SegmentSchema } from './units.js';

/**
 * `POST /api/csv-import/preview`, `POST /api/csv-import/apply`,
 * `POST /api/csv-import/:id/undo`, `GET /api/jobs/:id/imports` — the CSV
 * re-import.
 *
 * A reviewer edits the job's CSV export in Excel and hands it back. Preview
 * compares every row with the cell it names and sorts it into a category;
 * Apply writes the rows the user included. The files travel as text in the
 * request, both times: the server holds no upload between the two calls, so a
 * preview cannot go stale in a way Apply does not re-check.
 */

/**
 * What a row would do. `changed` writes; `conflict` writes only if the user
 * includes it, because the cell moved on since the export; `unchanged` and
 * `skipped` write nothing; `blocked` cannot be applied and says why.
 */
export const CsvImportCategorySchema = z.enum([
  'changed',
  'conflict',
  'unchanged',
  'skipped',
  'blocked',
]);
export type CsvImportCategory = z.infer<typeof CsvImportCategorySchema>;

/**
 * Four versions of one cell, so the dialog can show who is right: `exported`
 * is what the CSV was written from (the baseline), `current` is the cell now,
 * `csv` is what the reviewer sent. Each is null when it cannot be known — no
 * export snapshot, no such cell, or a translation that failed to parse.
 * `exported` is `[]`, not null, for a cell the export wrote empty: that
 * emptiness is the baseline.
 */
export const CsvImportRowSchema = z.object({
  /** `${fileIndex}:${line}`, unique across the picked files. */
  key: z.string(),
  file: z.string(),
  line: z.number().int(),
  unitId: z.string(),
  rowId: z.string().nullable(),
  locale: z.string(),
  category: CsvImportCategorySchema,
  reason: z.string().nullable(),
  warnings: z.array(z.string()),
  source: z.array(SegmentSchema).nullable(),
  exported: z.array(SegmentSchema).nullable(),
  current: z.array(SegmentSchema).nullable(),
  csv: z.array(SegmentSchema).nullable(),
  /** The cell as the file wrote it, tokens and all, for a row that did not parse. */
  csvText: z.string(),
  currentChangedBy: z.string().nullable(),
  currentChangedAt: z.string().nullable(),
  checks: z.object({
    placeholders: z.boolean(),
    sourceUnchanged: z.boolean().nullable(),
  }),
  /**
   * An `unchanged` row the reviewer confirmed: the CSV holds exactly the
   * cell's current text, no unsaved edit sits over it, it is not final yet,
   * and no other row edits it. One row per cell at most, so the flags count
   * cells.
   */
  finalizable: z.boolean(),
});
export type CsvImportRow = z.infer<typeof CsvImportRowSchema>;

const CsvFileSchema = z.object({ name: z.string(), text: z.string() });

export const CsvImportColumnSchema = z.object({ name: z.string(), recognised: z.boolean() });

export const CsvImportPreviewRequestSchema = z.object({
  files: z.array(CsvFileSchema).min(1),
  jobId: z.string().nullable(),
});
export type CsvImportPreviewRequest = z.infer<typeof CsvImportPreviewRequestSchema>;

export const CsvImportPreviewResponseSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      delimiter: z.enum([',', ';']),
      rowCount: z.number().int(),
      columns: z.array(CsvImportColumnSchema),
    }),
  ),
  /** The export snapshot the rows were compared with; null when none was found. */
  baseline: z.object({ exportId: z.string(), jobId: z.string(), at: z.string() }).nullable(),
  rows: z.array(CsvImportRowSchema),
});
export type CsvImportPreviewResponse = z.infer<typeof CsvImportPreviewResponseSchema>;

export const CsvImportStateSchema = z.enum(['needsReview', 'reviewed', 'final']);

/**
 * Apply re-sends the files and the user's choices. Each included row carries
 * `current`, the cell's token text as the preview saw it, so a cell that
 * changed in between (a Grid edit, a reload, a job) is answered with 409
 * instead of being overwritten.
 */
export const CsvImportApplyRequestSchema = z.object({
  files: z.array(CsvFileSchema).min(1),
  jobId: z.string().nullable(),
  state: CsvImportStateSchema,
  /** Also mark every `finalizable` row's cell final, its text left as it is. */
  finalizeUnchanged: z.boolean().default(false),
  include: z.array(
    z.object({
      key: z.string(),
      /** `tokenText` of the cell at preview, `''` if it had no translation. */
      current: z.string(),
    }),
  ),
});
export type CsvImportApplyRequest = z.infer<typeof CsvImportApplyRequestSchema>;

export const CsvImportApplyResponseSchema = z.object({
  importId: z.string(),
  at: z.string(),
  written: z.array(z.object({ path: z.string(), count: z.number().int() })),
});
export type CsvImportApplyResponse = z.infer<typeof CsvImportApplyResponseSchema>;

/** Undo restores what it can; a cell edited since the import is left alone and listed. */
export const CsvImportUndoResponseSchema = z.object({
  restored: z.number().int(),
  skipped: z.array(z.object({ rowId: z.string(), locale: z.string() })),
});
export type CsvImportUndoResponse = z.infer<typeof CsvImportUndoResponseSchema>;

export const CsvImportSummarySchema = z.object({
  importId: z.string(),
  at: z.string(),
  jobId: z.string().nullable(),
  count: z.number().int(),
  undone: z.boolean(),
});
export type CsvImportSummary = z.infer<typeof CsvImportSummarySchema>;

export const JobImportsResponseSchema = z.object({ imports: z.array(CsvImportSummarySchema) });
export type JobImportsResponse = z.infer<typeof JobImportsResponseSchema>;
