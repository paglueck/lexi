// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CsvImportPreviewResponse, CsvImportRow } from '@lexi/shared';

const text = (v: string) => [{ k: 't' as const, v }];

/** One CSV re-import row for specs: a changed `nl` row unless told otherwise. */
export function importRow(over: Partial<CsvImportRow> = {}): CsvImportRow {
  return {
    key: '0:2',
    file: 'review.csv',
    line: 2,
    unitId: 'checkout.pay_later',
    rowId: 'r1',
    locale: 'nl',
    category: 'changed',
    reason: null,
    warnings: [],
    source: text('Pay later'),
    exported: text('Later betalen'),
    current: text('Later betalen'),
    csv: text('Achteraf betalen'),
    csvText: 'Achteraf betalen',
    currentChangedBy: null,
    currentChangedAt: null,
    checks: { placeholders: true, sourceUnchanged: true },
    finalizable: false,
    ...over,
  };
}

/**
 * A preview with one row of each category, in file order: changed (nl),
 * conflict (tr), unchanged (nl), skipped (nl), blocked under `tr-TR`.
 */
export function previewFixture(): CsvImportPreviewResponse {
  return {
    files: [
      {
        name: 'northwind_job13.csv',
        delimiter: ',',
        rowCount: 5,
        columns: [
          { name: 'Unit ID', recognised: true },
          { name: 'Description', recognised: true },
          { name: 'Export', recognised: true },
          { name: 'Source', recognised: true },
          { name: 'nl', recognised: true },
          { name: 'tr', recognised: true },
          { name: 'Reviewer note', recognised: false },
        ],
      },
    ],
    baseline: { exportId: 'e1', jobId: 'j1', at: '2026-10-20T13:14:00' },
    rows: [
      importRow({ key: '0:2', line: 2 }),
      importRow({
        key: '0:3',
        line: 3,
        unitId: 'account.delete_confirm',
        rowId: 'r2',
        locale: 'tr',
        category: 'conflict',
        exported: text('Hesabınız silinsin mi?'),
        current: text('Hesabınızı silmek istiyor musunuz?'),
        csv: text('Hesabınız kalıcı olarak silinsin mi?'),
        csvText: 'Hesabınız kalıcı olarak silinsin mi?',
        currentChangedBy: 'edited in Grid',
        currentChangedAt: null,
      }),
      importRow({
        key: '0:4',
        line: 4,
        unitId: 'checkout.pay_now',
        rowId: 'r3',
        category: 'unchanged',
        csv: text('Later betalen'),
        finalizable: true,
        csvText: 'Later betalen',
      }),
      importRow({
        key: '0:5',
        line: 5,
        unitId: 'checkout.card_label',
        rowId: 'r4',
        category: 'skipped',
        reason: 'Empty cell. The target stays as it is.',
        csv: null,
        csvText: '',
      }),
      importRow({
        key: '0:6',
        line: 6,
        unitId: 'orders.status_shipped',
        rowId: null,
        locale: 'tr-TR',
        category: 'blocked',
        reason: 'Unknown locale "tr-TR"',
        source: null,
        exported: null,
        current: null,
        csv: null,
        csvText: 'Kargoya verildi',
        checks: { placeholders: true, sourceUnchanged: null },
      }),
    ],
  };
}
