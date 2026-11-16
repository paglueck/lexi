// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseCsv, tokenText, type JobRecord } from '@lexi/shared';

import type { JobReport, ReportUnit } from '../src/services/job-report.js';
import { renderJobReportCsv, snapshotOf } from '../src/services/job-report-csv.js';

const unit = (over: Partial<ReportUnit> & Pick<ReportUnit, 'unitId'>): ReportUnit => ({
  no: 1,
  locale: 'de',
  rowId: over.unitId,
  group: 'messages',
  outcome: 'accepted',
  notes: [],
  locations: [],
  source: [],
  written: null,
  current: null,
  kept: null,
  currentState: null,
  confidence: null,
  notesForReviewer: null,
  findings: [],
  rejection: null,
  message: null,
  raw: null,
  system: null,
  user: null,
  userShownAt: null,
  batch: null,
  gone: false,
  ...over,
});

const reportOf = (units: ReportUnit[]): JobReport => ({
  record: { job: { id: 'job-1' } } as JobRecord,
  generatedAt: '2026-10-16T00:00:00.000Z',
  sharedSystem: null,
  units,
});

const text = (v: string) => ({ k: 't' as const, v });

const EXPORT = '3f2b8c1e-5a47-4d0e-9b6a-1c2d3e4f5a6b';
const render = (report: JobReport, delimiter: ',' | ';', locale?: string): string =>
  renderJobReportCsv(report, delimiter, EXPORT, locale);

describe('renderJobReportCsv', () => {
  it('starts with a BOM and a header with the fixed columns and one per locale', () => {
    const csv = render(
      reportOf([unit({ unitId: 'a', locale: 'de' }), unit({ unitId: 'a', locale: 'fr' })]),
      ';',
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe('Unit ID;Description;Export;Source;de;fr');
  });

  it('writes what the cell says now: the draft, its replacement, or the kept human translation', () => {
    const csv = render(
      reportOf([
        unit({ unitId: 'drafted', written: [text('Entwurf')] }),
        unit({ unitId: 'edited', written: [text('Entwurf')], current: [text('Korrigiert')] }),
        unit({ unitId: 'skipped', outcome: 'skipped', kept: [text('Von Hand')] }),
        unit({ unitId: 'rejected', outcome: 'rejected' }),
        unit({ unitId: 'failed', outcome: 'failed' }),
      ]),
      ',',
    );
    expect(parseCsv(csv).slice(1)).toEqual([
      ['drafted', '', EXPORT, '', 'Entwurf'],
      ['edited', '', EXPORT, '', 'Korrigiert'],
      ['skipped', '', EXPORT, '', 'Von Hand'],
      ['rejected', '', EXPORT, '', ''],
      ['failed', '', EXPORT, '', ''],
    ]);
  });

  it('writes the source as token text', () => {
    const csv = render(
      reportOf([
        unit({
          unitId: 'a',
          source: [text('Pay '), { k: 'p', id: 'INTERPOLATION', equivText: '{{ amount }}' }],
          written: [text('Zahle '), { k: 'p', id: 'INTERPOLATION', equivText: '{{ amount }}' }],
        }),
      ]),
      ',',
    );
    expect(parseCsv(csv)[1]).toEqual([
      'a',
      '',
      EXPORT,
      'Pay {1:{{ amount }}}',
      'Zahle {1:{{ amount }}}',
    ]);
  });

  it('puts the description first and labels any other note, one per line', () => {
    const csv = render(
      reportOf([
        unit({
          unitId: 'a',
          notes: [
            { from: 'description', priority: null, text: 'Checkout button' },
            { from: 'meaning', priority: null, text: 'verb' },
          ],
        }),
      ]),
      ',',
    );
    expect(parseCsv(csv)[1]).toEqual(['a', 'Checkout button\nmeaning: verb', EXPORT, '', '']);
  });

  it('qualifies an id only when the job holds it from two file groups', () => {
    const csv = render(
      reportOf([
        unit({ unitId: 'dup', rowId: 'r1', group: 'one' }),
        unit({ unitId: 'dup', rowId: 'r2', group: 'two' }),
        unit({ unitId: 'solo', group: 'one' }),
      ]),
      ',',
    );
    expect(
      parseCsv(csv)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(['one/dup', 'two/dup', 'solo']);
  });

  it('writes one row per unit with a column per locale, and does not mistake two locales for two groups', () => {
    const csv = render(
      reportOf([
        unit({ unitId: 'a', locale: 'de', written: [text('Hallo')] }),
        unit({ unitId: 'b', locale: 'de', written: [text('Tschüss')] }),
        unit({ unitId: 'a', locale: 'fr', written: [text('Bonjour')] }),
      ]),
      ',',
    );
    expect(parseCsv(csv)).toEqual([
      ['Unit ID', 'Description', 'Export', 'Source', 'de', 'fr'],
      ['a', '', EXPORT, '', 'Hallo', 'Bonjour'],
      // Not in the job for fr: nothing to review there.
      ['b', '', EXPORT, '', 'Tschüss', ''],
    ]);
  });
});

describe('the Export column and the locale filter', () => {
  it('repeats the export id on every row', () => {
    const csv = render(reportOf([unit({ unitId: 'a' }), unit({ unitId: 'b' })]), ',');
    const rows = parseCsv(csv);
    expect(rows[0]?.[2]).toBe('Export');
    expect(rows.slice(1).map((r) => r[2])).toEqual([EXPORT, EXPORT]);
  });

  it('renders only the asked-for locale, as its only column', () => {
    const csv = render(
      reportOf([
        unit({ unitId: 'a', locale: 'de', written: [text('Hallo')] }),
        unit({ unitId: 'b', locale: 'de', written: [text('Tschüss')] }),
        unit({ unitId: 'a', locale: 'nl', written: [text('Hallo!')] }),
      ]),
      ',',
      'nl',
    );
    expect(parseCsv(csv).slice(1)).toEqual([['a', '', EXPORT, '', 'Hallo!']]);
    expect(parseCsv(csv)[0]?.slice(4)).toEqual(['nl']);
  });
});

describe('snapshotOf', () => {
  it('records the exact segments each row was rendered from, every locale', () => {
    const edited = [text('Korrigiert')];
    const snap = snapshotOf(
      reportOf([
        unit({ unitId: 'a', source: [text('Src')], written: [text('Entwurf')], current: edited }),
        unit({ unitId: 'b', outcome: 'failed', locale: 'nl' }),
      ]),
      EXPORT,
      '2026-10-20T10:00:00.000Z',
    );
    expect(snap.version).toBe(1);
    expect(snap.id).toBe(EXPORT);
    expect(snap.jobId).toBe('job-1');
    expect(snap.at).toBe('2026-10-20T10:00:00.000Z');
    expect(snap.rows).toEqual([
      { group: 'messages', unitId: 'a', locale: 'de', source: [text('Src')], segments: edited },
      { group: 'messages', unitId: 'b', locale: 'nl', source: [], segments: null },
    ]);
  });
});

describe('tokenText', () => {
  it('numbers placeholders and groups in document order, nesting included', () => {
    expect(
      tokenText([
        text('Pay '),
        { k: 'p', id: 'INTERPOLATION', equivText: '{{ amount }}' },
        text(' '),
        { k: 'g', id: 'START_BOLD_TEXT', children: [text('now '), { k: 'p', id: 'ICU' }] },
      ]),
    ).toBe('Pay {1:{{ amount }}} {2}now {3:ICU}{/2}');
  });
});
