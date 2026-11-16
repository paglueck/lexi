// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeSegments } from '@lexi/xliff';
import {
  rowIdOf,
  type IgnoredFindingsResponse,
  type IssueFindingsResponse,
  type IssueFixAllResponse,
  type IssueFixResponse,
  type IssuesSummary,
  type Project,
  type ProjectScanResponse,
  type UnitDetail,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { originKey, targetHash } from '../src/lib/machine-origin.js';
import { ProjectService, sourceHash } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * S12, the Issues screen (FR-8.3, FR-8.4): the summary, one rule's findings
 * with their deterministic fixes, applying them, and ignoring a finding.
 *
 * Every German finding is of a different kind, so a fix wired to the wrong case
 * cannot pass by coincidence: an insert at the end, a rename, a warning with no
 * fix, and a whitespace difference. French repeats the insert in another file,
 * so the per-locale filter has something to leave out.
 */

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

const unit = (id: string, source: string, target?: string): string => {
  const t = target === undefined ? '' : `\n        <target state="translated">${target}</target>`;
  return `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${t}
      </trans-unit>`;
};

const OPEN = '<x id="START_LINK" ctype="x-a" equiv-text="&lt;a&gt;"/>';
const CLOSE = '<x id="CLOSE_LINK" ctype="x-a" equiv-text="&lt;/a&gt;"/>';
const NAME = '<x id="INTERPOLATION" equiv-text="{{ name }}"/>';
const NAME_1 = '<x id="INTERPOLATION_1" equiv-text="{{ nme }}"/>';

const TERMS = 'aaaaaaaaaaaaaaaa1';
const HELLO = 'aaaaaaaaaaaaaaaa2';
const TOTAL = 'checkout.total';
const ITEMS = 'aaaaaaaaaaaaaaaa4';
const row = (id: string) => rowIdOf('messages', id);

const GERMAN_TERMS = `Ich akzeptiere die ${OPEN}AGB`;

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-issues-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(root, { recursive: true });
});

/** Written before every test: one of them saves, which rewrites the German file. */
async function writeFixtures(): Promise<void> {
  await writeFile(
    join(root, 'messages.xlf'),
    xlf(
      'en-GB',
      [
        unit(TERMS, `I accept the ${OPEN}terms and conditions${CLOSE}`),
        unit(HELLO, `Hello ${NAME}`),
        unit(TOTAL, 'Total'),
        unit(ITEMS, 'Items: '),
      ].join('\n'),
    ),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf(
      'de',
      [
        unit(TERMS, `I accept the ${OPEN}terms and conditions${CLOSE}`, GERMAN_TERMS),
        unit(HELLO, `Hello ${NAME}`, `Hallo ${NAME_1}`),
        unit(TOTAL, 'Total', 'Total'),
        unit(ITEMS, 'Items: ', 'Artikel:'),
      ].join('\n'),
    ),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.fr.xlf'),
    // `orphan.done` exists only here, so it is validated against its own source.
    xlf(
      'fr',
      [unit(HELLO, `Hello ${NAME}`, 'Bonjour'), unit('orphan.done', 'Done.', 'Terminé')].join('\n'),
    ),
    'utf8',
  );
}

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await writeFixtures();
  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
});

async function open(): Promise<void> {
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
}

const get = async <T>(url: string): Promise<T> => {
  const res = await app.inject({ method: 'GET', url, headers: goodHeaders() });
  expect(res.statusCode).toBe(200);
  return res.json<T>();
};

const send = (method: 'POST' | 'DELETE' | 'PATCH', url: string, payload: unknown) =>
  app.inject({ method, url, headers: goodHeaders(), payload: payload as Record<string, unknown> });

const summary = (locale?: string) =>
  get<IssuesSummary>(`/api/issues${locale ? `?locale=${locale}` : ''}`);
const findings = (rule: string, locale?: string) =>
  get<IssueFindingsResponse>(`/api/issues/rules/${rule}${locale ? `?locale=${locale}` : ''}`);
const project = () => get<Project>('/api/project');
const detail = (rowId: string) =>
  get<UnitDetail>(`/api/units/${encodeURIComponent(rowId)}?locales=de,fr`);
const countOf = (s: IssuesSummary, rule: string) =>
  s.rules.find((r) => r.rule === rule)?.count ?? 0;

function markTermsAsMachineDraft(): void {
  projects.setMachineOrigin(row(TERMS), 'de', {
    at: new Date().toISOString(),
    model: 'test-model',
    style: 'raw',
    hash: targetHash(GERMAN_TERMS),
    previous: null,
  });
  projects.rebuildIndex();
}

