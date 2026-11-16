// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CsvImportPreviewResponse, CsvImportRow } from '@lexi/shared';

import { clock } from '../../core/format-time.js';
import type { SegmentOption } from '../../ui/segmented-control.js';

/**
 * The S16 import screen's derivations, kept pure so the screen's rules (which
 * rows a tab lists, what a chip says, what Apply would write) are tested
 * without a component around them. The page holds the state; every function
 * here takes the slice of it that it reads.
 */

/** The list's tabs: All changes, Changed, Conflicts, Not importable, Unchanged. */
export type Filter = 'all' | 'change' | 'conflict' | 'error' | 'same';

/** A conflict's decision. A conflict with no entry is still open. */
export type Resolution = ReadonlyMap<string, 'csv' | 'current'>;

/** The status chip a row shows, in the list and in the detail header. */
export type ImportChip =
  | 'changed'
  | 'warning'
  | 'excluded'
  | 'decide'
  | 'useCsv'
  | 'keepCurrent'
  | 'blocked'
  | 'skipped'
  | 'applied';

/** The tab a row belongs to. Skipped and blocked rows share "Not importable". */
export function filterOf(row: CsvImportRow): Exclude<Filter, 'all'> {
  switch (row.category) {
    case 'changed':
      return 'change';
    case 'conflict':
      return 'conflict';
    case 'unchanged':
      return 'same';
    default:
      return 'error';
  }
}

/** A row's language: `tr-TR` is `tr`, so a mistyped locale stays under its language. */
export const languageOf = (locale: string): string => locale.split('-')[0] ?? locale;

const inLocale = (row: CsvImportRow, locale: string): boolean =>
  locale === 'all' || languageOf(row.locale) === locale;

/**
 * The rows a tab lists. "All changes" is everything that needs a look:
 * changes, conflicts and the rows that cannot be imported. The Unchanged tab
 * lists none; it only says how many there are, since nothing can be done
 * with them.
 */
export function visibleRows(
  rows: readonly CsvImportRow[],
  filter: Filter,
  locale: string,
): CsvImportRow[] {
  if (filter === 'same') return [];
  return rows.filter((row) => {
    const of = filterOf(row);
    return of !== 'same' && (filter === 'all' || of === filter) && inLocale(row, locale);
  });
}

/**
 * Each tab's count under the locale filter, plus `open`, the conflicts still
 * to decide, which turns the Conflicts count amber.
 */
export function counts(
  rows: readonly CsvImportRow[],
  locale: string,
  resolution: Resolution,
): Record<Filter, number> & { readonly open: number } {
  const out = { all: 0, change: 0, conflict: 0, error: 0, same: 0, open: 0 };
  for (const row of rows) {
    if (!inLocale(row, locale)) continue;
    const of = filterOf(row);
    out[of] += 1;
    if (of !== 'same') out.all += 1;
    if (of === 'conflict' && !resolution.has(row.key)) out.open += 1;
  }
  return out;
}

/**
 * What a row's chip says. After Apply a written row reads `applied`; a row
 * that was not written keeps the chip that explains why (`excluded`,
 * `keepCurrent`). Unchanged rows are never listed, so they need no chip of
 * their own.
 */
export function chipOf(
  row: CsvImportRow,
  excluded: ReadonlySet<string>,
  resolution: Resolution,
  applied: boolean,
): ImportChip {
  switch (row.category) {
    case 'changed':
      if (excluded.has(row.key)) return 'excluded';
      if (applied) return 'applied';
      return row.warnings.length > 0 ? 'warning' : 'changed';
    case 'conflict': {
      const choice = resolution.get(row.key);
      if (choice === 'csv') return applied ? 'applied' : 'useCsv';
      return choice === 'current' ? 'keepCurrent' : 'decide';
    }
    case 'blocked':
      return 'blocked';
    default:
      return 'skipped';
  }
}

