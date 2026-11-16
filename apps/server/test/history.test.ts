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
  type DiscardResponse,
  type HistoryStatus,
  type HistoryStepResponse,
  type Project,
  type TargetPatchResponse,
  type UnitDetail,
  type UnitTarget,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { commitTarget, editableCell, openRow } from '../src/lib/commit.js';
import { originKey, targetHash } from '../src/lib/machine-origin.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * Undo, redo and "Discard all" for unsaved work (`lib/history.ts`).
 *
 * What matters is that an undo puts back EXACTLY what was there — the overlay
 * entry, the machine-origin marker and the edit-rate counter together — and
 * that it never reaches past what the user did: a save ends the history, and a
 * machine draft is not something ⌘Z takes away.
 */

const unit = (id: string, source: string, target: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>
        <target>${target}</target>
      </trans-unit>`;

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

const sourceXlf = xlf(
  'en-GB',
  [unit('pay', 'Pay now', 'Pay now'), unit('done', 'Already done', 'Already done')].join('\n'),
);
const deXlf = xlf(
  'de',
  [unit('pay', 'Pay now', 'Jetzt bezahlen'), unit('done', 'Already done', 'Bereits erledigt')].join(
    '\n',
  ),
);

const PAY = rowIdOf('messages', 'pay');
const DONE = rowIdOf('messages', 'done');

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-history-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), deXlf, 'utf8');

  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
  await open();
});

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
  return res.json<Project>();
}

const url = (rowId: string, locale: string, suffix = '') =>
  `/api/units/${encodeURIComponent(rowId)}/targets/${locale}${suffix}`;

const patch = (rowId: string, text: string) =>
  app.inject({
    method: 'PATCH',
    url: url(rowId, 'de'),
    headers: goodHeaders(),
    payload: { segments: [{ k: 't', v: text }] },
  });

const post = (path: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: path, headers: goodHeaders(), payload });

const undo = () => post('/api/history/undo');
const redo = () => post('/api/history/redo');
const status = async () =>
  (
    await app.inject({ method: 'GET', url: '/api/history', headers: goodHeaders() })
  ).json<HistoryStatus>();

const detail = async (rowId: string): Promise<UnitDetail> =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    })
  ).json<UnitDetail>();

const deOf = async (rowId: string): Promise<UnitTarget> =>
  (await detail(rowId)).targets.find((t) => t.locale === 'de') as UnitTarget;

const textOf = async (rowId: string): Promise<string> =>
  (await deOf(rowId)).segments.map((s) => (s.k === 't' ? s.v : '')).join('');

const project = async (): Promise<Project> =>
  (
    await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() })
  ).json<Project>();

/** `pay`'s German bytes are marked as a model's draft, the way `translateUnit` marks them. */
function markPayAsMachineDraft(): void {
  projects.setMachineOrigin(PAY, 'de', {
    at: new Date().toISOString(),
    model: 'test-model',
    style: 'raw',
    hash: targetHash(composeSegments([{ k: 't', v: 'Jetzt bezahlen' }], 'angular')),
    previous: null,
    temperature: 0.2,
    styleGuide: null,
    glossaryInjected: 0,
    glossaryApplied: 0,
    glossaryTotal: 0,
  });
  projects.rebuildIndex();
}

describe('undo and redo', () => {
  it('walks back through each edit to the file, and forward again', async () => {
    await patch(PAY, 'Eins');
    const second = (await patch(PAY, 'Zwei')).json<TargetPatchResponse>();
    expect(second.history).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: 'Edit',
      redoLabel: null,
    });

    const first = await undo();
    expect(first.statusCode).toBe(200);
    const body = first.json<HistoryStepResponse>();
    expect(body.label).toBe('Edit');
    expect(body.cells).toMatchObject([{ rowId: PAY, locale: 'de', pending: true }]);
    expect(body.unsavedCount).toBe(1);
    expect(await textOf(PAY)).toBe('Eins');

    const toFile = (await undo()).json<HistoryStepResponse>();
    expect(toFile.cells[0]?.pending).toBe(false);
    expect(toFile.unsavedCount).toBe(0);
    expect(toFile.history.canUndo).toBe(false);
    expect(await textOf(PAY)).toBe('Jetzt bezahlen');

    await redo();
    expect(await textOf(PAY)).toBe('Eins');
    const last = (await redo()).json<HistoryStepResponse>();
    expect(last.history).toMatchObject({ canUndo: true, canRedo: false });
    expect(await textOf(PAY)).toBe('Zwei');
  });

  it('409s when there is nothing to take back', async () => {
    expect((await undo()).statusCode).toBe(409);
    expect((await redo()).statusCode).toBe(409);
  });

  it('forgets what could be redone once something new is done', async () => {
    await patch(PAY, 'Eins');
    await undo();
    expect((await status()).canRedo).toBe(true);
    await patch(DONE, 'Anders');
    expect((await status()).canRedo).toBe(false);
  });

  it('keeps the drafts file in step, so a restart finds the undone state', async () => {
    await patch(PAY, 'Eins');
    await undo();
    const drafts = JSON.parse(await readFile(join(root, '.lexi', 'drafts.json'), 'utf8')) as {
      drafts: unknown[];
    };
    expect(drafts.drafts).toEqual([]);
  });

  it('brings back the machine-draft marker and uncounts the correction', async () => {
    markPayAsMachineDraft();
    expect((await deOf(PAY)).state).toBe('draftMachine');

    await patch(PAY, 'Von Hand');
    expect(projects.machineOrigins.has(originKey(PAY, 'de'))).toBe(false);
    expect((await project()).editRate.find((e) => e.locale === 'de')).toMatchObject({
      corrected: 1,
    });

    await undo();
    expect(projects.machineOrigins.has(originKey(PAY, 'de'))).toBe(true);
    expect((await deOf(PAY)).state).toBe('draftMachine');
    expect((await project()).editRate.find((e) => e.locale === 'de')).toMatchObject({
      corrected: 0,
    });
  });

  it('takes a whole bulk approve back as one step', async () => {
    markPayAsMachineDraft();
    await post('/api/units/bulk-approve', { rowIds: [PAY], locale: 'de' });
    expect((await status()).undoLabel).toBe('Approve');

    await undo();
    expect((await deOf(PAY)).state).toBe('draftMachine');
    expect((await status()).canUndo).toBe(false);
  });

  it('records nothing for a bulk approve that approved nothing', async () => {
    await post('/api/units/bulk-approve', { rowIds: [DONE], locale: 'de' });
    expect((await status()).canUndo).toBe(false);
  });

  it('undoes a note edit', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/units/${encodeURIComponent(PAY)}/notes`,
      headers: goodHeaders(),
      payload: { notes: [{ from: 'description', text: 'The big button.' }] },
    });
    expect((await detail(PAY)).notesPending).toBe(true);

    const body = (await undo()).json<HistoryStepResponse>();
    expect(body.label).toBe('Edit notes');
    expect(body.noteRows).toEqual([PAY]);
    const after = await detail(PAY);
    expect(after.notesPending).toBe(false);
    expect(after.notes).toEqual([]);
  });

  it('undoes a revert', async () => {
    await patch(PAY, 'Eins');
    await app.inject({ method: 'DELETE', url: url(PAY, 'de', '/draft'), headers: goodHeaders() });
    expect((await status()).undoLabel).toBe('Revert');
    await undo();
    expect(await textOf(PAY)).toBe('Eins');
  });
});

