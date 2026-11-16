// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  tokenText,
  type CsvImportApplyResponse,
  type CsvImportPreviewResponse,
  type CsvImportUndoResponse,
  type JobImportsResponse,
  type CsvImportRow,
  type EditSegmentDto,
  type SegmentDto,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { writeExportSnapshot, type ExportSnapshot } from '../src/lib/export-snapshot.js';
import { targetHash } from '../src/lib/machine-origin.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * The CSV import's preview (Task 9): every row of a returned review CSV sorted
 * into what Apply would do with it, by comparing the export snapshot (E), the
 * cell as Lexi shows it now (C) and the reviewer's value (V).
 *
 * The fixture has two file groups that both hold a unit `dup`, so a bare id is
 * ambiguous, and a snapshot written the way the CSV export writes it.
 */

const INTERP = '<x id="INTERPOLATION" equiv-text="{{ count }}"/>';

const xlf = (
  targetLanguage: string,
  units: string,
): string => `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="${targetLanguage}">
    <body>
${units}
    </body>
  </file>
</xliff>
`;

const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}
      </trans-unit>`;

const JOB = 'job-1';
const EXPORT = '11111111-2222-4333-8444-555555555555';
const OLDER = '99999999-2222-4333-8444-555555555555';

const t = (v: string): SegmentDto => ({ k: 't', v });
const ph: SegmentDto = { k: 'p', id: 'INTERPOLATION', equivText: '{{ count }}' };

let root: string;
let stateDir: string;
let cfg: ServerConfig;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-csv-import-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(join(root, 'checkout'), { recursive: true });
});

/**
 * The XLIFF fixture, rewritten before every test because Apply and Undo write
 * into it. `de` is the one file that uses `state` attributes; `tr` lacks `s`,
 * so importing it there creates the unit.
 */
async function writeFixture(): Promise<void> {
  await writeFile(
    join(root, 'messages.xlf'),
    xlf(
      'en-GB',
      [
        unit('a', 'Pay now'),
        unit('b', `You have ${INTERP} invoices`),
        unit('s', 'Save changes'),
        unit('dup', 'Duplicate'),
      ].join('\n'),
    ),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.nl.xlf'),
    xlf(
      'nl',
      [
        unit('a', 'Pay now', 'Nu betalen'),
        unit('b', `You have ${INTERP} invoices`, `U hebt ${INTERP} facturen`),
        unit('s', 'Save changes', 'Wijzigingen opslaan'),
        unit('dup', 'Duplicate', 'Dubbel'),
      ].join('\n'),
    ),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.tr.xlf'),
    xlf(
      'tr',
      [
        // Changed in Lexi since the export said `Şimdi öde`.
        unit('a', 'Pay now', 'Hemen öde'),
        unit('b', `You have ${INTERP} invoices`, `${INTERP} faturanız var`),
      ].join('\n'),
    ),
    'utf8',
  );
  await writeFile(
    join(root, 'checkout', 'messages.xlf'),
    xlf('en-GB', unit('dup', 'Checkout duplicate')),
    'utf8',
  );
  await writeFile(
    join(root, 'checkout', 'messages.nl.xlf'),
    xlf('nl', unit('dup', 'Checkout duplicate', 'Kassa dubbel')),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf(
      'de',
      [
        stateUnit('a', 'Pay now', 'Jetzt zahlen'),
        stateUnit('b', `You have ${INTERP} invoices`, `Sie haben ${INTERP} Rechnungen`),
      ].join('\n'),
    ),
    'utf8',
  );
}

const stateUnit = (id: string, source: string, target: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>
        <target state="translated">${target}</target>
      </trans-unit>`;

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

/**
 * A fresh server and a fresh `ProjectService` on the same folder, so a test
 * can check what a reopened project reads back from disk and `.lexi/`.
 */
async function openProject(): Promise<void> {
  await app?.close();
  cfg = testConfig({ roots: [root], stateDir });
  projects = new ProjectService();
  app = await buildApp(cfg, { logger: false, projects });

  const scan = await app.inject({
    method: 'POST',
    url: '/api/projects/scan',
    headers: goodHeaders(),
    payload: { path: root },
  });
  const files = scan.json<{
    files: Array<{ path: string; fileIndex: number; locale: string | null }>;
  }>().files;
  const opened = await app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: 'en-GB',
      mapping: files
        .filter((f) => f.locale !== null)
        .map((f) => ({ ...f, fixTargetLanguage: false })),
    },
  });
  expect(opened.statusCode, opened.body).toBe(200);
}

