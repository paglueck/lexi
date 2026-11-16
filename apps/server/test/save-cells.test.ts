// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rowIdOf, type EditSegmentDto, type LexiEvent } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import type { EventBus } from '../src/lib/event-bus.js';
import { saveProject } from '../src/lib/save.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * The cell-scoped save the CSV import writes through (Task 7).
 *
 * The promise under test is the one the import makes to a translator with
 * unsaved work: ONLY the imported cells reach the disk, and every other pending
 * edit is still pending afterwards — including one in the very file that was
 * just rewritten. The later full save is the proof that those survivors are
 * still writable, byte for byte, rather than merely still listed.
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

const unit = (id: string, source: string, target?: string, note?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}${note === undefined ? '' : `\n        <note priority="1" from="description">${note}</note>`}
      </trans-unit>`;

const sourceXlf = xlf(
  'en-GB',
  [
    unit('a', 'Pay now', undefined, 'Button label'),
    unit('b', `You have ${INTERP} invoices`),
    unit('c', 'Newly added string'),
  ].join('\n'),
);

/** `c` is not in Dutch yet, so a PATCH on it is a pending CREATE. */
const nlXlf = xlf(
  'nl',
  [
    unit('a', 'Pay now', 'Nu betalen'),
    unit('b', `You have ${INTERP} invoices`, `U hebt ${INTERP} facturen`),
  ].join('\n'),
);

const deXlf = xlf(
  'de',
  [unit('a', 'Pay now', 'Jetzt bezahlen'), unit('b', `You have ${INTERP} invoices`, 'alt')].join(
    '\n',
  ),
);

let root: string;
let stateDir: string;
let cfg: ServerConfig;
let app: FastifyInstance;
let projects: ProjectService;
let events: LexiEvent[];
let bus: EventBus;

const NL = (): string => join(root, 'messages.nl.xlf');
const DE = (): string => join(root, 'messages.de.xlf');
const SRC = (): string => join(root, 'messages.xlf');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-save-cells-')));
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
  await writeFile(SRC(), sourceXlf, 'utf8');
  await writeFile(NL(), nlXlf, 'utf8');
  await writeFile(DE(), deXlf, 'utf8');

  cfg = testConfig({ roots: [root], stateDir });
  projects = new ProjectService();
  app = await buildApp(cfg, { logger: false, projects });
  events = [];
  // Only `publish` is reached by a save; a real bus would need SSE clients.
  bus = { publish: (event: LexiEvent) => events.push(event) } as unknown as EventBus;

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
  expect(opened.statusCode).toBe(200);
});

const row = (unitId: string): string => rowIdOf('messages', unitId);

async function patch(unitId: string, locale: string, segments: EditSegmentDto[]): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/units/${encodeURIComponent(row(unitId))}/targets/${locale}`,
    headers: goodHeaders(),
    payload: { segments },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const text = (v: string): EditSegmentDto => ({ k: 't', v });
const ph = (id: string): EditSegmentDto => ({ k: 'p', id });

