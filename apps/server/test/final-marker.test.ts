// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rowIdOf, type UnitDetail, type UnitTarget } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { finalMarkersOf, readFinalMarkers, writeFinalMarkers } from '../src/lib/final-marker.js';
import { originKey, targetHash } from '../src/lib/machine-origin.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * `.lexi/final.json`: an imported `final` that survives in a file with no
 * `state` attributes, for exactly as long as the target's bytes are unchanged.
 */

const unit = (id: string, source: string, target: string, state = ''): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>
        <target${state}>${target}</target>
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

const sourceXlf = xlf('en-GB', unit('pay', 'Pay now', 'Pay now'));
const plainDe = xlf('de', unit('pay', 'Pay now', 'Jetzt bezahlen'));
const stateDe = xlf('de', unit('pay', 'Pay now', 'Jetzt bezahlen', ' state="translated"'));

const PAY = rowIdOf('messages', 'pay');
const marker = (text: string) => ({
  hash: targetHash(text),
  at: '2026-10-20T10:00:00.000Z',
  importId: 'imp-1',
});

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-final-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

/** Fresh project with `de` as given and, optionally, a marker on disk before open. */
async function openWith(de: string, finalText?: string): Promise<void> {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), de, 'utf8');
  if (finalText !== undefined) {
    const cfg = testConfig({ roots: [root], stateDir });
    await writeFinalMarkers(cfg, root, new Map([[originKey(PAY, 'de'), marker(finalText)]]));
  }

  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
  const scan = await app.inject({
    method: 'POST',
    url: '/api/projects/scan',
    headers: goodHeaders(),
    payload: { path: root },
  });
  const files = scan.json<{
    files: Array<{ path: string; fileIndex: number; locale: string | null }>;
  }>().files;
  await app.inject({
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
}

const deOf = async (): Promise<UnitTarget> =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(PAY)}`,
      headers: goodHeaders(),
    })
  )
    .json<UnitDetail>()
    .targets.find((t) => t.locale === 'de') as UnitTarget;

describe('final marker', () => {
  beforeEach(() => {
    projects = new ProjectService();
  });

  it('reads back as final in a file with no state attributes', async () => {
    await openWith(plainDe, 'Jetzt bezahlen');
    expect(projects.finalMarkers.has(originKey(PAY, 'de'))).toBe(true);
    expect((await deOf()).state).toBe('final');
  });

  it('is retired when the target bytes change on disk', async () => {
    await openWith(plainDe, 'Jetzt bezahlen');
    await writeFile(join(root, 'messages.de.xlf'), plainDe.replace('Jetzt', 'Sofort'), 'utf8');
    await projects.reloadDocument(join(root, 'messages.de.xlf'));
    projects.rebuildIndex();
    expect((await deOf()).state).toBe('reviewed');
  });

  it('is still believed in a file that writes state', async () => {
    await openWith(stateDe, 'Jetzt bezahlen');
    expect((await deOf()).state).toBe('final');
  });

  it('round-trips through .lexi/final.json in the group-nested shape', async () => {
    await openWith(plainDe);
    projects.setFinalMarker(PAY, 'de', marker('Jetzt bezahlen'));
    const cfg = testConfig({ roots: [root], stateDir });
    await writeFinalMarkers(cfg, root, projects.finalMarkers);
    const raw = JSON.parse(await readFile(join(root, '.lexi', 'final.json'), 'utf8')) as {
      version: number;
      groups: { messages: { pay: { de: { importId: string } } } };
    };
    expect(raw.version).toBe(1);
    expect(raw.groups.messages.pay.de.importId).toBe('imp-1');
    expect(await readFinalMarkers(root)).toEqual(projects.finalMarkers);
    expect(projects.clearFinalMarker(PAY, 'de')).toBe(true);
    expect(projects.clearFinalMarker(PAY, 'de')).toBe(false);
  });

  it('survives a discard over the cell: the file state is still final', async () => {
    await openWith(plainDe, 'Jetzt bezahlen');
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(PAY)}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Eins' }] },
    });
    expect(edit.statusCode).toBe(200);
    expect((await deOf()).state).not.toBe('final');

    const res = await app.inject({
      method: 'POST',
      url: '/api/drafts/discard',
      headers: goodHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((await deOf()).state).toBe('final');

  });

  it('survives an undo back to the file: the file state is still final', async () => {
    await openWith(plainDe, 'Jetzt bezahlen');
    await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(PAY)}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Eins' }] },
    });
    const undone = await app.inject({
      method: 'POST',
      url: '/api/history/undo',
      headers: goodHeaders(),
    });
    expect(undone.statusCode).toBe(200);
    expect((await deOf()).state).toBe('final');
  });

  it('skips damaged branches of the file without throwing, keeping valid siblings', () => {
    const good = marker('x');
    expect(finalMarkersOf([])).toEqual(new Map());
    expect(finalMarkersOf({ groups: [] })).toEqual(new Map());
    for (const bad of [null, 5, [], { u: 5 }, { u: null }, { u: [] }, { u: { de: 'no' } }]) {
      const got = finalMarkersOf({
        groups: { bad, messages: { pay: { de: good } } },
      });
      expect([...got.keys()]).toEqual([originKey(PAY, 'de')]);
    }
  });
});