const snapshot = (id: string, at: string, rows: ExportSnapshot['rows']): ExportSnapshot => ({
  version: 1,
  id,
  jobId: JOB,
  at,
  rows,
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await writeFixture();
  await openProject();

  await writeExportSnapshot(
    cfg,
    root,
    snapshot(EXPORT, '2026-10-19T10:00:00.000Z', [
      {
        group: 'messages',
        unitId: 'a',
        locale: 'nl',
        source: [t('Pay now')],
        segments: [t('Nu betalen')],
      },
      {
        group: 'messages',
        unitId: 'a',
        locale: 'tr',
        source: [t('Pay now')],
        segments: [t('Şimdi öde')],
      },
      {
        group: 'messages',
        unitId: 'b',
        locale: 'nl',
        source: [t('You have '), ph, t(' invoices')],
        segments: [t('U hebt '), ph, t(' facturen')],
      },
      // Exported without its placeholder: a V that parses against it is still
      // short of the source's.
      {
        group: 'messages',
        unitId: 'b',
        locale: 'tr',
        source: [t('You have '), ph, t(' invoices')],
        segments: [t('faturalar')],
      },
      // The source said something else at export time.
      {
        group: 'messages',
        unitId: 's',
        locale: 'nl',
        source: [t('Save')],
        segments: [t('Wijzigingen opslaan')],
      },
    ]),
  );
  // An older export of the same job: never the baseline while a newer one exists.
  await writeExportSnapshot(
    cfg,
    root,
    snapshot(OLDER, '2026-10-01T10:00:00.000Z', [
      {
        group: 'messages',
        unitId: 'a',
        locale: 'nl',
        source: [t('Pay now')],
        segments: [t('Oud')],
      },
    ]),
  );
});

const csv = (rows: string[][], header: string[]): string =>
  [header, ...rows].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');

/**
 * A file in the export's layout from [id, locale, translation, export id]
 * cells: a unit's locales share its line, and a second cell for the same
 * locale starts a line of its own.
 */
const review = (
  cells: [id: string, locale: string, translation: string, exportId: string][],
): string => {
  const locales = [...new Set(cells.map(([, locale]) => locale))];
  const lines: { id: string; exportId: string; byLocale: Map<string, string> }[] = [];
  for (const [id, locale, v, exportId] of cells) {
    let line = lines.find((l) => l.id === id && !l.byLocale.has(locale));
    if (line === undefined) lines.push((line = { id, exportId, byLocale: new Map() }));
    line.byLocale.set(locale, v);
  }
  return csv(
    lines.map((l) => [l.id, '', l.exportId, '', ...locales.map((c) => l.byLocale.get(c) ?? '')]),
    ['Unit ID', 'Description', 'Export', 'Source', ...locales],
  );
};

async function preview(
  files: { name: string; text: string }[],
  jobId: string | null = null,
): Promise<{ status: number; body: CsvImportPreviewResponse & { error?: { message: string } } }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/csv-import/preview',
    headers: goodHeaders(),
    payload: { files, jobId },
  });
  return { status: res.statusCode, body: res.json() };
}

