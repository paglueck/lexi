// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  type FilesReloadResponse,
  type Project,
  type ProjectScanResponse,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M7's server half: the stat strip's figures, the coverage table's four
 * segments, the needs-attention rail's rule breakdown (FR-2.2, FR-2.3, FR-4.4,
 * FR-2.5b, FR-8.3), and the reload path behind the banner (FR-1.5).
 *
 * The fixture is built to make each figure fall out differently from every
 * other, so a counter wired to the wrong field cannot pass by coincidence: two
 * of four units carry notes, one of four has a custom id, German has one broken
 * placeholder and Polish has an ICU unit missing half its plural categories.
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

interface UnitOptions {
  readonly target?: string;
  readonly state?: string;
  readonly note?: string;
}

const unit = (id: string, source: string, o: UnitOptions = {}): string => {
  const note =
    o.note === undefined ? '' : `\n        <note priority="1" from="description">${o.note}</note>`;
  const target =
    o.target === undefined
      ? ''
      : `\n        <target${o.state === undefined ? '' : ` state="${o.state}"`}>${o.target}</target>`;
  return `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target}${note}
      </trans-unit>`;
};

/** An `<x/>` placeholder, which is what the placeholder rules are about. */
const ph = (id: string, equiv: string): string => `<x id="${id}" equiv-text="${equiv}"/>`;

const PLURAL = '{VAR_PLURAL, plural, one {1 item} other {# items} }';

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-dashboard-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(root, { recursive: true });

  // Four units. `pay` and `count` carry notes; `checkout.total` is the one
  // developer-assigned id. `count` is the ICU unit.
  const source = [
    unit('aaaaaaaaaaaaaaaa1', `Pay ${ph('INTERPOLATION', '{{ amount }}')} now`, {
      note: 'The checkout button.',
    }),
    unit('aaaaaaaaaaaaaaaa2', 'Billing'),
    unit('checkout.total', 'Total'),
    unit('aaaaaaaaaaaaaaaa3', PLURAL, { note: 'Basket line count.' }),
  ].join('\n');
  await writeFile(join(root, 'messages.xlf'), xlf('en-GB', source), 'utf8');

  // German: one placeholder dropped on purpose (error), one reviewed target,
  // one machine draft, one untranslated.
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf(
      'de',
      [
        unit('aaaaaaaaaaaaaaaa1', `Pay ${ph('INTERPOLATION', '{{ amount }}')} now`, {
          target: 'Jetzt bezahlen',
          state: 'translated',
        }),
        unit('aaaaaaaaaaaaaaaa2', 'Billing', { target: 'Abrechnung', state: 'translated' }),
        unit('checkout.total', 'Total', {
          target: 'Summe',
          state: 'needs-review-translation',
        }),
        unit('aaaaaaaaaaaaaaaa3', PLURAL),
      ].join('\n'),
    ),
    'utf8',
  );

  // Polish: the ICU unit keeps only `one` and `other`, which is FR-PH-5's case —
  // Polish needs `few` and `many` as well.
  await writeFile(
    join(root, 'messages.pl.xlf'),
    xlf(
      'pl',
      [
        unit('aaaaaaaaaaaaaaaa1', `Pay ${ph('INTERPOLATION', '{{ amount }}')} now`, {
          target: `Zapłać ${ph('INTERPOLATION', '{{ amount }}')} teraz`,
          state: 'translated',
        }),
        unit('aaaaaaaaaaaaaaaa3', PLURAL, {
          target: '{VAR_PLURAL, plural, one {1 rzecz} other {# rzeczy} }',
          state: 'translated',
        }),
      ].join('\n'),
    ),
    'utf8',
  );
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
});

