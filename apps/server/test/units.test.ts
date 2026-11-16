// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  type Project,
  type UnitDetail,
  type UnitRowsResponse,
  type UnitsQueryRequest,
  type UnitsQueryResponse,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * The grid's server half (M5): `POST /api/units/query`, `POST /api/units/rows`,
 * `GET /api/units/:rowId`.
 *
 * The fixture is built to make the hard cases reachable rather than to look
 * realistic: the same unit id in two file groups (FR-1.4), a unit missing from
 * one locale entirely and an orphan present in only one (FR-2.2's last two
 * counters), a placeholder mismatch that must show as a validation error, an
 * ICU unit, and units with and without notes.
 */

const xlf = (targetLanguage: string | null, units: string): string => {
  const attr = targetLanguage === null ? '' : ` target-language="${targetLanguage}"`;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template"${attr}>
    <body>
${units}
    </body>
  </file>
</xliff>
`;
};

interface UnitSpec {
  id: string;
  source: string;
  target?: string | undefined;
  note?: string | undefined;
  loc?: [string, number] | undefined;
}

const unit = (u: UnitSpec): string =>
  `      <trans-unit id="${u.id}" datatype="html">
        <source>${u.source}</source>${
          u.target === undefined ? '' : `\n        <target state="translated">${u.target}</target>`
        }${
          u.loc === undefined
            ? ''
            : `\n        <context-group purpose="location">\n          <context context-type="sourcefile">${u.loc[0]}</context>\n          <context context-type="linenumber">${u.loc[1]}</context>\n        </context-group>`
        }${
          u.note === undefined
            ? ''
            : `\n        <note priority="1" from="description">${u.note}</note>`
        }
      </trans-unit>`;

const INTERP = '<x id="INTERPOLATION" equiv-text="{{ count }}"/>';

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-units-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(join(root, 'checkout'), { recursive: true });

  const sourceUnits = [
    unit({
      id: 'pay',
      source: 'Pay now',
      note: 'Primary button on the checkout summary.',
      loc: ['src/app/checkout/summary.component.html', 17],
    }),
    unit({ id: 'billing', source: 'Billing' }), // no note — feeds the noNote filter
    unit({ id: 'invoices', source: `You have ${INTERP} invoices`, note: 'Billing summary line.' }),
    unit({ id: 'basket', source: '{VAR_PLURAL, plural, one {1 item} other {# items}}', note: 'n' }),
    unit({ id: 'onlyInSource', source: 'Never translated anywhere', note: 'n' }),
  ].join('\n');

  await writeFile(join(root, 'messages.xlf'), xlf('en-GB', sourceUnits), 'utf8');

  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf(
      'de',
      [
        unit({ id: 'pay', source: 'Pay now', target: 'Jetzt bezahlen' }),
        unit({ id: 'billing', source: 'Billing', target: 'Abrechnung' }),
        // Placeholder dropped: a hard error (FR-PH-2), not a warning.
        unit({
          id: 'invoices',
          source: `You have ${INTERP} invoices`,
          target: 'Sie haben Rechnungen',
        }),
        unit({
          id: 'basket',
          source: '{VAR_PLURAL, plural, one {1 item} other {# items}}',
          target: '{VAR_PLURAL, plural, one {1 Artikel} other {# Artikel}}',
        }),
        unit({ id: 'onlyInSource', source: 'Never translated anywhere' }),
        // Present here, gone from the source: an orphan (FR-2.2).
        unit({ id: 'ghost', source: 'Removed string', target: 'Entfernte Zeichenkette' }),
      ].join('\n'),
    ),
    'utf8',
  );

  // `billing` is absent from this file altogether — the "missing entirely" counter.
  await writeFile(
    join(root, 'messages.fr.xlf'),
    xlf(
      'fr',
      [
        unit({ id: 'pay', source: 'Pay now', target: 'Payer maintenant' }),
        unit({
          id: 'invoices',
          source: `You have ${INTERP} invoices`,
          target: `Vous avez ${INTERP} factures`,
        }),
        unit({ id: 'basket', source: '{VAR_PLURAL, plural, one {1 item} other {# items}}' }),
        unit({ id: 'onlyInSource', source: 'Never translated anywhere' }),
      ].join('\n'),
    ),
    'utf8',
  );

  // FR-1.4: a SECOND group reusing the id `pay`. The row key must keep them apart.
  await writeFile(
    join(root, 'checkout', 'messages.xlf'),
    xlf('en-GB', unit({ id: 'pay', source: 'Checkout: pay', note: 'n' })),
    'utf8',
  );
  await writeFile(
    join(root, 'checkout', 'messages.de.xlf'),
    xlf('de', unit({ id: 'pay', source: 'Checkout: pay', target: 'Kasse: bezahlen' })),
    'utf8',
  );
});

afterAll(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
  await open();
});

afterAll(async () => {
  await app?.close();
});

/** Scan + open, exactly as the wizard does it. */
async function open(): Promise<Project> {
  const scan = await app.inject({
    method: 'POST',
    url: '/api/projects/scan',
    headers: goodHeaders(),
    payload: { path: root },
  });
  const files = scan.json<{
    files: Array<{ path: string; fileIndex: number; locale: string | null }>;
  }>().files;
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: 'en-GB',
      mapping: files
        .filter((f) => f.locale !== null)
        .map((f) => ({
          path: f.path,
          fileIndex: f.fileIndex,
          locale: f.locale,
          fixTargetLanguage: false,
        })),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<Project>();
}

const query = async (body: Partial<UnitsQueryRequest> = {}): Promise<UnitsQueryResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/units/query',
    headers: goodHeaders(),
    // Every filter question is asked of both target locales unless stated.
    payload: { locales: ['de', 'fr'], ...body },
  });
  expect(res.statusCode).toBe(200);
  return res.json<UnitsQueryResponse>();
};

describe('POST /api/units/query', () => {
  it('returns every row id in display order, plus the totals', async () => {
    const q = await query();
    expect(q.total).toBe(q.ids.length);
    // 5 source units + 1 orphan in `messages`, 1 in `checkout`.
    expect(q.total).toBe(7);
    expect(q.scopeTotal).toBe(7);
    // Groups sorted, source order preserved inside each.
    expect(q.ids[0]).toBe(rowIdOf('checkout/messages', 'pay'));
    expect(q.ids.slice(1, 3)).toEqual([rowIdOf('messages', 'pay'), rowIdOf('messages', 'billing')]);
  });

  it('keeps the same unit id in two groups as two rows (FR-1.4)', async () => {
    const q = await query();
    const pays = q.ids.filter((id) => id.endsWith('pay'));
    expect(pays).toHaveLength(2);
    expect(new Set(pays).size).toBe(2);
  });

  it('puts the orphan last within its group, never mid-list', async () => {
    const q = await query();
    expect(q.ids.at(-1)).toBe(rowIdOf('messages', 'ghost'));
  });

  it('counts every facet in the same response — one round trip, never N', async () => {
    const q = await query();
    // de is missing `onlyInSource`; fr is missing `billing` and `basket` too.
    expect(q.facets.untranslated).toBeGreaterThan(0);
    expect(q.facets.hasErrors).toBe(1); // only `invoices`, and only in de
    // `billing`, plus the orphan `ghost` — which has no note either, and is
    // exactly the kind of row FR-4.4's note-coverage metric should surface.
    expect(q.facets.noNote).toBe(2);
    expect(q.facets.icuOnly).toBe(1); // only `basket`
    // M9 gave `machineDrafts` a data source (`.lexi/state.json`), so it is now
    // a real count rather than an absent one — and zero here is the truth:
    // nothing in this fixture was written by a model.
    expect(q.facets.machineDrafts).toBe(0);
  });

  it('holds facet counts steady when a filter is ticked', async () => {
    // The point of excluding the checkboxes from the facet scope: the number
    // must not collapse under the cursor that just clicked it.
    const before = await query();
    const after = await query({ filters: ['hasErrors'] });
    expect(after.facets).toEqual(before.facets);
    expect(after.total).toBe(1);
  });

  it('combines filters with AND (FR-3.4)', async () => {
    const both = await query({ filters: ['untranslated', 'icuOnly'] });
    const untranslated = await query({ filters: ['untranslated'] });
    expect(both.total).toBeLessThan(untranslated.total);
    // `basket` is the only ICU unit, and fr leaves it untranslated.
    expect(both.ids).toEqual([rowIdOf('messages', 'basket')]);
  });

  it('answers "untranslated" per locale, not project-wide', async () => {
    // `billing` is translated in de and absent from fr entirely.
    const de = await query({ locales: ['de'], filters: ['untranslated'] });
    const fr = await query({ locales: ['fr'], filters: ['untranslated'] });
    expect(de.ids).not.toContain(rowIdOf('messages', 'billing'));
    expect(fr.ids).toContain(rowIdOf('messages', 'billing'));
  });

  it('searches each scope separately', async () => {
    expect((await query({ search: 'billing', scope: 'key' })).total).toBe(1);
    // "Billing summary line." is a note on `invoices`, not on `billing`.
    expect((await query({ search: 'billing summary', scope: 'notes' })).ids).toEqual([
      rowIdOf('messages', 'invoices'),
    ]);
    expect((await query({ search: 'jetzt', scope: 'target' })).ids).toEqual([
      rowIdOf('messages', 'pay'),
    ]);
    expect((await query({ search: 'jetzt', scope: 'source' })).total).toBe(0);
  });

  it('searches case-insensitively, which is what the lowercase haystacks are for', async () => {
    expect((await query({ search: 'PAY NOW' })).total).toBeGreaterThan(0);
  });

  it('scopes to a file group without zeroing the other groups’ counts', async () => {
    const q = await query({ groups: ['checkout/messages'] });
    expect(q.total).toBe(1);
    expect(q.scopeTotal).toBe(1);
    // The rail still needs to show what the unselected groups hold.
    expect(q.groupCounts['messages']).toBe(6);
  });

  it('404s when no project is open', async () => {
    await app.close();
    app = await buildApp(testConfig({ roots: [root], stateDir }), {
      logger: false,
      projects: new ProjectService(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('rejects a filter outside the vocabulary', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: { filters: ['drop table'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/units/rows', () => {
  const rows = async (ids: string[], locales = ['de', 'fr']): Promise<UnitRowsResponse> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/rows',
      headers: goodHeaders(),
      payload: { ids, locales },
    });
    expect(res.statusCode).toBe(200);
    return res.json<UnitRowsResponse>();
  };

  it('delivers cells pre-segmented, so the grid never parses at render time', async () => {
    const { rows: got } = await rows([rowIdOf('messages', 'invoices')]);
    const row = got[0]!;
    expect(row.source).toEqual([
      { k: 't', v: 'You have ' },
      { k: 'p', id: 'INTERPOLATION', equivText: '{{ count }}' },
      { k: 't', v: ' invoices' },
    ]);
    expect(row.cells['fr']?.segments.some((s) => s.k === 'p')).toBe(true);
  });

  it('never sends the original bytes of a placeholder', async () => {
    const { rows: got } = await rows([rowIdOf('messages', 'invoices')]);
    const serialised = JSON.stringify(got);
    // `raw` and `span` are how round-trip fidelity would leak out of the server.
    expect(serialised).not.toContain('"raw"');
    expect(serialised).not.toContain('"span"');
    expect(serialised).not.toContain('<x id=');
  });

  it('flags a placeholder mismatch as an error on the cell (FR-PH-2)', async () => {
    const { rows: got } = await rows([rowIdOf('messages', 'invoices')]);
    expect(got[0]?.cells['de']?.error).toBe(true);
    expect(got[0]?.cells['fr']?.error).toBe(false);
  });

  it('marks a unit absent from a locale file as missing, not merely empty', async () => {
    const { rows: got } = await rows([rowIdOf('messages', 'billing')]);
    expect(got[0]?.cells['fr']).toMatchObject({ missing: true, state: 'untranslated' });
    expect(got[0]?.cells['de']).toMatchObject({ missing: false, state: 'reviewed' });
  });

  it('reports a developer-assigned id apart from a content hash (FR-2.5b)', async () => {
    const { rows: got } = await rows([rowIdOf('messages', 'pay')]);
    expect(got[0]?.customId).toBe(true);
  });

  it('skips an id it no longer knows rather than failing the whole window', async () => {
    const { rows: got } = await rows([rowIdOf('messages', 'pay'), rowIdOf('messages', 'gone')]);
    expect(got).toHaveLength(1);
  });

  it('clips long text runs, because the row is one ellipsised line', async () => {
    // Guarded here rather than in the client: a megabyte of invisible text per
    // screenful is a server decision, and GRID_TEXT_LIMIT lives in shared.
    const { rows: got } = await rows([rowIdOf('messages', 'pay')]);
    for (const seg of got[0]?.source ?? []) {
      if (seg.k === 't') expect(seg.v.length).toBeLessThanOrEqual(140);
    }
  });
});

describe('GET /api/units/:rowId', () => {
  const detail = async (rowId: string): Promise<UnitDetail> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(200);
    return res.json<UnitDetail>();
  };

  it('carries the notes, the locations and every target', async () => {
    const d = await detail(rowIdOf('messages', 'pay'));
    expect(d.unitId).toBe('pay');
    expect(d.group).toBe('messages');
    expect(d.notes).toEqual([
      { from: 'description', priority: '1', text: 'Primary button on the checkout summary.' },
    ]);
    expect(d.locations).toEqual([
      { sourcefile: 'src/app/checkout/summary.component.html', linenumber: '17' },
    ]);
    expect(d.targets.map((t) => t.locale)).toEqual(['de', 'fr']);
  });

  it('lists the placeholders the target is missing (FR-3.8)', async () => {
    const d = await detail(rowIdOf('messages', 'invoices'));
    const de = d.targets.find((t) => t.locale === 'de')!;
    const fr = d.targets.find((t) => t.locale === 'fr')!;
    expect(de.missingPlaceholders).toEqual(['INTERPOLATION']);
    expect(fr.missingPlaceholders).toEqual([]);
  });

  it('returns the full findings, not just the count the grid needed', async () => {
    const d = await detail(rowIdOf('messages', 'invoices'));
    const de = d.targets.find((t) => t.locale === 'de')!;
    expect(
      de.findings.some((f) => f.rule === 'placeholder.mismatch' && f.severity === 'error'),
    ).toBe(true);
  });

  it('does not clip the detail panel’s text', async () => {
    const d = await detail(rowIdOf('messages', 'invoices'));
    expect(d.source.every((s) => s.k !== 't' || s.clipped === undefined)).toBe(true);
  });

  it('marks the RTL flag per target locale (FR-3.10)', async () => {
    const d = await detail(rowIdOf('messages', 'pay'));
    expect(d.targets.every((t) => t.isRtl === false)).toBe(true);
  });

  it('shows the visible columns, not every locale in the project', async () => {
    // On a twenty-locale project the alternative is a panel twenty sections
    // long, nineteen of them answering a question nobody asked.
    await app.inject({
      method: 'PATCH',
      url: '/api/project',
      headers: goodHeaders(),
      payload: { visibleLocales: ['fr'] },
    });
    const d = await detail(rowIdOf('messages', 'pay'));
    expect(d.targets.map((t) => t.locale)).toEqual(['fr']);
  });

  it('still lets a caller ask for specific locales', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'pay'))}?locales=de,fr`,
      headers: goodHeaders(),
    });
    expect(res.json<UnitDetail>().targets.map((t) => t.locale)).toEqual(['de', 'fr']);
  });

  it('404s for an unknown row id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'nope'))}`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('resolves the right one of two units sharing an id (FR-1.4)', async () => {
    const a = await detail(rowIdOf('messages', 'pay'));
    const b = await detail(rowIdOf('checkout/messages', 'pay'));
    expect(a.source).not.toEqual(b.source);
    expect(b.targets.find((t) => t.locale === 'de')?.segments).toEqual([
      { k: 't', v: 'Kasse: bezahlen' },
    ]);
  });
});

