// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CsvDelimiter } from './constants.js';
import { detectDelimiter, parseCsv } from './termbase-csv.js';

/**
 * The review CSV as it comes back from a reviewer: the file `job-report-csv`
 * wrote, after a round through Excel.
 *
 * Zod-free and Node-free, like `termbase-csv.ts`: the import dialog reads the
 * picked files in the browser to list their columns and row counts, and the
 * server parses the same text again at preview and at Apply, so the two cannot
 * disagree about what a file contains.
 *
 * Excel is not gentle with what it re-saves. The BOM may be gone, the delimiter
 * may have switched between `;` and `,`, empty columns may trail every row.
 * This parser takes all of that; only a missing Unit ID or locale column is an error.
 */

/** One locale cell of a data line, with the line the reviewer sees in Excel. */
export interface ReviewCsvRow {
  /** 1-based and counting the header, so line 2 is the first data row. */
  line: number;
  unitId: string;
  locale: string;
  translation: string;
  /** The export the row came from, when the file kept the `Export` column. */
  exportId: string | null;
}

export interface ReviewCsvFile {
  name: string;
  delimiter: CsvDelimiter;
  /** Every named column; `recognised` is false for the ones the import ignores. */
  columns: { name: string; recognised: boolean }[];
  rows: ReviewCsvRow[];
}

const FIXED = new Set(['unit id', 'description', 'export', 'source']);

/**
 * Parse a review CSV: one line per unit, one column per locale. A column is a
 * locale's when its header is one of `locales`, the project's target locales;
 * every other column the reviewer added is listed and ignored. Fixed headers
 * match case-insensitively and trimmed, because a reviewer who retypes a
 * header should not fail the file for it. Each line yields a row per locale
 * column, so the import checks every cell on its own. A line without a Unit ID
 * is a stray empty line Excel kept, and is skipped. The translation is kept
 * exactly as typed — whitespace and newlines belong to it.
 *
 * Description and Source are recognised but not read: the import compares
 * with the project's source, not with what the file says it was.
 */
export function parseReviewCsv(
  name: string,
  text: string,
  locales: readonly string[],
): ReviewCsvFile | { error: string } {
  const delimiter = detectDelimiter(text);
  const records = parseCsv(text, delimiter);
  const header = (records[0] ?? []).map((h) => h.trim());
  while (header.length > 0 && header[header.length - 1] === '') header.pop();

  const index = (column: string): number =>
    header.findIndex((h) => h.toLowerCase() === column.toLowerCase());
  const unitCol = index('Unit ID');
  const exportCol = index('Export');
  const localeCols = header.flatMap((h, i) => (locales.includes(h) ? [{ locale: h, at: i }] : []));
  if (unitCol < 0 || localeCols.length === 0) {
    return { error: 'The file needs a Unit ID column and a column per locale (e.g. de-DE).' };
  }

  const rows: ReviewCsvRow[] = [];
  records.slice(1).forEach((record, i) => {
    const unitId = (record[unitCol] ?? '').trim();
    if (unitId === '') return;
    const exportId = exportCol < 0 ? '' : (record[exportCol] ?? '').trim();
    for (const { locale, at } of localeCols) {
      rows.push({
        line: i + 2,
        unitId,
        locale,
        translation: record[at] ?? '',
        exportId: exportId === '' ? null : exportId,
      });
    }
  });

  return {
    name,
    delimiter,
    columns: header.map((h) => ({
      name: h,
      recognised: FIXED.has(h.toLowerCase()) || locales.includes(h),
    })),
    rows,
  };
}
