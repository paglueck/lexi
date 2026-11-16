// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { importRow, previewFixture } from '../../core/testing/csv-import-fixture.js';
import {
  applyLabel,
  baselineLine,
  chipOf,
  counts,
  localeOptions,
  openConflicts,
  summary,
  toWrite,
  visibleRows,
  type Resolution,
} from './import-model.js';

const rows = previewFixture().rows;
const none = new Set<string>();
const unresolved: Resolution = new Map();
const decided = (key: string, choice: 'csv' | 'current'): Resolution => new Map([[key, choice]]);

describe('visibleRows', () => {
  it('lists changes, conflicts and not-importable rows under "all", never unchanged ones', () => {
    expect(visibleRows(rows, 'all', 'all').map((r) => r.category)).toEqual([
      'changed',
      'conflict',
      'skipped',
      'blocked',
    ]);
  });

  it('shows no rows on the Unchanged tab', () => {
    expect(visibleRows(rows, 'same', 'all')).toEqual([]);
  });

  it('keeps a tr-TR row under the tr locale filter', () => {
    expect(visibleRows(rows, 'error', 'tr').map((r) => r.locale)).toEqual(['tr-TR']);
  });
});

describe('counts', () => {
  it('counts every tab across all locales', () => {
    expect(counts(rows, 'all', unresolved)).toEqual({
      all: 4,
      change: 1,
      conflict: 1,
      error: 2,
      same: 1,
      open: 1,
    });
  });

  it('applies the locale filter to every tab, with tr-TR counted under tr', () => {
    expect(counts(rows, 'tr', unresolved)).toEqual({
      all: 2,
      change: 0,
      conflict: 1,
      error: 1,
      same: 0,
      open: 1,
    });
  });

  it('stops counting a conflict as open once it is decided', () => {
    expect(counts(rows, 'all', decided('0:3', 'current')).open).toBe(0);
  });
});

describe('chipOf', () => {
  const changed = importRow();
  const conflict = importRow({ key: 'c', category: 'conflict' });

  it.each([
    ['changed', changed, none, unresolved, false],
    ['warning', importRow({ warnings: ['Source changed since export'] }), none, unresolved, false],
    ['excluded', changed, new Set([changed.key]), unresolved, false],
    ['applied', changed, none, unresolved, true],
    ['decide', conflict, none, unresolved, false],
    ['useCsv', conflict, none, decided('c', 'csv'), false],
    ['keepCurrent', conflict, none, decided('c', 'current'), false],
    ['applied', conflict, none, decided('c', 'csv'), true],
    ['keepCurrent', conflict, none, decided('c', 'current'), true],
    ['blocked', importRow({ category: 'blocked' }), none, unresolved, false],
    ['skipped', importRow({ category: 'skipped' }), none, unresolved, false],
  ] as const)('is %s', (chip, row, excluded, resolution, applied) => {
    expect(chipOf(row, excluded, resolution, applied)).toBe(chip);
  });

  it('keeps an excluded change excluded after Apply', () => {
    expect(chipOf(changed, new Set([changed.key]), unresolved, true)).toBe('excluded');
  });
});

describe('toWrite and openConflicts', () => {
  it('writes included changes and conflicts resolved as "use CSV"', () => {
    expect(toWrite(rows, none, unresolved).map((r) => r.key)).toEqual(['0:2']);
    expect(toWrite(rows, new Set(['0:2']), decided('0:3', 'csv')).map((r) => r.key)).toEqual([
      '0:3',
    ]);
    expect(openConflicts(rows, unresolved).map((r) => r.key)).toEqual(['0:3']);
    expect(openConflicts(rows, decided('0:3', 'csv'))).toEqual([]);
  });
});

describe('applyLabel', () => {
  it('asks for the open conflicts first', () => {
    expect(applyLabel(3, 2, false)).toEqual({ label: 'Resolve 2 conflicts', ready: false });
    expect(applyLabel(3, 1, false)).toEqual({ label: 'Resolve 1 conflict', ready: false });
  });

  it('is ready with nothing open and something to write', () => {
    expect(applyLabel(3, 0, false)).toEqual({ label: 'Apply 3 changes', ready: true });
    expect(applyLabel(0, 0, false)).toEqual({ label: 'Apply 0 changes', ready: false });
  });

  it('marks unchanged units final when that is all there is to write', () => {
    expect(applyLabel(0, 0, false, 2)).toEqual({ label: 'Mark 2 units final', ready: true });
    expect(applyLabel(3, 0, false, 2)).toEqual({ label: 'Apply 3 changes', ready: true });
    expect(applyLabel(0, 1, false, 2)).toEqual({ label: 'Resolve 1 conflict', ready: false });
  });

  it('reads Applied afterwards', () => {
    expect(applyLabel(3, 0, true)).toEqual({ label: 'Applied', ready: false });
  });
});

describe('summary', () => {
  it('names the written units per locale and the rows left out', () => {
    expect(summary(rows, none, decided('0:3', 'csv'))).toBe(
      '2 units will be written · nl 1 · tr 1 · 2 not importable',
    );
    expect(summary(rows, none, unresolved)).toBe(
      '1 unit will be written · nl 1 · 2 not importable',
    );
  });

  it('names the unchanged units marked final', () => {
    expect(summary(rows, none, unresolved, 1)).toBe(
      '1 unit will be written · nl 1 · 1 unchanged marked final · 2 not importable',
    );
  });
});

describe('localeOptions', () => {
  it('offers each language once, tr-TR folded into tr', () => {
    expect(localeOptions(rows)).toEqual([
      { value: 'all', label: 'All locales' },
      { value: 'nl', label: 'nl' },
      { value: 'tr', label: 'tr' },
    ]);
  });
});

describe('baselineLine', () => {
  it('names the export snapshot, or says there was none', () => {
    expect(baselineLine({ exportId: 'e', jobId: 'j', at: '2026-10-20T13:14:00' })).toMatch(
      /^Baseline: export snapshot, 20 Oct 13:14$/,
    );
    expect(baselineLine(null)).toBe('Baseline: current state (no export snapshot found)');
  });
});