describe('GET /api/issues', () => {
  it('counts findings per rule and names the locales they occur in', async () => {
    await open();
    const s = await summary();
    expect(s.units).toBe(5); // four source units and one orphan
    expect(countOf(s, 'placeholder.mismatch')).toBe(3);
    expect(s.rules.find((r) => r.rule === 'placeholder.mismatch')?.locales).toEqual(['de', 'fr']);
    expect(countOf(s, 'target.identicalToSource')).toBe(1);
    expect(countOf(s, 'whitespace.edges')).toBe(1);
    expect(s.locales).toEqual(['de', 'fr']);
    // Errors come first.
    expect(s.rules[0]?.severity).toBe('error');
    expect(s.ignored).toBe(0);
    expect(s.validatedAt).toBeGreaterThan(0);
  });

  it('narrows to one locale', async () => {
    await open();
    expect(countOf(await summary('fr'), 'placeholder.mismatch')).toBe(1);
    expect(countOf(await summary('fr'), 'whitespace.edges')).toBe(0);
  });

  it('counts a rule switched off as off, and leaves it out of the list', async () => {
    await open();
    await send('PATCH', '/api/project', { severities: { 'whitespace.edges': 'off' } });
    const s = await summary();
    expect(s.rulesOff).toBe(1);
    expect(countOf(s, 'whitespace.edges')).toBe(0);
  });
});