describe('what ends or trims the history', () => {
  it('ends at a save', async () => {
    await patch(PAY, 'Eins');
    await post('/api/save', {});
    expect(await status()).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    });
    expect((await undo()).statusCode).toBe(409);
  });

  it('drops the steps of a cell a machine draft has since landed in', async () => {
    await patch(PAY, 'Eins');
    await patch(DONE, 'Anders');
    // The commit `translateUnit` makes, then the prune it follows it with.
    const row = openRow(projects, PAY);
    commitTarget(
      projects,
      row,
      'de',
      [{ k: 't', v: 'Maschine' }],
      'draftMachine',
      editableCell(projects, row, 'de'),
    );
    projects.pruneHistory(PAY, 'de');

    await undo();
    expect((await status()).canUndo).toBe(false);
    expect(await textOf(DONE)).toBe('Bereits erledigt');
    expect(await textOf(PAY)).toBe('Maschine');
  });
});

describe('POST /api/drafts/discard', () => {
  it('throws every unsaved edit away, notes included, and one undo brings it all back', async () => {
    await patch(PAY, 'Eins');
    await patch(DONE, 'Anders');
    await app.inject({
      method: 'PUT',
      url: `/api/units/${encodeURIComponent(DONE)}/notes`,
      headers: goodHeaders(),
      payload: { notes: [{ from: 'description', text: 'Done.' }] },
    });

    const res = await post('/api/drafts/discard', {});
    expect(res.statusCode).toBe(200);
    const body = res.json<DiscardResponse>();
    expect(body.unsavedCount).toBe(0);
    expect(body.cells).toHaveLength(2);
    expect(body.noteRows).toEqual([DONE]);
    expect(body.history.undoLabel).toBe('Discard all');
    expect(await textOf(PAY)).toBe('Jetzt bezahlen');

    const back = (await undo()).json<HistoryStepResponse>();
    expect(back.unsavedCount).toBe(3);
    expect(await textOf(PAY)).toBe('Eins');
    expect(await textOf(DONE)).toBe('Anders');
    expect((await detail(DONE)).notesPending).toBe(true);
  });

  it('discards only the cells it is given', async () => {
    await patch(PAY, 'Eins');
    await patch(DONE, 'Anders');
    const body = (
      await post('/api/drafts/discard', { cells: [{ rowId: PAY, locale: 'de' }] })
    ).json<DiscardResponse>();
    expect(body.cells).toMatchObject([{ rowId: PAY, locale: 'de', pending: false }]);
    expect(body.unsavedCount).toBe(1);
    expect(body.history.undoLabel).toBe('Revert');
    expect(await textOf(DONE)).toBe('Anders');
  });

  it('records no step when there was nothing to discard', async () => {
    await post('/api/drafts/discard', {});
    expect((await status()).canUndo).toBe(false);
  });
});
