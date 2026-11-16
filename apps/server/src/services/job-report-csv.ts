// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  stringifyCsv,
  tokenText,
  type CsvDelimiter,
  type SegmentDto,
  type UnitNote,
} from '@lexi/shared';

import type { ExportSnapshot } from '../lib/export-snapshot.js';
import type { JobReport, ReportUnit } from './job-report.js';

/**
 * The job as a CSV — unit id, description, export id, source, then a column
 * per locale with its translation — for a reviewer in the target market who
 * edits the translations in Excel. The file is meant to come back: a later
 * import matches each row by its id, each column by its locale, and puts the
 * edited translation into that cell.
 *
 * Placeholders are written as numbered tokens; `token-text.ts` in the shared
 * package holds the format, because the import reads it back.
 *
 * UTF-8 with a BOM, or Excel reads the file as the system code page and every
 * umlaut comes out mangled.
 */

const BOM = '﻿';

export function renderJobReportCsv(
  report: JobReport,
  delimiter: CsvDelimiter,
  exportId: string,
  locale?: string,
): string {
  const units =
    locale === undefined ? report.units : report.units.filter((u) => u.locale === locale);
  // The report is grouped by locale in the job's run order, so that is the
  // column order too.
  const locales = [...new Set(units.map((u) => u.locale))];
  // One row per unit: a job drafts several locales of the same key, and the
  // reviewer reads them side by side.
  const byRow = new Map<string, Map<string, ReportUnit>>();
  for (const u of units) {
    const row = byRow.get(u.rowId) ?? new Map<string, ReportUnit>();
    row.set(u.locale, u);
    byRow.set(u.rowId, row);
  }

  const rows: string[][] = [['Unit ID', 'Description', 'Export', 'Source', ...locales]];
  // Qualified ids are decided over the whole job, so a per-locale file names a
  // unit the same way the single file does.
  const ambiguous = ambiguousIds(report.units);
  for (const cells of byRow.values()) {
    const u = cells.values().next().value!;
    rows.push([
      ambiguous.has(u.unitId) && u.group !== null ? `${u.group}/${u.unitId}` : u.unitId,
      description(u.notes),
      // The id of the snapshot taken with this file: the import's baseline.
      exportId,
      tokenText(u.source),
      ...locales.map((l) => {
        const cell = cells.get(l);
        const translation = cell === undefined ? null : translationOf(cell);
        return translation === null ? '' : tokenText(translation);
      }),
    ]);
  }
  return BOM + stringifyCsv(rows, delimiter);
}

/**
 * What the export said, for the snapshot: one row per unit and locale, with
 * the very segments the Translation cell was rendered from, so that
 * `tokenText(segments)` equals the cell. Always the whole job, whatever the
 * file split.
 */
export function snapshotOf(report: JobReport, exportId: string, at: string): ExportSnapshot {
  return {
    version: 1,
    id: exportId,
    jobId: report.record.job.id,
    at,
    rows: report.units.map((u) => {
      const segments = translationOf(u);
      return {
        group: u.group,
        unitId: u.unitId,
        locale: u.locale,
        source: [...u.source],
        segments: segments === null ? null : [...segments],
      };
    }),
  };
}

/**
 * A unit id is unique within its file group, not the project. When the job
 * holds the same id from two groups, those rows carry the group too.
 */
function ambiguousIds(units: readonly ReportUnit[]): Set<string> {
  const groups = new Map<string, Set<string | null>>();
  for (const u of units) {
    const seen = groups.get(u.unitId) ?? new Set();
    seen.add(u.group);
    groups.set(u.unitId, seen);
  }
  return new Set([...groups].filter(([, g]) => g.size > 1).map(([id]) => id));
}

/**
 * What the cell says: the job's draft, or what replaced it since; for a
 * skipped unit the human translation it kept. Nothing for a rejection or a
 * failure — the job wrote nothing there to review.
 */
function translationOf(u: ReportUnit): readonly SegmentDto[] | null {
  if (u.outcome === 'accepted') return u.current ?? u.written;
  if (u.outcome === 'skipped') return u.kept;
  return null;
}

/** Angular's `description` is the text itself; any other note is labelled. */
function description(notes: readonly UnitNote[]): string {
  return notes
    .map((n) => (n.from === null || n.from === 'description' ? n.text : `${n.from}: ${n.text}`))
    .join('\n');
}