describe('GET /api/issues/rules/:rule', () => {
  it('names the placeholder ids and offers exactly the deterministic fixes', async () => {
    await open();
    const res = await findings('placeholder.mismatch');
    expect(res.severity).toBe('error');
    const byKey = new Map(res.findings.map((f) => [`${f.unitId} ${f.locale}`, f]));

    const terms = byKey.get(`${TERMS} de`);
    expect(terms?.placeholders).toEqual({ missing: ['CLOSE_LINK'], unexpected: [] });
    expect(terms?.fix?.kind).toBe('insert-edge');
    expect(terms?.file).toBe('messages.de.xlf');

    expect(byKey.get(`${HELLO} de`)?.fix?.kind).toBe('rename');
    expect(byKey.get(`${HELLO} fr`)?.fix?.kind).toBe('insert-edge');
    // Grouped by file.
    expect(res.findings.map((f) => f.file)).toEqual([
      'messages.de.xlf',
      'messages.de.xlf',
      'messages.fr.xlf',
    ]);
  });

  it('offers no fix for a warning that needs a person', async () => {
    await open();
    const res = await findings('target.identicalToSource');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.fix).toBeNull();
  });

  it('finds an orphan’s finding, which only its own source can explain', async () => {
    await open();
    expect(countOf(await summary(), 'punctuation.terminal')).toBe(1);
    const res = await findings('punctuation.terminal');
    expect(res.findings.map((f) => `${f.unitId} ${f.locale}`)).toEqual(['orphan.done fr']);

    // The panel agrees: the orphan's own source, and the same finding.
    const d = await detail(row('orphan.done'));
    expect(d.source).toEqual([{ k: 't', v: 'Done.' }]);
    expect(d.targets.find((t) => t.locale === 'fr')?.findings.map((f) => f.rule)).toContain(
      'punctuation.terminal',
    );
  });

  it('refuses a rule it does not know', async () => {
    await open();
    const res = await app.inject({
      method: 'GET',
      url: '/api/issues/rules/nope',
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/issues/fix', () => {
  it('fixes into the overlay, leaving the file alone until save', async () => {
    await open();
    const before = await readFile(join(root, 'messages.de.xlf'), 'utf8');
    const res = await send('POST', '/api/issues/fix', {
      rowId: row(HELLO),
      locale: 'de',
      rule: 'placeholder.mismatch',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<IssueFixResponse>();
    expect(body.target.findings.map((f) => f.rule)).not.toContain('placeholder.mismatch');
    expect(body.unsavedCount).toBe(1);
    expect(await readFile(join(root, 'messages.de.xlf'), 'utf8')).toBe(before);
    expect(countOf(await summary(), 'placeholder.mismatch')).toBe(2);
  });

  it('keeps a machine draft a machine draft, through save, and leaves the edit rate alone', async () => {
    await open();
    markTermsAsMachineDraft();
    const res = await send('POST', '/api/issues/fix', {
      rowId: row(TERMS),
      locale: 'de',
      rule: 'placeholder.mismatch',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<IssueFixResponse>().target.state).toBe('draftMachine');

    const rate = (await project()).editRate.find((e) => e.locale === 'de');
    expect(rate).toMatchObject({ approvedClean: 0, corrected: 0 });

    // The marker follows the new bytes, so the cell still reads as a draft
    // after the file has been rewritten.
    const hash = projects.machineOrigins.get(originKey(row(TERMS), 'de'))?.hash;
    expect(hash).toBe(targetHash(`${GERMAN_TERMS}${CLOSE}`));
    expect((await send('POST', '/api/save', {})).statusCode).toBe(200);
    const after = await detail(row(TERMS));
    expect(after.targets.find((t) => t.locale === 'de')?.state).toBe('draftMachine');

    // A one-line diff, with the placeholder's bytes copied from the source.
    const saved = await readFile(join(root, 'messages.de.xlf'), 'utf8');
    expect(saved).toContain(`${GERMAN_TERMS}${CLOSE}</target>`);
  });

  it('copies the source whitespace', async () => {
    await open();
    const res = await send('POST', '/api/issues/fix', {
      rowId: row(ITEMS),
      locale: 'de',
      rule: 'whitespace.edges',
    });
    expect(res.statusCode).toBe(200);
    const segments = res.json<IssueFixResponse>().target.segments;
    expect(
      composeSegments(
        segments.map((s) => (s.k === 't' ? { k: 't', v: s.v } : s)) as never,
        'angular',
      ),
    ).toBe('Artikel: ');
  });

  it('answers 409 for a finding that has no fix', async () => {
    await open();
    const res = await send('POST', '/api/issues/fix', {
      rowId: row(TOTAL),
      locale: 'de',
      rule: 'target.identicalToSource',
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/issues/fix-all', () => {
  it('applies every fix of one rule, in every file', async () => {
    await open();
    const res = await send('POST', '/api/issues/fix-all', { rule: 'placeholder.mismatch' });
    expect(res.json<IssueFixAllResponse>()).toEqual({ applied: 3, unsavedCount: 3 });
    expect(countOf(await summary(), 'placeholder.mismatch')).toBe(0);
  });

  it('stays inside one locale when asked', async () => {
    await open();
    const res = await send('POST', '/api/issues/fix-all', {
      rule: 'placeholder.mismatch',
      locale: 'fr',
    });
    expect(res.json<IssueFixAllResponse>().applied).toBe(1);
    expect(countOf(await summary(), 'placeholder.mismatch')).toBe(2);
  });
});

describe('ignoring a finding', () => {
  const ref = { rowId: '', locale: 'de', rule: 'target.identicalToSource' };

  it('hides it from Issues and the dashboard alike, and writes the committed file', async () => {
    await open();
    const warningsBefore = (await project()).health.warningCells;
    const res = await send('POST', '/api/issues/ignore', { ...ref, rowId: row(TOTAL) });
    expect(res.statusCode).toBe(200);
    const s = res.json<IssuesSummary>();
    expect(countOf(s, 'target.identicalToSource')).toBe(0);
    expect(s.ignored).toBe(1);
    expect((await project()).health.warningCells).toBe(warningsBefore - 1);

    const file = JSON.parse(
      await readFile(join(root, '.lexi', 'ignored-findings.json'), 'utf8'),
    ) as unknown;
    expect(file).toEqual({
      version: 1,
      groups: {
        messages: { [TOTAL]: { de: { 'target.identicalToSource': sourceHash('Total') } } },
      },
    });
    const gitignore = await readFile(join(root, '.lexi', '.gitignore'), 'utf8');
    expect(gitignore).not.toContain('ignored-findings');

    const listed = await get<IgnoredFindingsResponse>('/api/issues/ignored');
    expect(listed.ignored).toEqual([
      {
        rowId: row(TOTAL),
        locale: 'de',
        rule: 'target.identicalToSource',
        group: 'messages',
        unitId: TOTAL,
      },
    ]);
  });

  it('can be undone', async () => {
    await open();
    await send('POST', '/api/issues/ignore', { ...ref, rowId: row(TOTAL) });
    const res = await send('DELETE', '/api/issues/ignore', { ...ref, rowId: row(TOTAL) });
    expect(countOf(res.json<IssuesSummary>(), 'target.identicalToSource')).toBe(1);
    expect(res.json<IssuesSummary>().ignored).toBe(0);
  });

  it('survives a reopen, but not a changed source', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    const file = (hash: string) =>
      JSON.stringify({
        version: 1,
        groups: { messages: { [TOTAL]: { de: { 'target.identicalToSource': hash } } } },
      });

    await writeFile(
      join(root, '.lexi', 'ignored-findings.json'),
      file(sourceHash('Total')),
      'utf8',
    );
    await open();
    expect((await summary()).ignored).toBe(1);

    await writeFile(
      join(root, '.lexi', 'ignored-findings.json'),
      file(sourceHash('Grand total')),
      'utf8',
    );
    await open();
    const s = await summary();
    expect(s.ignored).toBe(0);
    expect(countOf(s, 'target.identicalToSource')).toBe(1);
  });
});

describe('POST /api/issues/revalidate', () => {
  it('rebuilds and moves the timestamp', async () => {
    await open();
    const before = (await summary()).validatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const res = await send('POST', '/api/issues/revalidate', {});
    expect(res.json<IssuesSummary>().validatedAt).toBeGreaterThan(before);
  });
});

describe('a rebuild keeps the unsaved drafts in the counts', () => {
  it('after a severity change', async () => {
    await open();
    const fixed = await send('PATCH', `/api/units/${encodeURIComponent(row(HELLO))}/targets/de`, {
      segments: [
        { k: 't', v: 'Hallo ' },
        { k: 'p', id: 'INTERPOLATION' },
      ],
    });
    expect(fixed.statusCode).toBe(200);
    const errors = (await project()).health.errorCells;

    await send('PATCH', '/api/project', { severities: { 'punctuation.terminal': 'off' } });
    expect((await project()).health.errorCells).toBe(errors);
    expect(countOf(await summary(), 'placeholder.mismatch')).toBe(2);
  });
});