/** One file, every row stamped with the snapshot id like the export does. */
async function rowsOf(
  rows: [id: string, locale: string, translation: string][],
): Promise<CsvImportRow[]> {
  const res = await preview([
    { name: 'review.csv', text: review(rows.map(([id, loc, v]) => [id, loc, v, EXPORT])) },
  ]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.rows;
}

const only = async (id: string, locale: string, translation: string): Promise<CsvImportRow> =>
  (await rowsOf([[id, locale, translation]]))[0]!;

async function patch(unitId: string, locale: string, segments: EditSegmentDto[]): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/units/${encodeURIComponent(rowIdOf('messages', unitId))}/targets/${locale}`,
    headers: goodHeaders(),
    payload: { segments },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('POST /api/csv-import/preview', () => {
  it('1: an empty translation is skipped', async () => {
    const row = await only('a', 'nl', '   ');
    expect(row.category).toBe('skipped');
    expect(row.reason).toBe('Empty cell. The target stays as it is.');
  });

  it('2: a column for a locale the project does not have is ignored', async () => {
    const res = await preview([
      {
        name: 'review.csv',
        text: csv([['a', 'Nu direct betalen', 'Payer']], ['Unit ID', 'nl', 'fr']),
      },
    ]);
    expect(res.body.files[0]!.columns).toEqual([
      { name: 'Unit ID', recognised: true },
      { name: 'nl', recognised: true },
      { name: 'fr', recognised: false },
    ]);
    expect(res.body.rows.map((r) => r.locale)).toEqual(['nl']);
  });

  it('3: an unknown unit is blocked', async () => {
    const row = await only('nope', 'nl', 'Iets');
    expect(row.category).toBe('blocked');
    expect(row.reason).toBe('No unit "nope" in nl');
    expect(row.rowId).toBeNull();
  });

  it('3: an id that two file groups share is blocked until it names its group', async () => {
    const row = await only('dup', 'nl', 'Iets');
    expect(row.category).toBe('blocked');
    expect(row.reason).toBe('"dup" exists in several files; prefix it with its group');
  });

  it('3: the group/unitId form resolves the unit', async () => {
    const row = await only('checkout/messages/dup', 'nl', 'Kassa dubbel nieuw');
    expect(row.rowId).toBe(rowIdOf('checkout/messages', 'dup'));
    expect(row.category).toBe('changed');
    expect(row.current).toEqual([t('Kassa dubbel')]);
  });

  it('4: copies of the export from several markets each bring their own column', async () => {
    const market = (nl: string, tr: string): string =>
      csv(
        [['a', '', EXPORT, 'Pay now', nl, tr]],
        ['Unit ID', 'Description', 'Export', 'Source', 'nl', 'tr'],
      );
    const res = await preview([
      { name: 'nl.csv', text: market('Nu direct betalen', 'Şimdi öde') },
      { name: 'tr.csv', text: market('Nu betalen', 'Hemen ödeyin') },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows.map((r) => [r.key, r.category, r.reason])).toEqual([
      ['0:2:nl', 'changed', null],
      ['0:2:tr', 'unchanged', null],
      ['1:2:nl', 'unchanged', null],
      ['1:2:tr', 'conflict', null],
    ]);
  });

  it('4: the same edit twice is applied once, the later copy skipped', async () => {
    const res = await preview([
      { name: 'one.csv', text: review([['a', 'nl', 'Nu direct betalen', EXPORT]]) },
      { name: 'two.csv', text: review([['messages/a', 'nl', 'Nu direct betalen', EXPORT]]) },
    ]);
    expect(res.body.rows.map((r) => [r.key, r.category, r.reason])).toEqual([
      ['0:2:nl', 'changed', null],
      ['1:2:nl', 'skipped', 'Same translation as line 2 of one.csv'],
    ]);
  });

  it('4: different edits of one cell are all blocked, in one file or across two', async () => {
    const rows = await rowsOf([
      ['a', 'nl', 'Nu direct betalen'],
      ['a', 'nl', 'Iets anders'],
    ]);
    expect(rows.map((r) => [r.category, r.reason])).toEqual([
      ['blocked', 'Different translation for nl on line 3 of review.csv'],
      ['blocked', 'Different translation for nl on line 2 of review.csv'],
    ]);

    const res = await preview([
      { name: 'one.csv', text: review([['a', 'nl', 'Een', EXPORT]]) },
      { name: 'two.csv', text: review([['messages/a', 'nl', 'Twee', EXPORT]]) },
    ]);
    expect(res.body.rows.map((r) => [r.key, r.reason])).toEqual([
      ['0:2:nl', 'Different translation for nl on line 2 of two.csv'],
      ['1:2:nl', 'Different translation for nl on line 2 of one.csv'],
    ]);
  });

  it('an unchanged row is finalizable only as the current text, once per cell', async () => {
    const rows = await rowsOf([
      ['a', 'nl', 'Nu betalen'],
      // V == E, but Lexi moved on to `Hemen öde`: the reviewer never saw it.
      ['a', 'tr', 'Şimdi öde'],
      ['s', 'nl', 'Wijzigingen opslaan'],
      ['s', 'nl', 'Wijzigingen opslaan'],
    ]);
    const filled = rows.filter((r) => r.category !== 'skipped');
    expect(filled.map((r) => [r.key, r.category, r.finalizable])).toEqual([
      ['0:2:nl', 'unchanged', true],
      ['0:2:tr', 'unchanged', false],
      ['0:3:nl', 'unchanged', true],
      ['0:4:nl', 'unchanged', false],
    ]);
  });

  it('an unchanged copy is not finalizable while another file edits the cell', async () => {
    const res = await preview([
      { name: 'one.csv', text: review([['a', 'nl', 'Nu betalen', EXPORT]]) },
      { name: 'two.csv', text: review([['a', 'nl', 'Nu direct betalen', EXPORT]]) },
    ]);
    expect(res.body.rows.map((r) => [r.category, r.finalizable])).toEqual([
      ['unchanged', false],
      ['changed', false],
    ]);
  });

  it('a pending edit or a final cell is not finalizable', async () => {
    await patch('a', 'nl', [t('Nu betalen')]);
    expect((await only('a', 'nl', 'Nu betalen')).finalizable).toBe(false);
  });

  it('reads a row per locale column, each cell checked on its own', async () => {
    const res = await preview([
      {
        name: 'review.csv',
        text: csv(
          [['a', '', EXPORT, 'Pay now', 'Nu direct betalen', 'Hemen öde']],
          ['Unit ID', 'Description', 'Export', 'Source', 'nl', 'tr'],
        ),
      },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows.map((r) => [r.key, r.locale, r.category])).toEqual([
      ['0:2:nl', 'nl', 'changed'],
      ['0:2:tr', 'tr', 'unchanged'],
    ]);
  });

  it('5: the snapshot named in the Export column is the baseline', async () => {
    const res = await preview([
      { name: 'review.csv', text: review([['a', 'nl', 'Nu direct betalen', EXPORT]]) },
    ]);
    expect(res.body.baseline).toEqual({
      exportId: EXPORT,
      jobId: JOB,
      at: '2026-10-19T10:00:00.000Z',
    });
    const row = res.body.rows[0]!;
    expect(row.exported).toEqual([t('Nu betalen')]);
    expect(row.source).toEqual([t('Pay now')]);
    expect(row.csv).toEqual([t('Nu direct betalen')]);
    expect(row.checks).toEqual({ placeholders: true, sourceUnchanged: true });
    expect(row.warnings).toEqual([]);
  });

  it("5: without an Export column, the job's newest snapshot is the baseline", async () => {
    const res = await preview(
      [
        {
          name: 'review.csv',
          text: csv([['a', 'Şimdi ödeyin']], ['Unit ID', 'tr']),
        },
      ],
      JOB,
    );
    expect(res.body.baseline?.exportId).toBe(EXPORT);
    expect(res.body.rows[0]!.category).toBe('conflict');
  });

  it('5: without any snapshot, a row that differs from the cell is changed, never a conflict', async () => {
    const res = await preview([
      {
        name: 'review.csv',
        text: csv([['a', 'Şimdi ödeyin']], ['Unit ID', 'tr']),
      },
    ]);
    expect(res.body.baseline).toBeNull();
    const row = res.body.rows[0]!;
    expect(row.category).toBe('changed');
    expect(row.exported).toEqual([t('Hemen öde')]);
    expect(row.checks.sourceUnchanged).toBeNull();
  });

  it('6: a translation whose tokens do not parse is blocked with the parser reason', async () => {
    const row = await only('b', 'nl', 'U hebt facturen');
    expect(row.category).toBe('blocked');
    expect(row.reason).toBe('Placeholder {1} is missing');
    expect(row.csv).toBeNull();
    expect(row.csvText).toBe('U hebt facturen');
    expect(row.checks.placeholders).toBe(false);
  });

  it('7: placeholders that parse but differ from the source are blocked', async () => {
    const row = await only('b', 'tr', 'yine faturalar');
    expect(row.category).toBe('blocked');
    expect(row.reason).toBe("Placeholders and markup don't match the source");
    expect(row.checks.placeholders).toBe(false);
  });

  it('8: V == C is unchanged', async () => {
    expect((await only('a', 'nl', 'Nu betalen')).category).toBe('unchanged');
  });

  it('8: V == E while C moved on is unchanged — the reviewer left the row alone', async () => {
    expect((await only('a', 'tr', 'Şimdi öde')).category).toBe('unchanged');
  });

  it('8: C == E and V differs is changed, placeholders and all', async () => {
    const row = await only('b', 'nl', 'Je hebt {1:{{ total }}} rekeningen');
    expect(row.category).toBe('changed');
    expect(row.reason).toBeNull();
    expect(row.csv).toEqual([t('Je hebt '), ph, t(' rekeningen')]);
  });

  it('8: all three differ is a conflict', async () => {
    const row = await only('a', 'tr', 'Şimdi ödeyin');
    expect(row.category).toBe('conflict');
    expect(row.exported).toEqual([t('Şimdi öde')]);
    expect(row.current).toEqual([t('Hemen öde')]);
    expect(row.currentChangedBy).toBeNull();
  });

  it('warns when the source changed since the export', async () => {
    const row = await only('s', 'nl', 'Opslaan');
    expect(row.category).toBe('changed');
    expect(row.checks.sourceUnchanged).toBe(false);
    expect(row.warnings).toEqual(['Source changed since export']);
  });

  it('a pending (unsaved) edit is C', async () => {
    await patch('a', 'nl', [{ k: 't', v: 'Nu meteen betalen' }]);
    expect((await only('a', 'nl', 'Nu meteen betalen')).category).toBe('unchanged');

    const row = await only('a', 'nl', 'Iets heel anders');
    expect(row.category).toBe('conflict');
    expect(row.current).toEqual([t('Nu meteen betalen')]);
    expect(row.currentChangedBy).toBe('unsaved edit');
    expect(row.currentChangedAt).toBe(projects.pendingFor(rowIdOf('messages', 'a'), 'nl')?.at);
  });

  it('takes a body far above the global 1 MiB limit — a real multi-locale export', async () => {
    // Unknown units classify fast and still make every row count.
    const rows = Array.from({ length: 20_000 }, (_, i) => [
      `padding-unit-${i}`,
      'A description long enough to make the file realistic',
      EXPORT,
      'A source text of reasonable length',
      'Een vertaling van redelijke lengte',
    ]);
    const text = csv(rows, ['Unit ID', 'Description', 'Export', 'Source', 'nl']);
    expect(text.length).toBeGreaterThan(2 * 1_048_576);
    const res = await preview([{ name: 'big.csv', text }]);
    expect(res.status).toBe(200);
    expect(res.body.files[0]!.rowCount).toBe(20_000);
  });

  it('ignores a snapshot that is valid JSON of the wrong shape, falling back to E := C', async () => {
    const bad = '22222222-2222-4333-8444-555555555555';
    const malformed: unknown[] = [
      {},
      { version: 1, id: bad, jobId: JOB, at: '2026-10-19T10:00:00.000Z' },
      {
        version: 1,
        id: bad,
        jobId: JOB,
        at: '2026-10-19T10:00:00.000Z',
        rows: [{ group: 'messages', unitId: 'a', segments: null }],
      },
    ];
    for (const content of malformed) {
      await writeFile(
        join(root, '.lexi', 'exports', `${bad}.json`),
        JSON.stringify(content),
        'utf8',
      );
      const res = await preview([
        { name: 'review.csv', text: review([['a', 'tr', 'Şimdi ödeyin', bad]]) },
      ]);
      expect(res.status, JSON.stringify(content)).toBe(200);
      expect(res.body.baseline).toBeNull();
      expect(res.body.rows[0]!.category).toBe('changed');
      expect(res.body.rows[0]!.exported).toEqual([t('Hemen öde')]);
    }
  });

  describe('a cell that was empty at export', () => {
    // The export writes `segments: null` for a rejected, failed or untranslated
    // unit, and the row goes out with an empty Translation. That emptiness IS
    // the baseline: it must not fall back to E := C.
    const EMPTY = '33333333-2222-4333-8444-555555555555';

    beforeEach(async () => {
      await writeExportSnapshot(
        cfg,
        root,
        snapshot(EMPTY, '2026-10-18T10:00:00.000Z', [
          { group: 'messages', unitId: 'a', locale: 'nl', source: [t('Pay now')], segments: null },
          {
            group: 'messages',
            unitId: 'b',
            locale: 'nl',
            source: [t('You have '), ph, t(' invoices')],
            segments: [],
          },
          {
            group: 'messages',
            unitId: 's',
            locale: 'tr',
            source: [t('Save changes')],
            segments: null,
          },
        ]),
      );
    });

    const emptyRow = async (id: string, locale: string, v: string): Promise<CsvImportRow> => {
      const res = await preview([{ name: 'review.csv', text: review([[id, locale, v, EMPTY]]) }]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.rows[0]!;
    };

    it('translated in Lexi since and filled in the CSV is a conflict', async () => {
      const row = await emptyRow('a', 'nl', 'Betaal nu');
      expect(row.category).toBe('conflict');
      expect(row.exported).toEqual([]);
      expect(row.current).toEqual([t('Nu betalen')]);
      expect(row.checks.sourceUnchanged).toBe(true);
    });

    it('still empty in Lexi and filled in the CSV is changed', async () => {
      const row = await emptyRow('s', 'tr', 'Değişiklikleri kaydet');
      expect(row.category).toBe('changed');
      expect(row.exported).toEqual([]);
      expect(row.current).toBeNull();
      expect(row.checks.sourceUnchanged).toBe(true);
    });

    it('parses tokens past an empty export, and V == C is still unchanged', async () => {
      const row = await emptyRow('b', 'nl', 'Je hebt {1:{{ count }}} rekeningen');
      expect(row.category).toBe('conflict');
      expect(row.csv).toEqual([t('Je hebt '), ph, t(' rekeningen')]);
      expect(row.exported).toEqual([]);

      expect((await emptyRow('a', 'nl', 'Nu betalen')).category).toBe('unchanged');
    });
  });

  it('rejects a file without a required column with 400', async () => {
    const res = await preview([
      { name: 'review.csv', text: csv([['a', 'nl', 'Hoi']], ['Unit ID', 'Locale', 'Translation']) },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe(
      'The file needs a Unit ID column and a column per locale (e.g. de-DE).',
    );
  });
});

/* ---- Apply and Undo (Task 10) -------------------------------------------- */

const A = rowIdOf('messages', 'a');
const S = rowIdOf('messages', 's');

const xliffOf = (locale: string): Promise<string> =>
  readFile(join(root, `messages.${locale}.xlf`), 'utf8');

const stateOf = (rowId: string, locale: string): string | undefined =>
  projects.index?.byRowId.get(rowId)?.cells.get(locale)?.state;

interface FinalFile {
  groups: Record<string, Record<string, Record<string, { importId: string }>>>;
}

async function finalFile(): Promise<FinalFile | null> {
  const raw = await readFile(join(root, '.lexi', 'final.json'), 'utf8').catch(() => null);
  return raw === null ? null : (JSON.parse(raw) as FinalFile);
}

/**
 * Preview, then apply the named rows the way the dialog does: each with the
 * cell's token text as the preview saw it. `before` runs in between, so a test
 * can change the cell under the preview.
 */
async function apply(
  rows: [id: string, locale: string, translation: string][],
  opts: {
    state?: 'needsReview' | 'reviewed' | 'final';
    /** Null is an import started from the Grid rather than a job's Run Log. */
    jobId?: string | null;
    before?: () => Promise<void>;
    finalizeUnchanged?: boolean;
    include?: (preview: CsvImportRow[]) => { key: string; current: string }[];
  } = {},
): Promise<{ status: number; body: CsvImportApplyResponse & { error?: { message: string } } }> {
  const files = [
    { name: 'review.csv', text: review(rows.map(([id, loc, v]) => [id, loc, v, EXPORT])) },
  ];
  const jobId = opts.jobId === undefined ? JOB : opts.jobId;
  const seen = await preview(files, jobId);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  const include =
    opts.include?.(seen.body.rows) ??
    seen.body.rows.map((r) => ({
      key: r.key,
      current: r.current === null ? '' : tokenText(r.current),
    }));
  await opts.before?.();
  const res = await app.inject({
    method: 'POST',
    url: '/api/csv-import/apply',
    headers: goodHeaders(),
    payload: {
      files,
      jobId,
      state: opts.state ?? 'final',
      finalizeUnchanged: opts.finalizeUnchanged ?? false,
      include,
    },
  });
  return { status: res.statusCode, body: res.json() };
}

async function undo(
  id: string,
): Promise<{ status: number; body: CsvImportUndoResponse & { error?: { message: string } } }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/csv-import/${id}/undo`,
    headers: goodHeaders(),
  });
  return { status: res.statusCode, body: res.json() };
}

