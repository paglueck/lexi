// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project, StyleGuide, StyleGuideListResponse } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M10: the write half of `.lexi/styleguides/` (FR-5.1, FR-5.2, FR-5.5).
 *
 * The first describe block is the one that matters most, and it is the reason
 * this file existed before the route did. `:key` arrives off the URL and
 * decides a FILENAME — it is the only such parameter in the codebase — so it
 * is checked against an allowlist rather than escaped, and an allowlist is only
 * worth anything if something checks it from the adversarial side.
 */

const xlf = (targetLanguage: string | null, target: string): string => {
  const attr = targetLanguage === null ? '' : ` target-language="${targetLanguage}"`;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template"${attr}>
    <body>
      <trans-unit id="pay" datatype="html">
        <source>Pay now</source>${target}
      </trans-unit>
    </body>
  </file>
</xliff>
`;
};

let root: string;
let stateDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-guides-')));
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
  for (const name of await readdir(root)) {
    if (name.endsWith('.xlf')) await rm(join(root, name), { force: true });
  }
  await writeFile(join(root, 'messages.xlf'), xlf('en-GB', ''), 'utf8');
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf('de', '\n        <target>Jetzt bezahlen</target>'),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.pt-BR.xlf'),
    xlf('pt-BR', '\n        <target>Pagar agora</target>'),
    'utf8',
  );

  app = await buildApp(testConfig({ roots: [root], stateDir }), {
    logger: false,
    projects: new ProjectService(),
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

const put = (key: string, text: string) =>
  app.inject({
    method: 'PUT',
    url: `/api/styleguides/${key}`,
    headers: goodHeaders(),
    payload: { text },
  });

const get = (key: string) =>
  app.inject({ method: 'GET', url: `/api/styleguides/${key}`, headers: goodHeaders() });

const del = (key: string) =>
  app.inject({ method: 'DELETE', url: `/api/styleguides/${key}`, headers: goodHeaders() });

const list = async (): Promise<StyleGuideListResponse> => {
  const res = await app.inject({ method: 'GET', url: '/api/styleguides', headers: goodHeaders() });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<StyleGuideListResponse>();
};

const guidePath = (name: string): string => join(root, '.lexi', 'styleguides', name);

/* -- the allowlist --------------------------------------------------------- */

describe('the key names a file, so it is an allowlist', () => {
  const refused = [
    '..',
    '../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    'global.md',
    'de.md',
    'messages', // Intl calls this a perfectly good locale
    'de%2f..%2f..%2fx',
    'de.%2e',
    'a'.repeat(200),
  ];

  for (const key of refused) {
    it(`refuses ${JSON.stringify(key)}`, async () => {
      const res = await put(key, '# nope');
      expect(res.statusCode, `${key} was accepted`).not.toBe(200);
      expect(res.statusCode).toBeLessThan(500);
    });
  }

  it('writes nothing anywhere when a key is refused', async () => {
    await put('..%2f..%2fpwned', '# nope');
    await expect(readFile(join(root, '..', 'pwned.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, '..', 'pwned'), 'utf8')).rejects.toThrow();
  });

  it('accepts global and a well-formed locale tag', async () => {
    // `src` is on this list on purpose. Correction 23 refuses it as a
    // DIRECTORY segment, because reading `src/messages.xlf` as Logudorese
    // Sardinian is the common case when scanning a repository. Here the key is
    // a name the user chose rather than one we guessed, and `src` is a real
    // language code — refusing it would be this tool deciding somebody's
    // locale does not exist.
    for (const key of ['global', 'de', 'pt-BR', 'zh-Hant', 'en-GB', 'src']) {
      expect((await put(key, `# ${key}`)).statusCode, key).toBe(200);
    }
  });
});

/* -- reading and writing --------------------------------------------------- */

describe('a guide round-trips through the file it is named after', () => {
  it('writes global.md and reads it back verbatim', async () => {
    const text = '# Global style guide\n\n## Tone\n\nPlain and direct.';
    const saved = (await put('global', text)).json<StyleGuide>();
    expect(saved.name).toBe('global.md');
    expect(saved.locale).toBeNull();
    expect(saved.exists).toBe(true);
    expect(saved.tokens).toBeGreaterThan(0);

    // Trailing newline: it is a text file in somebody's repository.
    expect(await readFile(guidePath('global.md'), 'utf8')).toBe(`${text}\n`);
    expect((await get('global')).json<StyleGuide>().text).toBe(text);
  });

  it('reports a guide nobody has written yet rather than 404-ing', async () => {
    const res = await get('de');
    expect(res.statusCode).toBe(200);
    const guide = res.json<StyleGuide>();
    expect(guide.exists).toBe(false);
    expect(guide.text).toBe('');
    expect(guide.name).toBe('de.md');
    expect(guide.locale).toBe('de');
  });

  it('lists what exists and which target locales still have none', async () => {
    await put('global', '# Global');
    await put('de', '# German');

    const listing = await list();
    expect(listing.guides.map((g) => g.key)).toEqual(['global', 'de']);
    expect(listing.guides[1]?.tokens).toBeGreaterThan(0);
    expect(listing.dir).toBe('.lexi/styleguides');
    // en-GB is the source locale, so it is not a translation target.
    expect(listing.missing).toEqual(['pt-BR']);
  });

  it('deletes a guide and stops listing it', async () => {
    await put('de', '# German');
    expect((await del('de')).statusCode).toBe(200);
    expect((await list()).guides.map((g) => g.key)).not.toContain('de');
    expect((await get('de')).json<StyleGuide>().exists).toBe(false);
  });

  it('deleting one that was never written is not an error', async () => {
    expect((await del('fr')).statusCode).toBe(200);
  });

  it('refuses a guide larger than the cap', async () => {
    expect((await put('global', 'x'.repeat(300 * 1024))).statusCode).toBe(400);
  });

  it('saving an empty guide removes the file rather than leaving a blank one', async () => {
    await put('de', '# German');
    const saved = (await put('de', '   \n  ')).json<StyleGuide>();
    expect(saved.exists).toBe(false);
    await expect(readFile(guidePath('de.md'), 'utf8')).rejects.toThrow();
  });
});

/* -- the fallback M9 established ------------------------------------------- */

describe('pt-BR still beats pt', () => {
  it('keeps both files and prefers the exact locale', async () => {
    await put('pt', '# Portuguese');
    await put('pt-BR', '# Brazilian Portuguese');

    const keys = (await list()).guides.map((g) => g.key);
    expect(keys).toContain('pt');
    expect(keys).toContain('pt-BR');
    expect(await readFile(guidePath('pt-BR.md'), 'utf8')).toContain('Brazilian');
  });
});