describe('orphan validation', () => {
  it('validates an orphan against its own <source>, not against nothing', async () => {
    // Every <trans-unit> carries its own <source> — Angular writes the source
    // text into each translation file — so an orphan is comparable, and the
    // checks that matter most for it (ICU structure, CLDR plural coverage) do
    // not depend on the source file at all. Skipping orphans silently disarmed
    // FR-PH-5 on the corpus's Polish ICU unit.
    const d = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'ghost'))}?locales=de`,
      headers: goodHeaders(),
    });
    expect(d.statusCode).toBe(200);
    const target = d.json<UnitDetail>().targets.find((t) => t.locale === 'de');
    expect(target?.missing).toBe(false);
    // A clean orphan produces no findings, but it was REACHED: the source is
    // its own, so `missingPlaceholders` is computed against it rather than
    // against an empty list.
    expect(target?.segments).not.toEqual([]);
  });

  it('agrees with the grid cell about whether a row has an error', async () => {
    // The panel contradicting the cell the user just clicked is the worst
    // possible way for these two call sites to drift.
    const q = await query({ filters: ['hasErrors'] });
    for (const rowId of q.ids) {
      const d = await app.inject({
        method: 'GET',
        url: `/api/units/${encodeURIComponent(rowId)}`,
        headers: goodHeaders(),
      });
      const detail = d.json<UnitDetail>();
      const anyError = detail.targets.some((t) => t.findings.some((f) => f.severity === 'error'));
      expect(anyError).toBe(true);
    }
  });
});

describe('the stale-source filter', () => {
  it('finds nothing on a project that has not changed', async () => {
    expect((await query({ filters: ['stale'] })).total).toBe(0);
  });

  it('flags a unit whose English changed since the last open', async () => {
    // What a re-extraction after an English copy edit looks like from here.
    // The id survives because it is a @@customId; with a hash id the unit would
    // be a new row and an orphan instead, which is FR-2.5's problem, not this
    // filter's.
    const file = join(root, 'messages.xlf');
    const before = await readFile(file, 'utf8');
    await writeFile(
      file,
      before.replace('<source>Billing</source>', '<source>Billing &amp; plans</source>'),
      'utf8',
    );

    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
    await open();

    const stale = await query({ filters: ['stale'] });
    expect(stale.ids).toEqual([rowIdOf('messages', 'billing')]);

    await writeFile(file, before, 'utf8');
  });
});

describe('the persisted grid view (FR-3.2)', () => {
  const patch = (body: { visibleLocales?: string[]; filters?: string[] }) =>
    app.inject({ method: 'PATCH', url: '/api/project', headers: goodHeaders(), payload: body });

  it('restores the visible columns and the filters on reopen', async () => {
    await patch({ visibleLocales: ['fr'], filters: ['untranslated'] });

    // A fresh service, as though the app had been restarted.
    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
    const reopened = await open();

    expect(reopened.visibleLocales).toEqual(['fr']);
    expect(reopened.filters).toEqual(['untranslated']);
  });

  it('drops a persisted column naming a locale this project no longer has', async () => {
    // `.lexi/project.json` is committed, so a teammate's copy can name locales
    // that are not here. An unknown column would render as an empty, permanent
    // grid column that nothing can remove.
    await patch({ visibleLocales: ['de'] });
    const file = join(root, '.lexi', 'project.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    saved['visibleLocales'] = ['de', 'kl-GL'];
    saved['filters'] = ['untranslated', 'notARealFilter'];
    await writeFile(file, JSON.stringify(saved), 'utf8');

    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
    const reopened = await open();

    expect(reopened.visibleLocales).toEqual(['de']);
    expect(reopened.filters).toEqual(['untranslated']);
  });
});

describe('the six FR-2.2 counters', () => {
  it('reports missing-entirely and orphans, which needed the correlation index', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });
    const project = res.json<Project>();

    const fr = project.locales.find((l) => l.locale === 'fr')!;
    // `billing`, which messages.fr.xlf omits — AND `checkout/messages:pay`,
    // because there is no French file in that group at all. A whole absent
    // locale file counts every one of its keys as missing, which is the
    // answer FR-2.2 wants: "keys missing entirely from the file".
    expect(fr.missing).toBe(2);

    const de = project.locales.find((l) => l.locale === 'de')!;
    expect(de.orphans).toBe(1); // `ghost`
    expect(de.missing).toBe(0);
  });

  it('counts total keys once, not once per locale', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });
    expect(res.json<Project>().unitCount).toBe(7);
  });
});