describe('POST /api/csv-import/apply', () => {
  it('1: writes final into files without state attributes as markers, and the cells read final', async () => {
    const res = await apply([
      ['a', 'nl', 'Nu direct betalen'], // changed
      ['a', 'tr', 'Şimdi ödeyin'], // conflict
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.written).toEqual([
      { path: 'messages.nl.xlf', count: 1 },
      { path: 'messages.tr.xlf', count: 1 },
    ]);

    const nl = await xliffOf('nl');
    const tr = await xliffOf('tr');
    expect(nl).toContain('<target>Nu direct betalen</target>');
    expect(tr).toContain('<target>Şimdi ödeyin</target>');
    expect(nl).not.toContain('state=');
    expect(tr).not.toContain('state=');
    // Nothing else in the file moved.
    expect(nl).toContain('<target>Wijzigingen opslaan</target>');

    expect(stateOf(A, 'nl')).toBe('final');
    expect(stateOf(A, 'tr')).toBe('final');
    const markers = (await finalFile())?.groups.messages?.a;
    expect(Object.keys(markers ?? {}).sort()).toEqual(['nl', 'tr']);
    expect(markers?.nl?.importId).toBe(res.body.importId);
    expect(projects.unsavedCount).toBe(0);

    // The marker's hash is of the bytes on disk, so a reopened project agrees.
    await openProject();
    expect(stateOf(A, 'nl')).toBe('final');
    expect(stateOf(A, 'tr')).toBe('final');
  });

  it('2: writes state="final" into a file that uses state, with no marker', async () => {
    const res = await apply([['a', 'de', 'Jetzt bezahlen']]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const de = await xliffOf('de');
    expect(de).toContain('<target state="final">Jetzt bezahlen</target>');
    expect(de).toContain('<target state="translated">Sie haben');
    expect(stateOf(A, 'de')).toBe('final');
    expect((await finalFile())?.groups.messages?.a?.de).toBeUndefined();

    await openProject();
    expect(stateOf(A, 'de')).toBe('final');
  });

  it('creates the unit in a locale file that does not have it yet', async () => {
    const res = await apply([['s', 'tr', 'Değişiklikleri kaydet']]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tr = await xliffOf('tr');
    expect(tr).toMatch(/<trans-unit id="s"[^]*<target[^>]*>Değişiklikleri kaydet<\/target>/);
    expect(stateOf(S, 'tr')).toBe('final');

    await openProject();
    expect(stateOf(S, 'tr')).toBe('final');
  });

  it('3: saves only the imported cells — other pending edits stay pending', async () => {
    await patch('s', 'nl', [t('Opslaan, nog niet bewaard')]);
    await patch('a', 'nl', [t('Nu meteen betalen')]);
    const res = await apply([['a', 'nl', 'Nu direct betalen']]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(projects.pendingFor(A, 'nl')).toBeUndefined();
    expect(projects.pendingFor(S, 'nl')?.segments).toBeDefined();
    expect(projects.unsavedCount).toBe(1);
    const nl = await xliffOf('nl');
    expect(nl).toContain('<target>Nu direct betalen</target>');
    expect(nl).toContain('<target>Wijzigingen opslaan</target>');
    expect(nl).not.toContain('nog niet bewaard');
  });

  it('4: a cell edited between preview and apply is a 409, and nothing is written', async () => {
    const before = await xliffOf('nl');
    const res = await apply(
      [
        ['a', 'nl', 'Nu direct betalen'],
        ['s', 'nl', 'Opslaan'],
      ],
      { before: () => patch('a', 'nl', [t('Tussendoor bewerkt')]) },
    );
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toBe(
      'Row review.csv:2 changed since the preview. Choose the file again.',
    );
    expect(await xliffOf('nl')).toBe(before);
    // Only the edit made in between is pending; `s` never reached the overlay.
    expect(projects.unsavedCount).toBe(1);
    expect(projects.pendingFor(S, 'nl')).toBeUndefined();
    expect(await readdir(join(root, '.lexi', 'imports')).catch(() => [])).toEqual([]);
  });

  it('a file changed on disk under the save is a 409, and the overlay is put back', async () => {
    await patch('a', 'nl', [t('Nu meteen betalen')]);
    const pending = projects.pendingFor(A, 'nl');
    const changed = (await xliffOf('nl')).replace('Dubbel', 'Dubbel (extern)');
    const res = await apply([['a', 'nl', 'Nu direct betalen']], {
      before: () => writeFile(join(root, 'messages.nl.xlf'), changed, 'utf8'),
    });
    expect(res.status).toBe(409);
    expect(await xliffOf('nl')).toBe(changed);
    expect(projects.pendingFor(A, 'nl')).toBe(pending);
    expect(projects.unsavedCount).toBe(1);
    expect(await readdir(join(root, '.lexi', 'imports')).catch(() => [])).toEqual([]);
  });

  it('a stale second file refuses the whole save: nothing is written, everything rolls back', async () => {
    const nl = await xliffOf('nl');
    const tr = (await xliffOf('tr')).replace('faturanız', 'faturalarınız');
    const res = await apply(
      [
        ['a', 'nl', 'Nu direct betalen'],
        ['a', 'tr', 'Şimdi ödeyin'],
      ],
      { before: () => writeFile(join(root, 'messages.tr.xlf'), tr, 'utf8') },
    );
    expect(res.status).toBe(409);
    expect(await xliffOf('nl')).toBe(nl);
    expect(await xliffOf('tr')).toBe(tr);
    expect(projects.unsavedCount).toBe(0);
    expect(stateOf(A, 'nl')).toBe('reviewed');
    expect(await readdir(join(root, '.lexi', 'imports')).catch(() => [])).toEqual([]);
  });

  it("an I/O failure on the second file keeps the first file's cells, recorded and undoable", async () => {
    const DUP = rowIdOf('checkout/messages', 'dup');
    const checkoutFile = join(root, 'checkout', 'messages.nl.xlf');
    const checkout = await readFile(checkoutFile, 'utf8');
    const nl = await xliffOf('nl');
    let res;
    try {
      res = await apply(
        [
          ['a', 'nl', 'Nu direct betalen'],
          ['checkout/messages/dup', 'nl', 'Kassa dubbel nieuw'],
        ],
        // The atomic write's temporary file cannot be created in a read-only folder.
        { before: () => chmod(join(root, 'checkout'), 0o555) },
      );
    } finally {
      await chmod(join(root, 'checkout'), 0o755);
    }
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const details = (
      res.body as unknown as { error: { details: { importId: string; notWritten: string[] } } }
    ).error.details;
    expect(details.notWritten).toEqual(['checkout/messages.nl.xlf']);

    // The first file landed, and the session agrees with it.
    expect(await xliffOf('nl')).toContain('<target>Nu direct betalen</target>');
    expect(projects.index?.byRowId.get(A)?.cells.get('nl')?.unit?.targetPlain).toBe(
      'Nu direct betalen',
    );
    expect(stateOf(A, 'nl')).toBe('final');
    expect(projects.pendingFor(A, 'nl')).toBeUndefined();
    // The second did not, and its cell is back to what it was.
    expect(await readFile(checkoutFile, 'utf8')).toBe(checkout);
    expect(projects.pendingFor(DUP, 'nl')).toBeUndefined();
    expect(projects.unsavedCount).toBe(0);

    const undone = await undo(details.importId);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toEqual({ restored: 1, skipped: [] });
    expect(await xliffOf('nl')).toBe(nl);
  });

  it('5: a blocked row in include is a 409, and nothing is written', async () => {
    const before = await xliffOf('nl');
    const res = await apply([
      ['a', 'nl', 'Nu direct betalen'],
      ['b', 'nl', 'U hebt facturen'], // blocked: placeholder missing
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toBe(
      'Row review.csv:3 changed since the preview. Choose the file again.',
    );
    expect(await xliffOf('nl')).toBe(before);
    expect(projects.unsavedCount).toBe(0);
  });

  it('writes an edit two copies agree on once; the skipped copy is refused', async () => {
    const twice: [string, string, string][] = [
      ['a', 'nl', 'Nu direct betalen'],
      ['a', 'nl', 'Nu direct betalen'],
    ];
    const both = await apply(twice);
    expect(both.status).toBe(409);
    expect(both.body.error?.message).toBe(
      'Row review.csv:3 changed since the preview. Choose the file again.',
    );

    const res = await apply(twice, {
      include: (rows) =>
        rows
          .filter((r) => r.category === 'changed')
          .map((r) => ({ key: r.key, current: tokenText(r.current!) })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await xliffOf('nl')).toContain('Nu direct betalen');
  });
});

describe('POST /api/csv-import/apply with finalizeUnchanged', () => {
  it('marks the confirmed unchanged cells final, text untouched, and Undo puts the state back', async () => {
    const before = stateOf(S, 'nl');
    expect(before).not.toBe('final');
    const res = await apply(
      [
        ['a', 'nl', 'Nu direct betalen'],
        ['s', 'nl', 'Wijzigingen opslaan'],
      ],
      {
        state: 'reviewed',
        finalizeUnchanged: true,
        include: (rows) =>
          rows
            .filter((r) => r.category === 'changed')
            .map((r) => ({ key: r.key, current: tokenText(r.current!) })),
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.written).toEqual([{ path: 'messages.nl.xlf', count: 2 }]);
    expect(stateOf(A, 'nl')).toBe('reviewed');
    expect(stateOf(S, 'nl')).toBe('final');
    expect(await xliffOf('nl')).toContain('<target>Wijzigingen opslaan</target>');

    await openProject();
    expect(stateOf(S, 'nl')).toBe('final');

    const undone = await undo(res.body.importId);
    expect(undone.body).toEqual({ restored: 2, skipped: [] });
    expect(stateOf(S, 'nl')).toBe(before);
  });

  it('applies with nothing included but cells to finalize; with neither it is a 400', async () => {
    const rows: [string, string, string][] = [['s', 'nl', 'Wijzigingen opslaan']];
    const res = await apply(rows, { finalizeUnchanged: true, include: () => [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(stateOf(S, 'nl')).toBe('final');

    const nothing = await apply(rows, { finalizeUnchanged: true, include: () => [] });
    expect(nothing.status).toBe(400);
    expect(nothing.body.error?.message).toBe('Nothing to import.');
  });
});

describe('POST /api/csv-import/:id/undo', () => {
  it('6: restores targets and states; a cell edited since is skipped; twice is a 409', async () => {
    const nlBefore = await xliffOf('nl');
    const stateBefore = stateOf(A, 'nl');
    const deBefore = await xliffOf('de');
    const res = await apply([
      ['a', 'nl', 'Nu direct betalen'],
      ['a', 'de', 'Jetzt bezahlen'],
      ['a', 'tr', 'Şimdi ödeyin'],
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Edited after the import: undo must leave it alone.
    await patch('a', 'tr', [t('Hemen şimdi öde')]);

    const undone = await undo(res.body.importId);
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toEqual({ restored: 2, skipped: [{ rowId: A, locale: 'tr' }] });

    expect(await xliffOf('nl')).toBe(nlBefore);
    expect(await xliffOf('de')).toBe(deBefore);
    expect(stateOf(A, 'nl')).toBe(stateBefore);
    expect(stateOf(A, 'de')).toBe('reviewed');
    expect(await xliffOf('tr')).toContain('<target>Şimdi ödeyin</target>');
    expect(projects.pendingFor(A, 'tr')).toBeDefined();
    const markers = (await finalFile())?.groups.messages?.a ?? {};
    expect(Object.keys(markers)).toEqual(['tr']);

    const again = await undo(res.body.importId);
    expect(again.status).toBe(409);
  });

  it('puts back a machine-draft marker when the restored bytes are the draft', async () => {
    projects.setMachineOrigin(A, 'nl', {
      at: new Date().toISOString(),
      model: 'test-model',
      style: 'raw',
      hash: targetHash('Nu betalen'),
      previous: null,
    });
    projects.rebuildIndex();
    expect(stateOf(A, 'nl')).toBe('draftMachine');

    const res = await apply([['a', 'nl', 'Nu direct betalen']]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(projects.machineOrigins.size).toBe(0);
    expect(stateOf(A, 'nl')).toBe('final');

    expect((await undo(res.body.importId)).status).toBe(200);
    expect(stateOf(A, 'nl')).toBe('draftMachine');
    expect(projects.machineOrigins.size).toBe(1);
  });

  it("puts back an earlier import's final, also after reopen", async () => {
    const first = await apply([['a', 'nl', 'Nu direct betalen']]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await apply([['a', 'nl', 'Nu anders betalen']], { state: 'reviewed' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(stateOf(A, 'nl')).toBe('reviewed');

    expect((await undo(second.body.importId)).status).toBe(200);
    expect(await xliffOf('nl')).toContain('<target>Nu direct betalen</target>');
    expect(stateOf(A, 'nl')).toBe('final');
    expect((await finalFile())?.groups.messages?.a?.nl?.importId).toBe(first.body.importId);

    await openProject();
    expect(stateOf(A, 'nl')).toBe('final');
  });

  it('answers an id that is not an import id with 404', async () => {
    expect((await undo('..%2Fstate')).status).toBe(404);
    expect((await undo('11111111-2222-4333-8444-000000000000')).status).toBe(404);
  });
});

describe('GET /api/jobs/:id/imports', () => {
  it('7: lists the import with its cell count', async () => {
    const res = await apply([
      ['a', 'nl', 'Nu direct betalen'],
      ['a', 'tr', 'Şimdi ödeyin'],
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB}/imports`,
      headers: goodHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<JobImportsResponse>()).toEqual({
      imports: [
        { importId: res.body.importId, at: res.body.at, jobId: JOB, count: 2, undone: false },
      ],
    });
  });

  it('lists an import started from the Grid (no job) under the job its Export column names', async () => {
    const res = await apply([['a', 'nl', 'Nu direct betalen']], { jobId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: `/api/jobs/${JOB}/imports`,
      headers: goodHeaders(),
    });
    expect(list.json<JobImportsResponse>().imports).toEqual([
      { importId: res.body.importId, at: res.body.at, jobId: JOB, count: 1, undone: false },
    ]);
  });
});