/** Is this row written by Apply: an included change, or a conflict resolved to the CSV. */
const writes = (row: CsvImportRow, excluded: ReadonlySet<string>, resolution: Resolution) =>
  (row.category === 'changed' && !excluded.has(row.key)) ||
  (row.category === 'conflict' && resolution.get(row.key) === 'csv');

/** The rows Apply writes, in file order. */
export function toWrite(
  rows: readonly CsvImportRow[],
  excluded: ReadonlySet<string>,
  resolution: Resolution,
): CsvImportRow[] {
  return rows.filter((row) => writes(row, excluded, resolution));
}

/** The cells Apply can mark final as they are; the server flags one row per cell. */
export function finalizableCount(rows: readonly CsvImportRow[]): number {
  return rows.filter((row) => row.finalizable).length;
}

/** The conflicts nobody has decided yet; Apply waits for them. */
export function openConflicts(
  rows: readonly CsvImportRow[],
  resolution: Resolution,
): CsvImportRow[] {
  return rows.filter((row) => row.category === 'conflict' && !resolution.has(row.key));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The Apply button. Open conflicts come first: the label says how many are
 * left rather than how many would be written, because writing is not on
 * offer until they are decided. With no change but unchanged cells to mark
 * final, that is what Apply does, and says so.
 */
export function applyLabel(
  n: number,
  open: number,
  applied: boolean,
  finals = 0,
): { label: string; ready: boolean } {
  if (applied) return { label: 'Applied', ready: false };
  if (open > 0) return { label: `Resolve ${plural(open, 'conflict', 'conflicts')}`, ready: false };
  if (n === 0 && finals > 0) {
    return { label: `Mark ${plural(finals, 'unit', 'units')} final`, ready: true };
  }
  return { label: `Apply ${plural(n, 'change', 'changes')}`, ready: n > 0 };
}

/** The footer line: what Apply writes, per locale, and how many rows are left out whatever happens. */
export function summary(
  rows: readonly CsvImportRow[],
  excluded: ReadonlySet<string>,
  resolution: Resolution,
  finals = 0,
): string {
  const written = toWrite(rows, excluded, resolution);
  const perLocale = new Map<string, number>();
  for (const row of written) perLocale.set(row.locale, (perLocale.get(row.locale) ?? 0) + 1);
  const notImportable = rows.filter((r) => filterOf(r) === 'error').length;
  return [
    `${plural(written.length, 'unit', 'units')} will be written`,
    ...[...perLocale].sort(([a], [b]) => a.localeCompare(b)).map(([l, n]) => `${l} ${n}`),
    ...(finals > 0 ? [`${finals} unchanged marked final`] : []),
    `${notImportable} not importable`,
  ].join(' · ');
}

/** The locale switch: All locales, then each language the file has rows for. */
export function localeOptions(rows: readonly CsvImportRow[]): SegmentOption[] {
  const languages = [...new Set(rows.map((r) => languageOf(r.locale)))].sort();
  return [
    { value: 'all', label: 'All locales' },
    ...languages.map((l) => ({ value: l, label: l })),
  ];
}

/**
 * Who changed a conflict's cell after the export, for "Changed in Lexi after
 * export, …" and the Keep current card. The server names the author only when
 * it knows one (an unsaved edit, a job draft); otherwise it was an edit in Lexi.
 */
export function changedBy(row: CsvImportRow): string {
  if (row.currentChangedBy === null) return 'edited in Lexi';
  const at = clock(row.currentChangedAt);
  return at === '' ? row.currentChangedBy : `${row.currentChangedBy} · ${at}`;
}

/**
 * The header's baseline line. The date is spelled `20 Oct 13:14` whatever the
 * browser's locale, as in the design; it names a moment in the export
 * history, not a value the user is reading in their own format.
 */
export function baselineLine(baseline: CsvImportPreviewResponse['baseline']): string {
  if (baseline === null) return 'Baseline: current state (no export snapshot found)';
  const at = new Date(baseline.at);
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `Baseline: export snapshot, ${date} ${time}`;
}