async function open(): Promise<Project> {
  const scan = (
    await app.inject({
      method: 'POST',
      url: '/api/projects/scan',
      headers: goodHeaders(),
      payload: { path: root },
    })
  ).json<ProjectScanResponse>();

  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: 'en-GB',
      mapping: scan.files.map((f) => ({
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

const project = async (): Promise<Project> =>
  (
    await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() })
  ).json<Project>();

describe('the stat strip (S3)', () => {
  it('reports note coverage as a share of units, not of cells (FR-4.4)', async () => {
    const dto = await open();
    // Two of the four source units carry a `<note>`.
    expect(dto.health.units).toBe(4);
    expect(dto.health.unitsWithNote).toBe(2);
    expect(dto.health.noteCoverage).toBe(50);
  });

  it('reports the custom-id share as a count and a percentage (FR-2.5b)', async () => {
    const dto = await open();
    expect(dto.health.customIdUnits).toBe(1);
    expect(dto.health.customIdShare).toBe(25);
    // The pre-existing top-level field keeps saying the same thing.
    expect(dto.customIdShare).toBe(dto.health.customIdShare);
  });

  it('counts open issues by cell, so one broken unit in two locales counts twice', async () => {
    const dto = await open();
    // de drops the interpolation; pl keeps it but is missing plural categories.
    expect(dto.health.errorCells).toBeGreaterThanOrEqual(2);
  });
});

describe('the needs-attention rail (FR-8.3)', () => {
  it('names the rule, the locale and the number of units', async () => {
    const dto = await open();

    const plural = dto.health.issues.find((i) => i.rule === 'icu.pluralCoverage');
    expect(plural).toBeDefined();
    expect(plural?.severity).toBe('error');
    expect(plural?.units).toBe(1);
    expect(plural?.locales).toEqual([{ locale: 'pl', cells: 1 }]);

    const placeholder = dto.health.issues.find((i) => i.rule === 'placeholder.mismatch');
    expect(placeholder?.locales).toEqual([{ locale: 'de', cells: 1 }]);
  });

  it('puts errors before warnings and omits rules that never fired', async () => {
    const { health } = await open();
    const severities = health.issues.map((i) => i.severity);
    expect(severities.slice().sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1))).toEqual(
      severities,
    );
    expect(health.issues.every((i) => i.cells > 0)).toBe(true);
  });

  it('moves when an edit fixes the string, rather than waiting for a save', async () => {
    const dto = await open();
    const before = dto.health.issues.find((i) => i.rule === 'placeholder.mismatch')?.cells ?? 0;
    expect(before).toBe(1);

    // Put the missing placeholder back. This never touches the file.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'aaaaaaaaaaaaaaaa1'))}/targets/de`,
      headers: goodHeaders(),
      payload: {
        segments: [
          { k: 't', v: 'Jetzt ' },
          { k: 'p', id: 'INTERPOLATION' },
          { k: 't', v: ' bezahlen' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await project();
    expect(after.health.issues.find((i) => i.rule === 'placeholder.mismatch')).toBeUndefined();
  });
});

describe('per-project rule severities (FR-8.2)', () => {
  const patch = async (severities: Record<string, string>): Promise<Project> => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/project',
      headers: goodHeaders(),
      payload: { severities },
    });
    expect(res.statusCode).toBe(200);
    return res.json<Project>();
  };

  it('drops a rule switched off from the rail and the error count', async () => {
    const dto = await open();
    expect(dto.health.issues.some((i) => i.rule === 'icu.pluralCoverage')).toBe(true);

    const after = await patch({ 'icu.pluralCoverage': 'off' });
    expect(after.health.issues.some((i) => i.rule === 'icu.pluralCoverage')).toBe(false);
    expect(after.health.errorCells).toBe(dto.health.errorCells - 1);
  });

  it('demotes an error to a warning when asked', async () => {
    await open();
    const after = await patch({ 'placeholder.mismatch': 'warning' });
    expect(after.health.issues.find((i) => i.rule === 'placeholder.mismatch')?.severity).toBe(
      'warning',
    );
  });

  it('keeps earlier choices when a later PATCH names a different rule', async () => {
    await open();
    await patch({ 'icu.pluralCoverage': 'off' });
    const after = await patch({ 'placeholder.mismatch': 'warning' });
    expect(after.severities['icu.pluralCoverage']).toBe('off');
    expect(after.severities['placeholder.mismatch']).toBe('warning');
    expect(after.health.issues.some((i) => i.rule === 'icu.pluralCoverage')).toBe(false);
  });
});

