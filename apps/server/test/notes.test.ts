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
  type NotesPutResponse,
  type Project,
  type ProjectScanResponse,
  type PromptPreviewResponse,
  type UnitDetail,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * FR-4.2: notes edited in the app. They go through the same overlay-then-save
 * discipline as targets — nothing reaches the file before Save, a save is a
 * one-line diff, and a note edit the file moved underneath is dropped rather
 * than written over somebody else's context.
 */

const SOURCE = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="en-GB">
    <body>
      <trans-unit id="pay" datatype="html">
        <source>Pay now</source>
        <context-group purpose="location">
          <context context-type="sourcefile">src/app/pay.html</context>
          <context context-type="linenumber">3</context>
        </context-group>
        <note priority="1" from="description">The checkout button.</note>
      </trans-unit>
      <trans-unit id="billing" datatype="html">
        <source>Billing</source>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

const GERMAN = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="de">
    <body>
      <trans-unit id="pay" datatype="html">
        <source>Pay now</source>
        <target>Jetzt bezahlen</target>
      </trans-unit>
      <trans-unit id="billing" datatype="html">
        <source>Billing</source>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

const PAY = rowIdOf('messages', 'pay');
const BILLING = rowIdOf('messages', 'billing');

let root: string;
let stateDir: string;
let app: FastifyInstance;
const sourcePath = () => join(root, 'messages.xlf');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-notes-')));
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
  await writeFile(sourcePath(), SOURCE, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), GERMAN, 'utf8');
  app = await buildApp(testConfig({ roots: [root], stateDir }), {
    logger: false,
    projects: new ProjectService(),
  });
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
});

const putNotes = (rowId: string, notes: unknown[]) =>
  app.inject({
    method: 'PUT',
    url: `/api/units/${encodeURIComponent(rowId)}/notes`,
    headers: goodHeaders(),
    payload: { notes },
  });

const detail = async (rowId: string): Promise<UnitDetail> =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    })
  ).json<UnitDetail>();

const project = async (): Promise<Project> =>
  (
    await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() })
  ).json<Project>();

const save = () =>
  app.inject({ method: 'POST', url: '/api/save', headers: goodHeaders(), payload: {} });

describe('PUT /api/units/:rowId/notes (FR-4.2)', () => {
  it('holds the edit in the overlay: the panel sees it, the file does not', async () => {
    const res = await putNotes(PAY, [{ from: 'description', text: 'The big checkout button.' }]);
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<NotesPutResponse>();
    expect(body.unsavedCount).toBe(1);
    expect(body.detail.notesPending).toBe(true);
    expect(body.detail.notes).toEqual([
      { from: 'description', priority: '1', text: 'The big checkout button.' },
    ]);

    expect(await readFile(sourcePath(), 'utf8')).toBe(SOURCE);
    expect((await detail(PAY)).notes[0]?.text).toBe('The big checkout button.');
  });

  it('says where notes go, and that it is the extraction template (FR-4.3c)', async () => {
    const d = await detail(PAY);
    expect(d.notesFile).toBe('messages.xlf');
    expect(d.notesFileIsTemplate).toBe(true);
  });

  it('writes a one-line change on save, and nothing else in the file moves', async () => {
    await putNotes(PAY, [{ from: 'description', text: 'The big checkout button.' }]);
    expect((await save()).statusCode).toBe(200);

    const after = await readFile(sourcePath(), 'utf8');
    expect(after).toBe(SOURCE.replace('>The checkout button.<', '>The big checkout button.<'));
    expect((await detail(PAY)).notesPending).toBe(false);
    expect((await project()).health.unitsWithNote).toBe(1);
  });

  it("adds a note in Angular's shape, and note coverage moves before any save", async () => {
    expect((await project()).health.unitsWithNote).toBe(1);
    await putNotes(BILLING, [{ from: 'description', text: 'Settings page heading' }]);
    expect((await project()).health.unitsWithNote).toBe(2);

    await save();
    expect(await readFile(sourcePath(), 'utf8')).toContain(
      '        <source>Billing</source>\n        <note priority="1" from="description">Settings page heading</note>\n      </trans-unit>',
    );
  });

  it('deletes a note, and a list equal to the file clears the pending edit', async () => {
    await putNotes(PAY, []);
    expect((await project()).health.unitsWithNote).toBe(0);
    const back = await putNotes(PAY, [{ from: 'description', text: 'The checkout button.' }]);
    expect(back.json<NotesPutResponse>().unsavedCount).toBe(0);
  });

  it('gives the model the edited note, not the one in the file', async () => {
    await putNotes(PAY, [{ from: 'description', text: 'Shown on the final order screen.' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt/preview',
      headers: goodHeaders(),
      payload: { rowId: PAY, locale: 'de' },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const user = res.json<PromptPreviewResponse>().blocks.find((b) => b.id === 'user');
    expect(user?.content).toContain('Shown on the final order screen.');
    expect(user?.content).not.toContain('The checkout button.');
  });

  it('refuses a `from` that could break out of its attribute', async () => {
    const res = await putNotes(PAY, [{ from: 'x" onload="y', text: 'hi' }]);
    expect(res.statusCode).toBe(400);
  });

  it('drops the edit when the file changes underneath it, and says so', async () => {
    await putNotes(PAY, [{ from: 'description', text: 'Mine.' }]);
    await writeFile(sourcePath(), SOURCE.replace('The checkout button.', 'Theirs.'), 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/reload',
      headers: goodHeaders(),
      payload: { paths: [sourcePath()] },
    });
    const body = res.json<FilesReloadResponse>();
    expect(body.dropped).toBe(1);
    expect(body.unsavedCount).toBe(0);
    expect((await detail(PAY)).notes[0]?.text).toBe('Theirs.');
  });
});
