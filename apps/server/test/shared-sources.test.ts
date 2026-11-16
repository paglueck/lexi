// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  LexiEvent,
  Project,
  SharedSourcesResponse,
  StyleGuide,
  StyleGuideListResponse,
  Term,
  TermBaseResponse,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import type { EventBus } from '../src/lib/event-bus.js';
import { readStyleGuides } from '../src/lib/styleguides.js';
import { ProjectService } from '../src/services/project-service.js';
import { SharedSourceWatcher } from '../src/services/shared-source-watcher.js';
import { sameTerms } from '../src/services/termbase.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * Style guides and the Term Base read from a shared folder outside `.lexi/`,
 * so several projects can share one Git repository of them.
 *
 * The properties that matter: a link REPLACES the project's own files for
 * reads and writes alike; it is machine-local; a project's old glossary is
 * never migrated into somebody else's repository; and two projects with
 * different locales can save the same file without re-sorting each other's
 * columns.
 */

const xlf = (targetLanguage: string | null): string => {
  const attr = targetLanguage === null ? '' : ` target-language="${targetLanguage}"`;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template"${attr}>
    <body>
      <trans-unit id="basket" datatype="html">
        <source>Your basket is empty</source>
      </trans-unit>
    </body>
  </file>
</xliff>
`;
};

let base: string;
let root: string;
let shared: string;
let outside: string;
let stateDir: string;
let projects: ProjectService;
let app: FastifyInstance;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-shared-')));
  root = join(base, 'app');
  shared = join(base, 'shared');
  outside = join(base, 'outside');
  stateDir = join(base, 'state');
});

afterAll(async () => {
  await app?.close();
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await app?.close();
  for (const dir of [root, shared, outside, stateDir]) {
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir(root, { recursive: true });
  await mkdir(join(shared, 'styleguides'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'messages.xlf'), xlf('en-GB'), 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), xlf('de'), 'utf8');
  await writeFile(join(root, 'messages.fr.xlf'), xlf('fr'), 'utf8');

  projects = new ProjectService();
  // `outside` is deliberately NOT a root: it stands for a folder the jail refuses.
  app = await buildApp(testConfig({ roots: [root, shared], stateDir }), {
    logger: false,
    projects,
  });
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
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Project>();
}

const link = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/shared-sources', headers: goodHeaders(), payload });

const linkOk = async (payload: Record<string, unknown>): Promise<SharedSourcesResponse> => {
  const res = await link(payload);
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<SharedSourcesResponse>();
};

const termBase = async (): Promise<TermBaseResponse> => {
  const res = await app.inject({ method: 'GET', url: '/api/termbase', headers: goodHeaders() });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<TermBaseResponse>();
};

const addTerm = async (term: Record<string, unknown>): Promise<Term> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/termbase',
    headers: goodHeaders(),
    payload: term,
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Term>();
};

const putGuide = (key: string, text: string) =>
  app.inject({
    method: 'PUT',
    url: `/api/styleguides/${key}`,
    headers: goodHeaders(),
    payload: { text },
  });

const guides = async (): Promise<StyleGuideListResponse> => {
  const res = await app.inject({ method: 'GET', url: '/api/styleguides', headers: goodHeaders() });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<StyleGuideListResponse>();
};

const localSettings = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, '.lexi', 'settings.local.json'), 'utf8')) as Record<
    string,
    unknown
  >;

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* -- the link itself ------------------------------------------------------- */

describe('linking a shared folder', () => {
  it('starts unlinked and stores a link machine-locally', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/shared-sources',
      headers: goodHeaders(),
    });
    expect(before.json<SharedSourcesResponse>()).toEqual({
      styleguides: { path: null, available: true },
      termbase: { path: null, available: true },
    });

    const after = await linkOk({ termbase: shared, styleguides: join(shared, 'styleguides') });
    expect(after.termbase).toEqual({ path: shared, available: true });
    expect(after.styleguides).toEqual({ path: join(shared, 'styleguides'), available: true });

    const stored = await localSettings();
    expect(stored['sharedSources']).toEqual({
      termbase: shared,
      styleguides: join(shared, 'styleguides'),
    });
    // ...and that file is the one `.lexi/.gitignore` already keeps out of Git.
    expect(await readFile(join(root, '.lexi', '.gitignore'), 'utf8')).toContain(
      'settings.local.json',
    );
  });

  it('keeps the other link and every unrelated key of settings.local.json', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(join(root, '.lexi', 'settings.local.json'), '{"mine":"keep me"}', 'utf8');

    await linkOk({ termbase: shared });
    const res = await linkOk({ styleguides: join(shared, 'styleguides') });
    expect(res.termbase.path).toBe(shared);

    const unlinked = await linkOk({ termbase: null });
    expect(unlinked.termbase.path).toBeNull();
    expect(unlinked.styleguides.path).toBe(join(shared, 'styleguides'));

    const stored = await localSettings();
    expect(stored['mine']).toBe('keep me');
  });

  it.each([
    ['a relative path', 'shared'],
    ['a missing folder', '/definitely/not/here'],
  ])('refuses %s', async (_label, path) => {
    const res = await link({ termbase: path });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('refuses a file and a folder outside the jail', async () => {
    await writeFile(join(shared, 'termbase.csv'), 'id,term,note,dnt\r\n', 'utf8');
    expect((await link({ termbase: join(shared, 'termbase.csv') })).statusCode).toBe(400);
    expect((await link({ termbase: outside })).statusCode).toBe(403);
  });

  it('refuses unknown keys rather than silently not linking', async () => {
    expect((await link({ glossary: shared })).statusCode).toBe(400);
  });

  it('reads a corrupt settings.local.json as unlinked', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(join(root, '.lexi', 'settings.local.json'), '{not json', 'utf8');
    expect((await termBase()).linked).toBe(false);
    expect((await guides()).linked).toBe(false);
  });
});

/* -- the term base --------------------------------------------------------- */

describe('a linked Term Base', () => {
  it('replaces .lexi/termbase.csv for reads and writes', async () => {
    await addTerm({ term: 'Local' });
    await linkOk({ termbase: shared });

    const res = await termBase();
    expect(res).toMatchObject({ total: 0, linked: true, available: true });
    expect(res.path).toBe(join(shared, 'termbase.csv'));

    await addTerm({ term: 'Shared', translations: { de: 'Geteilt' } });
    const sharedCsv = await readFile(join(shared, 'termbase.csv'), 'utf8');
    expect(sharedCsv).toContain('Shared');
    expect(sharedCsv).not.toContain('Local');
    // The project's own file is left exactly as it was.
    const localCsv = await readFile(join(root, '.lexi', 'termbase.csv'), 'utf8');
    expect(localCsv).toContain('Local');
    expect(localCsv).not.toContain('Shared');

    // The validator's in-memory copy follows the link too.
    expect(projects.current?.glossary.map((t) => t.term)).toEqual(['Shared']);

    await linkOk({ termbase: null });
    expect((await termBase()).terms.map((t) => t.term)).toEqual(['Local']);
    expect(projects.current?.glossary.map((t) => t.term)).toEqual(['Local']);
  });

  it('does not migrate the legacy glossary into the shared folder', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'glossary.json'),
      JSON.stringify({ terms: [{ term: 'Legacy', translations: {} }] }),
      'utf8',
    );
    await linkOk({ termbase: shared });

    expect((await termBase()).total).toBe(0);
    expect(await readdir(shared)).not.toContain('termbase.csv');
  });

  it("keeps another project's column order and locales when saving", async () => {
    // Written by a project whose locales are `it` and `fr`, in that order.
    await writeFile(
      join(shared, 'termbase.csv'),
      'id,term,note,dnt,it,fr\r\nt1,Basket,,no,Carrello,Panier\r\n',
      'utf8',
    );
    await linkOk({ termbase: shared });

    await addTerm({ term: 'Pay', translations: { de: 'Bezahlen', fr: 'Payer' } });
    const [header, ...rows] = (await readFile(join(shared, 'termbase.csv'), 'utf8'))
      .trim()
      .split('\r\n');
    expect(header).toBe('id,term,note,dnt,it,fr,de');
    expect(rows.find((r) => r.startsWith('t1,'))).toBe('t1,Basket,,no,Carrello,Panier,');
  });

  it('reports a linked folder that has gone missing, and refuses to write into it', async () => {
    await linkOk({ termbase: shared });
    await rm(shared, { recursive: true, force: true });

    expect(await termBase()).toMatchObject({ total: 0, linked: true, available: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/termbase',
      headers: goodHeaders(),
      payload: { term: 'Nope' },
    });
    expect(res.statusCode).toBe(409);
    // Not recreated: that is where the shared repository should be checked out.
    await expect(readdir(shared)).rejects.toThrow();
  });
});

/* -- the style guides ------------------------------------------------------ */

describe('a linked style guide folder', () => {
  it('replaces .lexi/styleguides for reads, writes and the prompt', async () => {
    expect((await putGuide('de', 'Local guide')).statusCode).toBe(200);
    await writeFile(join(shared, 'styleguides', 'global.md'), 'Shared global\n', 'utf8');
    await linkOk({ styleguides: join(shared, 'styleguides') });

    const list = await guides();
    expect(list).toMatchObject({ linked: true, available: true });
    expect(list.dir).toBe(join(shared, 'styleguides'));
    expect(list.guides.map((g) => g.key)).toEqual(['global']);

    const res = await putGuide('de', 'Shared German');
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json<StyleGuide>().exists).toBe(true);
    expect(await readFile(join(shared, 'styleguides', 'de.md'), 'utf8')).toBe('Shared German\n');
    expect(await readFile(join(root, '.lexi', 'styleguides', 'de.md'), 'utf8')).toBe(
      'Local guide\n',
    );

    // What a translation run reads.
    const forPrompt = await readStyleGuides(root, 'de');
    expect(forPrompt.global?.text).toBe('Shared global');
    expect(forPrompt.locale?.text).toBe('Shared German');

    await linkOk({ styleguides: null });
    expect((await readStyleGuides(root, 'de')).locale?.text).toBe('Local guide');
  });

  it('reports a missing linked folder as no guides, and refuses to recreate it', async () => {
    await linkOk({ styleguides: join(shared, 'styleguides') });
    await rm(join(shared, 'styleguides'), { recursive: true, force: true });

    expect(await guides()).toMatchObject({ guides: [], linked: true, available: false });
    expect((await putGuide('de', 'Nope')).statusCode).toBe(409);
    await expect(readdir(join(shared, 'styleguides'))).rejects.toThrow();
  });
});

/* -- keeping in step ------------------------------------------------------- */

class RecordingBus {
  readonly events: LexiEvent[] = [];
  publish(event: LexiEvent): void {
    this.events.push(event);
  }
  sources(): string[] {
    return this.events.flatMap((e) => (e.type === 'shared-source-changed' ? [e.source] : []));
  }
}

describe('the shared source watcher', () => {
  let watcher: SharedSourceWatcher | undefined;
  afterEach(() => watcher?.stop());

  const start = async (): Promise<RecordingBus> => {
    const bus = new RecordingBus();
    watcher = new SharedSourceWatcher({
      projects,
      bus: bus as unknown as EventBus,
      debounceMs: 20,
    });
    await watcher.watchProject(root);
    return bus;
  };

  it('reloads the glossary and announces a Term Base changed elsewhere', async () => {
    await linkOk({ termbase: shared });
    const bus = await start();

    await writeFile(
      join(shared, 'termbase.csv'),
      'id,term,note,dnt,de\r\nt1,Basket,,no,Warenkorb\r\n',
      'utf8',
    );
    await waitFor(() => bus.sources().includes('termbase'));

    expect(bus.sources()).toEqual(['termbase']);
    expect(projects.current?.glossary.map((t) => t.term)).toEqual(['Basket']);
  });

  it('stays silent about a Term Base save made here', async () => {
    await linkOk({ termbase: shared });
    const bus = await start();

    await addTerm({ term: 'Ours', translations: { de: 'Unser' }, note: 'n' });
    // FSEvents can take a while to deliver; give our own write ample time to echo.
    await new Promise((r) => setTimeout(r, 1500));
    expect(bus.sources()).toEqual([]);
  });

  it('announces a guide changed elsewhere, but not one saved here', async () => {
    await linkOk({ styleguides: join(shared, 'styleguides') });
    const bus = await start();

    expect((await putGuide('de', 'Ours')).statusCode).toBe(200);
    await watcher?.remember();
    await new Promise((r) => setTimeout(r, 300));
    expect(bus.sources()).toEqual([]);

    await writeFile(join(shared, 'styleguides', 'fr.md'), 'Theirs\n', 'utf8');
    await waitFor(() => bus.sources().includes('styleguides'));
    expect(bus.sources()).toEqual(['styleguides']);
  });
});

describe('sameTerms', () => {
  it('ignores key order and translation order', () => {
    const created = {
      id: 'a',
      term: 'T',
      translations: { fr: 'f', de: 'd' },
      dnt: false,
      note: '',
    };
    const read = { id: 'a', term: 'T', note: '', dnt: false, translations: { de: 'd', fr: 'f' } };
    expect(sameTerms([created], [read])).toBe(true);
    expect(sameTerms([created], [{ ...read, note: 'x' }])).toBe(false);
  });
});