describe('glossary rules reach the counts (FR-8.1)', () => {
  it('flags a target that ignores a term the moment the term is added, and stops when it is off', async () => {
    const dto = await open();
    expect(dto.health.issues.some((i) => i.rule === 'glossary.term')).toBe(false);

    // German translates "Total" as "Summe"; the term base now says "Gesamt".
    const created = await app.inject({
      method: 'POST',
      url: '/api/termbase',
      headers: goodHeaders(),
      payload: { term: 'Total', translations: { de: 'Gesamt' } },
    });
    expect(created.statusCode).toBe(200);

    const after = await project();
    const issue = after.health.issues.find((i) => i.rule === 'glossary.term');
    expect(issue?.severity).toBe('warning');
    expect(issue?.locales).toEqual([{ locale: 'de', cells: 1 }]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'checkout.total'))}`,
      headers: goodHeaders(),
    });
    expect(detail.body).toContain('should be translated as');

    const off = await app.inject({
      method: 'PATCH',
      url: '/api/project',
      headers: goodHeaders(),
      payload: { severities: { 'glossary.term': 'off' } },
    });
    expect(off.json<Project>().health.issues.some((i) => i.rule === 'glossary.term')).toBe(false);
  });
});

describe('the coverage table', () => {
  it('separates machine drafts from needs-review targets', async () => {
    const dto = await open();
    const de = dto.locales.find((l) => l.locale === 'de')!;

    // `needs-review-translation` in the file is a human's needs-review, and the
    // three other units are one reviewed, one translated-but-broken, one empty.
    expect(de.needsReview).toBe(1);
    expect(de.draftMachine).toBe(0);
    expect(de.translated).toBe(2);
    expect(de.untranslated).toBe(1);
    expect(de.unitCount).toBe(de.translated + de.draftMachine + de.needsReview + de.untranslated);
  });

  it('counts a unit absent from the locale file as missing AND untranslated (FR-2.2)', async () => {
    const dto = await open();
    const pl = dto.locales.find((l) => l.locale === 'pl')!;
    // Polish has two of the four units.
    expect(pl.missing).toBe(2);
    expect(pl.untranslated).toBe(2);
  });
});

describe('POST /api/files/reload (FR-1.5)', () => {
  const dePath = () => join(root, 'messages.de.xlf');

  it('picks up a change made on disk', async () => {
    await open();
    const before = await readFile(dePath(), 'utf8');
    await writeFile(dePath(), before.replace('Abrechnung', 'Rechnungsstellung'), 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/reload',
      headers: goodHeaders(),
      payload: { paths: [dePath()] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<FilesReloadResponse>().reloaded).toEqual([dePath()]);

    const row = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'aaaaaaaaaaaaaaaa2'))}`,
      headers: goodHeaders(),
    });
    expect(row.body).toContain('Rechnungsstellung');

    await writeFile(dePath(), before, 'utf8');
  });

  it('carries an unsaved edit across a reload that does not disturb it', async () => {
    await open();
    await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'checkout.total'))}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Gesamtsumme' }] },
    });

    const before = await readFile(dePath(), 'utf8');
    await writeFile(dePath(), before.replace('Abrechnung', 'Rechnungsstellung'), 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/reload',
      headers: goodHeaders(),
      payload: { paths: [dePath()] },
    });
    const body = res.json<FilesReloadResponse>();
    expect(body.dropped).toBe(0);
    expect(body.unsavedCount).toBe(1);

    // And it is still the thing the grid renders, re-attached to the new bytes.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'checkout.total'))}`,
      headers: goodHeaders(),
    });
    expect(detail.body).toContain('Gesamtsumme');

    await writeFile(dePath(), before, 'utf8');
  });

  /**
   * The unit vanished from the GERMAN file, not from the source — so the string
   * is still in the product and still needs German. Before FR-1.9 the edit was
   * dropped, because the machinery could not express "put the unit back"; now it
   * survives and the save re-inserts it. Losing somebody's translation because a
   * merge pruned a line is the outcome this must not have.
   */
  it('keeps an unsaved edit whose unit vanished from the target file, and re-creates it', async () => {
    await open();
    await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'checkout.total'))}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Gesamtsumme' }] },
    });

    const before = await readFile(dePath(), 'utf8');
    // The unit the edit belongs to is gone — the shape of a `git pull` that
    // landed a re-extraction.
    const withoutTotal = before.replace(
      /[ ]{6}<trans-unit id="checkout\.total"[\s\S]*?<\/trans-unit>\n/,
      '',
    );
    expect(withoutTotal).not.toContain('checkout.total');
    await writeFile(dePath(), withoutTotal, 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/reload',
      headers: goodHeaders(),
      payload: { paths: [dePath()] },
    });
    const body = res.json<FilesReloadResponse>();
    expect(body.dropped).toBe(0);
    expect(body.unsavedCount).toBe(1);

    // And saving puts the unit back, with the translation that was typed.
    const saved = await app.inject({
      method: 'POST',
      url: '/api/save',
      headers: goodHeaders(),
      payload: {},
    });
    expect(saved.statusCode).toBe(200);
    const after = await readFile(dePath(), 'utf8');
    expect(after).toContain('<trans-unit id="checkout.total"');
    expect(after).toContain('Gesamtsumme');

    await writeFile(dePath(), before, 'utf8');
  });
});
