// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project, ProjectScanResponse } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * S1 and S2's server half: FR-1.1 (recursive scan), FR-1.2 (filename beats
 * target-language), FR-1.2a (the extraction template), FR-1.2b (the stale
 * attribute and its fix), FR-1.3 (the confirmed mapping wins) and FR-1.8
 * (`.lexi/` written into the user's own repository).
 *
 * The fixture is a miniature Angular locale folder rather than the engine's
 * corpus, because what is under test here is the walk and the correlation, and
 * both need real directories.
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

const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${
          target === undefined
            ? ''
            : `
        <target state="translated">${target}</target>`
        }
      </trans-unit>`;

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-projects-')));
  root = join(base, 'northwind');
  stateDir = join(base, 'state');

  await mkdir(join(root, 'checkout'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });

  // The extraction template: languages agree, nothing has a target.
  await writeFile(
    join(root, 'messages.xlf'),
    xlf('en-GB', [unit('a', 'Pay now'), unit('b', 'Billing')].join('\n')),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf('de', [unit('a', 'Pay now', 'Jetzt bezahlen'), unit('b', 'Billing')].join('\n')),
    'utf8',
  );
  // FR-1.2b: filename says pt-BR, the copied attribute still says pt.
  await writeFile(
    join(root, 'messages.pt-BR.xlf'),
    xlf('pt', [unit('a', 'Pay now', 'Pagar agora')].join('\n')),
    'utf8',
  );
  await writeFile(join(root, 'messages.ar.xlf'), xlf('ar', unit('a', 'Pay now', 'ادفع')), 'utf8');
  await writeFile(
    join(root, 'checkout', 'messages.pl.xlf'),
    xlf('pl', unit('c', 'Free shipping')),
    'utf8',
  );
  // Must never be walked into.
  await writeFile(
    join(root, 'node_modules', 'junk', 'messages.es.xlf'),
    xlf('es', unit('z', 'x')),
    'utf8',
  );
  // Not XLIFF.
  await writeFile(join(root, 'README.md'), '# not xliff\n', 'utf8');
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

const scan = (path: string = root) =>
  app.inject({
    method: 'POST',
    url: '/api/projects/scan',
    headers: goodHeaders(),
    payload: { path },
  });

describe('POST /api/projects/scan', () => {
  it('finds every .xlf recursively and ignores node_modules (FR-1.1)', async () => {
    const res = await scan();
    expect(res.statusCode).toBe(200);
    const body = res.json<ProjectScanResponse>();

    expect(body.files.map((f) => f.relPath)).toEqual([
      'checkout/messages.pl.xlf',
      'messages.ar.xlf',
      'messages.de.xlf',
      'messages.pt-BR.xlf',
      'messages.xlf',
    ]);
  });

  it('detects the locale from the filename and says so (FR-1.2)', async () => {
    const body = (await scan()).json<ProjectScanResponse>();
    const de = body.files.find((f) => f.relPath === 'messages.de.xlf')!;
    expect(de).toMatchObject({ locale: 'de', localeSource: 'filename', unitCount: 2 });
  });

  it('identifies the extraction template and proposes its language (FR-1.2a)', async () => {
    const body = (await scan()).json<ProjectScanResponse>();
    expect(body.files.filter((f) => f.isTemplate).map((f) => f.relPath)).toEqual(['messages.xlf']);
    expect(body.suggestedSourceLocale).toBe('en-GB');
  });

  /** The single most valuable thing the wizard shows. */
  it('reports the stale target-language rather than resolving it (FR-1.2b)', async () => {
    const body = (await scan()).json<ProjectScanResponse>();
    const ptBr = body.files.find((f) => f.relPath === 'messages.pt-BR.xlf')!;
    expect(ptBr).toMatchObject({
      locale: 'pt-BR',
      localeSource: 'filename',
      conflictingTargetLanguage: 'pt',
    });
    expect(body.files.filter((f) => f.conflictingTargetLanguage !== null)).toHaveLength(1);
  });

  it('groups the split feature module apart from the root files (FR-1.4)', async () => {
    const body = (await scan()).json<ProjectScanResponse>();
    const groups = new Map(body.files.map((f) => [f.relPath, f.group]));
    expect(groups.get('messages.de.xlf')).toBe('messages');
    expect(groups.get('messages.xlf')).toBe('messages');
    expect(groups.get('checkout/messages.pl.xlf')).toBe('checkout/messages');
  });

  it('marks an RTL locale, for the wizard badge and the editor direction', async () => {
    const body = (await scan()).json<ProjectScanResponse>();
    expect(body.files.find((f) => f.relPath === 'messages.ar.xlf')!.isRtl).toBe(true);
    expect(body.files.find((f) => f.relPath === 'messages.de.xlf')!.isRtl).toBe(false);
  });

  it('refuses a path outside the granted roots', async () => {
    const res = await scan('/etc');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('rejects a missing path with a 400 envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/scan',
      headers: goodHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });
});

const openWith = async (over: Partial<{ sourceLocale: string; fix: boolean }> = {}) => {
  const scanned = (await scan()).json<ProjectScanResponse>();
  return app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: over.sourceLocale ?? 'en-GB',
      mapping: scanned.files
        .filter((f) => f.locale !== null)
        .map((f) => ({
          path: f.path,
          fileIndex: f.fileIndex,
          locale: f.locale,
          fixTargetLanguage: over.fix === true && f.conflictingTargetLanguage !== null,
        })),
    },
  });
};

describe('POST /api/projects/open', () => {
  it('opens the project and reports per-locale counts', async () => {
    const res = await openWith();
    expect(res.statusCode).toBe(200);
    const body = res.json<Project>();

    expect(body.name).toBe('northwind');
    expect(body.sourceLocale).toBe('en-GB');
    // TARGET locales only: en-GB is the source, and a progress row for it could
    // only ever read "0 translated", which is false rather than uninteresting.
    expect(body.locales.map((l) => l.locale)).toEqual(['ar', 'de', 'pl', 'pt-BR']);

    const de = body.locales.find((l) => l.locale === 'de')!;
    expect(de).toMatchObject({ unitCount: 2, translated: 1, untranslated: 1 });
  });

  it('flips projectOpen on the health probe', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() });
    expect(before.json()).toMatchObject({ projectOpen: false });

    await openWith();
    const after = await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() });
    expect(after.json()).toMatchObject({ projectOpen: true });
  });

  it('writes .lexi/ with a .gitignore covering the private entries (FR-1.8)', async () => {
    await openWith();

    const project = JSON.parse(await readFile(join(root, '.lexi', 'project.json'), 'utf8')) as {
      version: number;
      sourceLocale: string;
    };
    expect(project).toMatchObject({ version: 1, sourceLocale: 'en-GB' });

    // The reason this matters: settings.local.json will hold an API key.
    const gitignore = await readFile(join(root, '.lexi', '.gitignore'), 'utf8');
    expect(gitignore).toContain('settings.local.json');
    expect(gitignore).toContain('logs/');
  });

  /** Phase-2 groundwork: a hash not written now cannot be recovered later. */
  it('writes sources.json so FR-2.5b drift detection stays possible', async () => {
    await openWith();
    const sources = JSON.parse(await readFile(join(root, '.lexi', 'sources.json'), 'utf8')) as {
      version: number;
      groups: Record<string, Record<string, { hash: string }>>;
    };
    expect(sources.version).toBe(2);
    // Nested by group, because a unit id is unique within a file group and not
    // within a project (FR-1.4) — flat, two files' `pay` overwrite each other.
    expect(sources.groups['messages']?.['a']?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads back the M4 bare-hash shape without reporting false drift', async () => {
    // `sources.json` is committed, so a teammate's file may predate M5's
    // widening. Treating the old shape as unreadable would mark every unit in
    // the project as stale on the first open after an upgrade.
    await openWith();
    const file = join(root, '.lexi', 'sources.json');
    const widened = JSON.parse(await readFile(file, 'utf8')) as {
      groups: Record<string, Record<string, { hash: string }>>;
    };
    const legacy = Object.fromEntries(
      Object.entries(widened.groups['messages'] ?? {}).map(([id, rec]) => [id, rec.hash]),
    );
    await writeFile(file, JSON.stringify(legacy), 'utf8');

    await openWith();
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: { filters: ['stale'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });

  it('records the project in recents (FR-1.7)', async () => {
    await openWith();
    const res = await app.inject({ method: 'GET', url: '/api/recents', headers: goodHeaders() });
    expect(res.json()).toMatchObject({ recents: [{ name: 'northwind', path: root }] });
  });

  it('rejects a mapping row that names a file the scan never saw', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      headers: goodHeaders(),
      payload: {
        path: root,
        sourceLocale: 'en-GB',
        mapping: [{ path: join(root, 'nope.xlf'), fileIndex: 0, locale: 'de' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the "Fix to pt-BR" action (FR-1.2b)', () => {
  it('rewrites target-language and leaves every other byte alone (NFR-8)', async () => {
    const path = join(root, 'messages.pt-BR.xlf');
    const before = await readFile(path, 'utf8');
    expect(before).toContain('target-language="pt"');

    await openWith({ fix: true });

    const after = await readFile(path, 'utf8');
    expect(after).toContain('target-language="pt-BR"');

    // The whole claim, made precisely: exactly one line differs.
    const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
    expect(changed).toHaveLength(1);

    // Restore, so the fixture is reusable across tests.
    await writeFile(path, before, 'utf8');
  });

  it('leaves the file untouched when no fix was requested', async () => {
    const path = join(root, 'messages.pt-BR.xlf');
    const before = await readFile(path, 'utf8');
    await openWith({ fix: false });
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

describe('GET / PATCH /api/project', () => {
  it('404s with an envelope while nothing is open', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns the open project', async () => {
    await openWith();
    const res = await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json<Project>().name).toBe('northwind');
  });

  it('changes the source locale and persists it (FR-2.1)', async () => {
    await openWith();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/project',
      headers: goodHeaders(),
      payload: { sourceLocale: 'de' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Project>().sourceLocale).toBe('de');

    const persisted = JSON.parse(await readFile(join(root, '.lexi', 'project.json'), 'utf8')) as {
      sourceLocale: string;
    };
    expect(persisted.sourceLocale).toBe('de');
  });
});

describe('POST /api/project/close', () => {
  it('puts the server back to having no project open', async () => {
    await openWith();

    const res = await app.inject({
      method: 'POST',
      url: '/api/project/close',
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });
    expect(after.statusCode).toBe(404);
  });

  it('is a no-op when nothing is open, rather than a 404', async () => {
    // The button that closes a project is the same button whatever the state,
    // and a client that closes twice has done nothing wrong.
    const res = await app.inject({
      method: 'POST',
      url: '/api/project/close',
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('recents', () => {
  it('is empty before anything is opened', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recents', headers: goodHeaders() });
    expect(res.json()).toEqual({ recents: [] });
  });

  it('forgets one entry and 404s on the second attempt', async () => {
    await openWith();
    const { recents } = (
      await app.inject({ method: 'GET', url: '/api/recents', headers: goodHeaders() })
    ).json<{
      recents: Array<{ id: string }>;
    }>();
    const id = recents[0]!.id;

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/recents/${id}`,
      headers: goodHeaders(),
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/recents/${id}`,
      headers: goodHeaders(),
    });
    expect(second.statusCode).toBe(404);
  });
});

/**
 * A fresh `lexi` lands in the project it was last closed on, from the mapping
 * `.lexi/project.json` saved — no wizard. Each test boots a SECOND app against
 * the same state dir, which is what a restart is.
 */
describe('reopening the last project at boot', () => {
  let rebooted: FastifyInstance | undefined;

  afterEach(async () => {
    await rebooted?.close();
    rebooted = undefined;
  });

  /** `showMenu` is the S17 launch menu: while it is on, the menu picks, not the boot. */
  const reboot = async (restoreLastProject = true, showMenu = false): Promise<FastifyInstance> => {
    await app.close();
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ version: 1, launch: { showMenu } }),
      'utf8',
    );
    rebooted = await buildApp(testConfig({ roots: [root], stateDir }), {
      logger: false,
      restoreLastProject,
    });
    return rebooted;
  };

  const current = (target: FastifyInstance) =>
    target.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });

  it('reopens the most recent project with its saved source locale', async () => {
    const first = (await openWith()).json<Project>();

    const res = await current(await reboot());
    expect(res.statusCode).toBe(200);
    const body = res.json<Project>();
    expect(body).toMatchObject({ path: root, name: 'northwind', sourceLocale: 'en-GB' });
    expect(body.files.map((f) => [f.relPath, f.locale])).toEqual(
      first.files.map((f) => [f.relPath, f.locale]),
    );
    expect(body.locales.map((l) => l.locale)).toEqual(first.locales.map((l) => l.locale));
  });

  it('prefers the saved locale over the detected one (FR-1.3)', async () => {
    await openWith();
    const path = join(root, '.lexi', 'project.json');
    const saved = JSON.parse(await readFile(path, 'utf8')) as {
      mapping: Array<{ relPath: string; locale: string }>;
    };
    for (const m of saved.mapping) if (m.relPath === 'messages.ar.xlf') m.locale = 'ar-EG';
    await writeFile(path, JSON.stringify(saved), 'utf8');

    const body = (await current(await reboot())).json<Project>();
    expect(body.files.find((f) => f.relPath === 'messages.ar.xlf')?.locale).toBe('ar-EG');
  });

  it('skips a recent whose folder is gone and takes the next one', async () => {
    await openWith();
    const file = join(stateDir, 'recents.json');
    const recents = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    const gone = { ...recents[0], id: 'gone', path: join(root, '..', 'deleted-project') };
    await writeFile(file, JSON.stringify([gone, ...recents]), 'utf8');

    const res = await current(await reboot());
    expect(res.statusCode).toBe(200);
    expect(res.json<Project>().path).toBe(root);
  });

  it('boots with nothing open when no recent can be reopened', async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'recents.json'),
      JSON.stringify([{ id: 'gone', path: join(root, '..', 'deleted-project'), name: 'gone' }]),
      'utf8',
    );

    expect((await current(await reboot())).statusCode).toBe(404);
  });

  it('opens nothing unless asked to', async () => {
    await openWith();
    expect((await current(await reboot(false))).statusCode).toBe(404);
  });

  it('leaves the choice to the launch menu while it is shown', async () => {
    await openWith();
    expect((await current(await reboot(true, true))).statusCode).toBe(404);
  });
});

describe('POST /api/projects/resume — the wizard only on the first open', () => {
  const resume = (path: string = root) =>
    app.inject({
      method: 'POST',
      url: '/api/projects/resume',
      headers: goodHeaders(),
      payload: { path },
    });

  it('asks for setup when the folder has never been opened', async () => {
    const res = await resume();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
    expect(
      (await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() })).statusCode,
    ).toBe(404);
  });

  it('opens with the saved mapping and source locale once it has been', async () => {
    await openWith({ sourceLocale: 'en-GB' });
    const path = join(root, '.lexi', 'project.json');
    const saved = JSON.parse(await readFile(path, 'utf8')) as {
      mapping: Array<{ relPath: string; locale: string }>;
    };
    for (const m of saved.mapping) if (m.relPath === 'messages.ar.xlf') m.locale = 'ar-EG';
    await writeFile(path, JSON.stringify(saved), 'utf8');
    await app.inject({ method: 'POST', url: '/api/project/close', headers: goodHeaders() });

    const res = await resume();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ needsSetup: false; project: Project }>();
    expect(body.needsSetup).toBe(false);
    expect(body.project.sourceLocale).toBe('en-GB');
    expect(body.project.files.find((f) => f.relPath === 'messages.ar.xlf')?.locale).toBe('ar-EG');
  });

  it('picks up a file added since, on its detected locale', async () => {
    await openWith();
    const added = join(root, 'messages.fr.xlf');
    await writeFile(added, xlf('fr', unit('a', 'Pay now', 'Payer')), 'utf8');
    try {
      const body = (await resume()).json<{ needsSetup: false; project: Project }>();
      expect(body.project.files.find((f) => f.relPath === 'messages.fr.xlf')?.locale).toBe('fr');
    } finally {
      await rm(added, { force: true });
    }
  });

  it('asks for setup when project.json is unusable', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(join(root, '.lexi', 'project.json'), '{"version":1}', 'utf8');
    expect((await resume()).json()).toEqual({ needsSetup: true });
  });

  it('reports the saved mapping on scan, for the re-map wizard', async () => {
    expect((await scan()).json<ProjectScanResponse>().saved).toBeNull();
    await openWith();
    const saved = (await scan()).json<ProjectScanResponse>().saved;
    expect(saved?.sourceLocale).toBe('en-GB');
    expect(saved?.mapping.find((m) => m.relPath === 'messages.de.xlf')?.locale).toBe('de');
  });
});

/**
 * The convention where the filename IS the locale — `en-GB.xlf` beside
 * `de-DE.xlf`, which is what `ng extract-i18n --out-file=en-GB.xlf` produces
 * and what a real project turned out to use.
 *
 * Grouped by the stem alone, the two land in DIFFERENT groups: no row ever has
 * a German column, every string reads as missing from a file that plainly
 * contains it, and nothing can be translated or even edited. The symptom was a
 * message — "this string is not present in the de-DE file" — that was true
 * about the model and false about the files.
 */
describe('a project whose filenames are nothing but locale tags', () => {
  let localeRoot: string;
  let localeApp: FastifyInstance;

  const file = (language: string, units: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">
  <file original="ng2.template" datatype="plaintext" source-language="en-GB" target-language="${language}">
    <body>
${units}
    </body>
  </file>
</xliff>
`;

  const unitWith = (id: string, source: string, target?: string): string =>
    `      <trans-unit id="${id}">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}
      </trans-unit>`;

  beforeEach(async () => {
    localeRoot = await realpath(await mkdtemp(join(tmpdir(), 'lexi-locale-names-')));
    await writeFile(
      join(localeRoot, 'en-GB.xlf'),
      file(
        'en-GB',
        [unitWith('a', 'Privacy', 'Privacy'), unitWith('b', 'Accessibility', 'Accessibility')].join(
          '\n',
        ),
      ),
      'utf8',
    );
    // German has the first unit only — the ordinary state of a hand-maintained
    // translation file that a newer string has not reached yet.
    await writeFile(
      join(localeRoot, 'de-DE.xlf'),
      file('de-DE', unitWith('a', 'Privacy', 'Datenschutz')),
      'utf8',
    );

    localeApp = await buildApp(testConfig({ roots: [localeRoot], stateDir }), { logger: false });
  });

  afterEach(async () => {
    await localeApp?.close();
    await rm(localeRoot, { recursive: true, force: true });
  });

  const openLocaleProject = async (): Promise<Project> => {
    const scanned = (
      await localeApp.inject({
        method: 'POST',
        url: '/api/projects/scan',
        headers: goodHeaders(),
        payload: { path: localeRoot },
      })
    ).json<ProjectScanResponse>();

    const res = await localeApp.inject({
      method: 'POST',
      url: '/api/projects/open',
      headers: goodHeaders(),
      payload: {
        path: localeRoot,
        sourceLocale: 'en-GB',
        mapping: scanned.files.map((f) => ({
          path: f.path,
          fileIndex: f.fileIndex,
          locale: f.locale,
          fixTargetLanguage: false,
        })),
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    return res.json<Project>();
  };

  it('correlates the two files into one group instead of two', async () => {
    const dto = await openLocaleProject();
    expect(dto.groups).toEqual(['']);
    expect(dto.files.map((f) => f.group)).toEqual(['', '']);
    // And German is a real target locale rather than a group of its own.
    expect(dto.locales.map((l) => l.locale)).toEqual(['de-DE']);
    expect(dto.locales[0]).toMatchObject({ unitCount: 2, translated: 1, missing: 1 });
  });

  // `en.xlf` with no `target-language` is detected as nothing, so it groups as
  // `en`. The wizard confirming it as `en` has to move it into `''` with the
  // others, or every target reads as "no file for this group".
  it('regroups a source file whose locale only the mapping supplies', async () => {
    await writeFile(
      join(localeRoot, 'en.xlf'),
      file('', unitWith('a', 'Privacy')).replace(' target-language=""', ''),
      'utf8',
    );
    const scanned = (
      await localeApp.inject({
        method: 'POST',
        url: '/api/projects/scan',
        headers: goodHeaders(),
        payload: { path: localeRoot },
      })
    ).json<ProjectScanResponse>();
    expect(scanned.files.find((f) => f.relPath === 'en.xlf')?.locale).toBeNull();

    const res = await localeApp.inject({
      method: 'POST',
      url: '/api/projects/open',
      headers: goodHeaders(),
      payload: {
        path: localeRoot,
        sourceLocale: 'en',
        mapping: scanned.files.map((f) => ({
          path: f.path,
          fileIndex: f.fileIndex,
          locale: f.relPath === 'en.xlf' ? 'en' : f.locale,
          fixTargetLanguage: false,
        })),
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const dto = res.json<Project>();
    expect(dto.groups).toEqual(['']);
    expect(dto.files.map((f) => f.group)).toEqual(['', '', '']);
  });

  it('offers to create a new locale file under the same convention', async () => {
    await openLocaleProject();
    const res = await localeApp.inject({
      method: 'POST',
      url: '/api/locales/file',
      headers: goodHeaders(),
      payload: { group: '', locale: 'fr-FR' },
    });
    expect(res.statusCode, res.payload).toBe(200);
    // `fr-FR.xlf`, not `en-GB.fr-FR.xlf` — a file the build would never read.
    expect(res.json<{ created: string }>().created).toBe('fr-FR.xlf');
    expect(await readFile(join(localeRoot, 'fr-FR.xlf'), 'utf8')).toContain(
      'target-language="fr-FR"',
    );
  });
});