describe('saveProject with cells', () => {
  it('writes only the named cell, keeps same-file edits pending, and a later full save writes them', async () => {
    // `a` grows by a lot so every span after it in the file moves.
    await patch('a', 'nl', [text('Nu meteen en zonder uitstel betalen, alstublieft')]);
    await patch('b', 'nl', [text('Je hebt '), ph('INTERPOLATION'), text(' rekeningen')]);
    await patch('c', 'nl', [text('Nieuw toegevoegde tekst')]);
    expect(projects.unsavedCount).toBe(3);

    const res = await saveProject(cfg, projects, bus, {
      cells: [{ rowId: row('a'), locale: 'nl' }],
    });

    const nl = await readFile(NL(), 'utf8');
    expect(nl).toContain('<target>Nu meteen en zonder uitstel betalen, alstublieft</target>');
    expect(nl).toContain(`<target>U hebt ${INTERP} facturen</target>`);
    expect(nl).not.toContain('Nieuw toegevoegde tekst');
    expect(res.written).toEqual([NL()]);
    expect(res.unsavedCount).toBe(2);
    expect(projects.unsavedCount).toBe(2);
    expect(projects.pendingFor(row('a'), 'nl')).toBeUndefined();
    expect(projects.pendingFor(row('b'), 'nl')).toBeDefined();
    expect(projects.pendingFor(row('c'), 'nl')?.create).toBe(true);
    expect(events.filter((e) => e.type === 'save-complete')).toHaveLength(1);

    // drafts.json reflects what is still pending, not what was just written.
    const drafts = JSON.parse(await readFile(join(root, '.lexi', 'drafts.json'), 'utf8')) as {
      drafts: Array<{ rowId: string; locale: string }>;
    };
    expect(drafts.drafts.map((d) => d.rowId).sort()).toEqual([row('b'), row('c')]);

    // The row model was rebuilt from the rewritten file; the survivor must still
    // be what the panel AND the index (filters, facets, dashboard) show.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(row('b'))}`,
      headers: goodHeaders(),
    });
    expect(detail.body).toContain('rekeningen');
    expect(projects.index?.byRowId.get(row('b'))?.cells.get('nl')?.targetLower).toBe(
      'je hebt  rekeningen',
    );

    // The later full save writes the survivors into the rewritten file.
    const full = await saveProject(cfg, projects, bus, {});
    expect(full.unsavedCount).toBe(0);
    const after = await readFile(NL(), 'utf8');
    expect(after).toBe(
      xlf(
        'nl',
        [
          unit('a', 'Pay now', 'Nu meteen en zonder uitstel betalen, alstublieft'),
          unit('b', `You have ${INTERP} invoices`, `Je hebt ${INTERP} rekeningen`),
          unit('c', 'Newly added string', 'Nieuw toegevoegde tekst'),
        ].join('\n'),
      ),
    );
  });

  it('leaves other files and pending notes alone, even when they share the save', async () => {
    await patch('a', 'nl', [text('Nu betalen!')]);
    await patch('a', 'de', [text('Sofort bezahlen')]);
    const notes = await app.inject({
      method: 'PUT',
      url: `/api/units/${encodeURIComponent(row('a'))}/notes`,
      headers: goodHeaders(),
      payload: { notes: [{ from: 'description', text: 'Primary checkout button' }] },
    });
    expect(notes.statusCode, notes.body).toBe(200);
    expect(projects.unsavedCount).toBe(3);

    const res = await saveProject(cfg, projects, bus, {
      cells: [{ rowId: row('a'), locale: 'nl' }],
    });

    expect(res.written).toEqual([NL()]);
    expect(await readFile(DE(), 'utf8')).toBe(deXlf);
    expect(await readFile(SRC(), 'utf8')).toBe(sourceXlf);
    expect(projects.unsavedCount).toBe(2);
    expect(projects.pendingFor(row('a'), 'de')).toBeDefined();
    expect(projects.pendingNotesFor(row('a'))).toBeDefined();
  });

  it('writes nothing for a cell that has no pending edit, but still reports the save', async () => {
    await patch('b', 'nl', [text('Je hebt '), ph('INTERPOLATION'), text(' rekeningen')]);

    const res = await saveProject(cfg, projects, bus, {
      cells: [{ rowId: row('a'), locale: 'nl' }],
    });

    expect(res.written).toEqual([]);
    expect(await readFile(NL(), 'utf8')).toBe(nlXlf);
    expect(projects.unsavedCount).toBe(1);
    expect(events.filter((e) => e.type === 'save-complete')).toHaveLength(1);
  });

  it('keeps a surviving copy-source edit byte-identical through a cell save', async () => {
    // Copy-source keeps the source's own escaped bytes (`&#160;`, not a literal
    // NBSP). A cell save that re-cut the survivors from wire segments would
    // decode and re-escape that text, so the later full save would differ.
    await writeFile(
      SRC(),
      xlf('en-GB', [unit('a', 'Pay now'), unit('n', 'Ten&#160;EUR')].join('\n')),
      'utf8',
    );
    await writeFile(
      NL(),
      xlf('nl', [unit('a', 'Pay now', 'Nu betalen'), unit('n', 'Ten&#160;EUR', 'oud')].join('\n')),
      'utf8',
    );
    const reload = await app.inject({
      method: 'POST',
      url: '/api/files/reload',
      headers: goodHeaders(),
      payload: { paths: [] },
    });
    expect(reload.statusCode, reload.body).toBe(200);

    await patch('a', 'nl', [text('Nu meteen betalen')]);
    const copied = await app.inject({
      method: 'POST',
      url: `/api/units/${encodeURIComponent(row('n'))}/targets/nl/copy-source`,
      headers: goodHeaders(),
    });
    expect(copied.statusCode, copied.body).toBe(200);

    await saveProject(cfg, projects, bus, { cells: [{ rowId: row('a'), locale: 'nl' }] });
    expect(projects.pendingFor(row('n'), 'nl')).toBeDefined();
    await saveProject(cfg, projects, bus, {});

    expect(await readFile(NL(), 'utf8')).toBe(
      xlf(
        'nl',
        [unit('a', 'Pay now', 'Nu meteen betalen'), unit('n', 'Ten&#160;EUR', 'Ten&#160;EUR')].join(
          '\n',
        ),
      ),
    );
  });

  it('inserts a named cell that is a pending create and leaves the rest pending', async () => {
    await patch('a', 'nl', [text('Nu meteen betalen')]);
    await patch('c', 'nl', [text('Nieuw toegevoegde tekst')]);
    expect(projects.pendingFor(row('c'), 'nl')?.create).toBe(true);

    const res = await saveProject(cfg, projects, bus, {
      cells: [{ rowId: row('c'), locale: 'nl' }],
    });

    expect(res.written).toEqual([NL()]);
    expect(await readFile(NL(), 'utf8')).toBe(
      xlf(
        'nl',
        [
          unit('a', 'Pay now', 'Nu betalen'),
          unit('b', `You have ${INTERP} invoices`, `U hebt ${INTERP} facturen`),
          unit('c', 'Newly added string', 'Nieuw toegevoegde tekst'),
        ].join('\n'),
      ),
    );
    expect(projects.pendingFor(row('c'), 'nl')).toBeUndefined();
    expect(projects.pendingFor(row('a'), 'nl')).toBeDefined();
    expect(projects.unsavedCount).toBe(1);
  });
});
