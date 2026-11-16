// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  type PhraseBranchesResponse,
  type PhrasePinLocalesResponse,
  type PhraseProjectsResponse,
  type PhrasePushResponse,
  type PhraseStatus,
  type PhraseTestResponse,
  type ProjectScanResponse,
  type Settings,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { goodHeaders, testConfig } from './helpers.js';
import { fakePhrase, type FakePhrase } from './phrase-fake.js';

/**
 * The Phrase half of the workflow: add a key, translate it, push. A fake
 * Phrase stands in for the API, so what is under test is what lexi sends and
 * what it refuses to send.
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
const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${
          target === undefined
            ? ''
            : `
        <target state="translated">${target}</target>`
        }
      </trans-unit>`;

let base: string;
let root: string;
let stateDir: string;
let app: FastifyInstance;
let phrase: FakePhrase;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-phrase-routes-')));
  root = join(base, 'web');
  stateDir = join(base, 'state');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'messages.xlf'), xlf('en-GB', unit('pay', 'Pay now')), 'utf8');
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf('de', unit('pay', 'Pay now', 'Jetzt zahlen')),
    'utf8',
  );
  await writeFile(join(root, 'messages.fr.xlf'), xlf('fr', unit('pay', 'Pay now')), 'utf8');

  phrase = fakePhrase();
  app = await buildApp(testConfig({ roots: [base], stateDir }), {
    logger: false,
    phrase: { fetch: phrase.fetch, pollIntervalMs: 0, env: {} },
  });
});

afterEach(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const inject = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) =>
  payload === undefined
    ? app.inject({ method, url, headers: goodHeaders() })
    : app.inject({ method, url, headers: goodHeaders(), payload });

const openProject = async () => {
  const scan = (
    await inject('POST', '/api/projects/scan', { path: root })
  ).json<ProjectScanResponse>();
  const res = await inject('POST', '/api/projects/open', {
    path: root,
    sourceLocale: 'en-GB',
    mapping: scan.files.map((f) => ({
      path: f.path,
      fileIndex: f.fileIndex,
      locale: f.locale ?? 'en-GB',
    })),
  });
  expect(res.statusCode).toBe(200);
};

/** Save the fake's valid token through the S19 route, as the settings screen does. */
const setToken = async () => {
  const res = await inject('POST', '/api/phrase/tokens', {
    note: 'Work',
    token: 'good-token',
    region: 'EU',
  });
  expect(res.statusCode).toBe(201);
  return res;
};

/** Phrase revokes the saved token: from now on it answers 401 to it. */
const revoke = () => {
  phrase.token = 'rotated-token';
};

describe('the saved Phrase token', () => {
  it('is tested against /user without a project open', async () => {
    expect((await inject('POST', '/api/phrase/test')).json<PhraseTestResponse>().ok).toBe(false);
    await setToken();
    expect((await inject('POST', '/api/phrase/test')).json<PhraseTestResponse>()).toEqual({
      ok: true,
      detail: 'Signed in to Phrase as Jane Doe (jdoe).',
    });
    revoke();
    expect((await inject('POST', '/api/phrase/test')).json<PhraseTestResponse>().ok).toBe(false);
  });

  it('is never in the settings answer', async () => {
    await setToken();
    const settings = (await inject('GET', '/api/settings')).json<Settings>();
    expect(settings.phrase.tokens).toHaveLength(1);
    expect(JSON.stringify(settings)).not.toContain('good-token');
  });
});

describe('connecting a project to Phrase', () => {
  it('reports no config before one exists', async () => {
    await openProject();
    const status = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(status).toMatchObject({
      configFile: null,
      projectId: null,
      files: [],
      tokenSource: null,
    });
  });

  it('lists the Phrase projects the token can see', async () => {
    await openProject();
    await setToken();
    const body = (await inject('GET', '/api/phrase/projects')).json<PhraseProjectsResponse>();
    expect(body.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('answers 400 for the project list without a token, and 502 when Phrase refuses it', async () => {
    await openProject();
    expect((await inject('GET', '/api/phrase/projects')).statusCode).toBe(400);
    await setToken();
    revoke();
    const res = await inject('GET', '/api/phrase/projects');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'upstream' } });
  });

  it('writes a .phrase.yml from the mapping and refuses to write a second', async () => {
    await openProject();
    await setToken();
    const res = await inject('POST', '/api/phrase/connect', { projectId: 'p1' });
    expect(res.statusCode).toBe(200);
    const status = res.json<PhraseStatus>();
    expect(status.configFile).toBe('.phrase.yml');
    // Pinned by Phrase locale id, with the name as a comment.
    expect(status.files.map((f) => [f.relPath, f.localeId, f.target?.name])).toEqual([
      ['messages.de.xlf', 'loc-de', 'de'],
      ['messages.fr.xlf', 'loc-fr', 'fr'],
      ['messages.xlf', 'loc-en', 'en-GB'],
    ]);
    expect(status.unpinned).toBe(0);
    const yml = await readFile(join(root, '.phrase.yml'), 'utf8');
    expect(yml).toContain('locale_id: loc-de # de (de-DE)');
    expect(yml.match(/override_file_language: true/g)).toHaveLength(3);
    // The CLI needs one side ignored: sources for translations, targets for the template.
    expect(yml.match(/ignore_source_translations: true/g)).toHaveLength(2);
    expect(yml.match(/ignore_target_translations: true/g)).toHaveLength(1);

    const again = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(again).toMatchObject({
      projectId: 'p1',
      projectName: 'Project p1',
      tokenSource: 'settings',
      problems: [],
    });

    expect((await inject('POST', '/api/phrase/connect', { projectId: 'p2' })).statusCode).toBe(409);
  });

  it('names a locale the Phrase project does not have', async () => {
    await writeFile(
      join(root, '.phrase.yml'),
      'phrase:\n  project_id: p1\n  push:\n    sources:\n      - file: ./messages.<locale_name>.xlf\n',
      'utf8',
    );
    await writeFile(join(root, 'messages.ja.xlf'), xlf('ja', unit('pay', 'Pay now')), 'utf8');
    await openProject();
    await setToken();
    const status = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(status.problems.join(' ')).toMatch(/no locale "ja"/);
    expect(status.files.find((f) => f.localeId === 'ja')?.target).toBeNull();
  });

  it('shows a broken config as a problem rather than failing', async () => {
    await writeFile(join(root, '.phrase.yml'), 'phrase: [', 'utf8');
    await openProject();
    const status = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(status.problems[0]).toMatch(/not valid YAML/);
  });
});

describe('POST /api/phrase/push', () => {
  const connect = async () => {
    await openProject();
    await setToken();
    await inject('POST', '/api/phrase/connect', { projectId: 'p1' });
  };

  it('uploads every file in the config with its resolved locale id and params', async () => {
    await connect();
    const res = await inject('POST', '/api/phrase/push');
    expect(res.statusCode).toBe(200);
    const body = res.json<PhrasePushResponse>();
    expect(body.ok).toBe(true);
    expect(
      body.results.map((r) => [r.relPath, r.ok, r.summary['translation_keys_created']]),
    ).toEqual([
      ['messages.de.xlf', true, 1],
      ['messages.fr.xlf', true, 1],
      ['messages.xlf', true, 1],
    ]);
    expect(
      phrase.uploads.map((u) => [
        u.fileName,
        u.fields['locale_id'],
        u.fields['update_translations'],
      ]),
    ).toEqual([
      ['messages.de.xlf', 'loc-de', 'true'],
      ['messages.fr.xlf', 'loc-fr', 'true'],
      ['messages.xlf', 'loc-en', 'true'],
    ]);
    expect(phrase.uploads[0]?.fileText).toContain('Jetzt zahlen');
    expect(phrase.uploads[0]?.fields['file_format']).toBe('xlf');
    // One side of each XLIFF: a translation's targets, the template's sources.
    expect(
      phrase.uploads.map((u) => [
        u.fileName,
        u.fields['format_options[override_file_language]'],
        u.fields['format_options[ignore_source_translations]'],
        u.fields['format_options[ignore_target_translations]'],
      ]),
    ).toEqual([
      ['messages.de.xlf', 'true', 'true', 'false'],
      ['messages.fr.xlf', 'true', 'true', 'false'],
      ['messages.xlf', 'true', 'false', 'true'],
    ]);
    // The template's file is uploaded as it is.
    expect(phrase.uploads[2]?.fileText).toContain('target-language="en-GB"');
  });

  it('refuses while drafts are unsaved, and pushes the saved text afterwards', async () => {
    await connect();
    const edit = await inject(
      'PATCH',
      `/api/units/${encodeURIComponent(rowIdOf('messages', 'pay'))}/targets/fr`,
      { segments: [{ k: 't', v: 'Payer maintenant' }] },
    );
    expect(edit.statusCode).toBe(200);

    const refused = await inject('POST', '/api/phrase/push');
    expect(refused.statusCode).toBe(409);
    expect(phrase.uploads).toHaveLength(0);

    expect((await inject('POST', '/api/save', {})).statusCode).toBe(200);
    expect((await inject('POST', '/api/phrase/push')).statusCode).toBe(200);
    expect(phrase.uploads.find((u) => u.fileName === 'messages.fr.xlf')?.fileText).toContain(
      'Payer maintenant',
    );
  });

  it('keeps going when one file fails and says which', async () => {
    await connect();
    phrase.failLocales.add('loc-fr');
    const body = (await inject('POST', '/api/phrase/push')).json<PhrasePushResponse>();
    expect(body.ok).toBe(false);
    expect(body.results.map((r) => [r.relPath, r.ok, r.error])).toEqual([
      ['messages.de.xlf', true, null],
      ['messages.fr.xlf', false, 'Could not parse the file'],
      ['messages.xlf', true, null],
    ]);
  });

  const localeRequests = () =>
    phrase.requests.filter((r) => /\/locales\?/.test(r.url)).map((r) => r.url);

  it('pushes to the main project unless a branch is picked', async () => {
    await connect();
    const body = (await inject('POST', '/api/phrase/push', {})).json<PhrasePushResponse>();
    expect(body.branch).toBeNull();
    expect(phrase.uploads.map((u) => u.fields['branch'])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('pushes every file to the picked branch, resolving locales on it', async () => {
    await connect();
    phrase.requests.length = 0;
    const res = await inject('POST', '/api/phrase/push', { branch: 'release-2' });
    expect(res.statusCode).toBe(200);
    const body = res.json<PhrasePushResponse>();
    expect(body.ok).toBe(true);
    expect(body.branch).toBe('release-2');
    expect(phrase.uploads.map((u) => u.fields['branch'])).toEqual([
      'release-2',
      'release-2',
      'release-2',
    ]);
    expect(phrase.uploads.map((u) => u.fields['locale_id'])).toEqual([
      'loc-de',
      'loc-fr',
      'loc-en',
    ]);
    // Once to resolve, once more afterwards to check that no locale appeared.
    expect(localeRequests()).toHaveLength(2);
    expect(localeRequests().every((u) => /branch=release-2/.test(u))).toBe(true);
    // The processing polls ask the branch too.
    expect(
      phrase.requests
        .filter((r) => /\/uploads\/up/.test(r.url))
        .every((r) => /branch=release-2/.test(r.url)),
    ).toBe(true);
  });

  it('lets the dialog override a branch the config names, or push to main instead', async () => {
    await writeFile(
      join(root, '.phrase.yml'),
      'phrase:\n  project_id: p1\n  push:\n    sources:\n      - file: ./messages.<locale_name>.xlf\n        params:\n          branch: feature-x\n',
      'utf8',
    );
    await openProject();
    await setToken();

    const listed = (await inject('GET', '/api/phrase/branches')).json<PhraseBranchesResponse>();
    expect(listed).toEqual({
      branches: [
        { name: 'feature-x', updatedAt: null },
        { name: 'release-2', updatedAt: '2026-11-01T09:00:00Z' },
      ],
      configured: 'feature-x',
    });

    const asConfigured = (await inject('POST', '/api/phrase/push', {})).json<PhrasePushResponse>();
    expect(asConfigured.branch).toBe('feature-x');
    expect(new Set(phrase.uploads.map((u) => u.fields['branch']))).toEqual(new Set(['feature-x']));

    phrase.uploads.length = 0;
    phrase.requests.length = 0;
    const toMain = (
      await inject('POST', '/api/phrase/push', { branch: null })
    ).json<PhrasePushResponse>();
    expect(toMain.branch).toBeNull();
    expect(phrase.uploads.every((u) => u.fields['branch'] === undefined)).toBe(true);
    expect(localeRequests().every((u) => !u.includes('branch='))).toBe(true);
  });

  it('marks the uploads as verified only when asked, overriding the config', async () => {
    await connect();
    await inject('POST', '/api/phrase/push', {});
    expect(
      phrase.uploads.every((u) => u.fields['verify_mentioned_translations'] === undefined),
    ).toBe(true);

    phrase.uploads.length = 0;
    expect((await inject('POST', '/api/phrase/push', { verify: true })).statusCode).toBe(200);
    expect(phrase.uploads.length).toBeGreaterThan(0);
    expect(phrase.uploads.every((u) => u.fields['verify_mentioned_translations'] === 'true')).toBe(
      true,
    );
  });

  it('lets the dialog switch off the verify the config asks for', async () => {
    await writeFile(
      join(root, '.phrase.yml'),
      'phrase:\n  project_id: p1\n  push:\n    sources:\n      - file: ./messages.<locale_name>.xlf\n        params:\n          verify_mentioned_translations: true\n',
      'utf8',
    );
    await openProject();
    await setToken();

    await inject('POST', '/api/phrase/push', {});
    expect(new Set(phrase.uploads.map((u) => u.fields['verify_mentioned_translations']))).toEqual(
      new Set(['true']),
    );

    phrase.uploads.length = 0;
    await inject('POST', '/api/phrase/push', { verify: false });
    expect(new Set(phrase.uploads.map((u) => u.fields['verify_mentioned_translations']))).toEqual(
      new Set(['false']),
    );
  });

  it('stops at a cancel: the file in Phrase is reported, the rest not uploaded', async () => {
    await connect();
    // Phrase keeps the first upload processing until the cancel arrives.
    phrase.processingPolls = Number.MAX_SAFE_INTEGER;
    const pending = inject('POST', '/api/phrase/push', {});
    while (phrase.uploads.length === 0) await new Promise((r) => setTimeout(r, 1));

    expect((await inject('POST', '/api/phrase/push', {})).statusCode).toBe(409);
    expect((await inject('POST', '/api/phrase/push/cancel')).statusCode).toBe(204);

    const body = (await pending).json<PhrasePushResponse>();
    expect(body.ok).toBe(false);
    expect(body.cancelled).toBe(true);
    expect(phrase.uploads).toHaveLength(1);
    expect(body.results.map((r) => r.error)).toEqual([
      expect.stringContaining('Cancelled while it was being uploaded'),
      'Not pushed: the push was cancelled.',
      'Not pushed: the push was cancelled.',
    ]);

    // Over: the next push runs normally.
    phrase.processingPolls = 0;
    phrase.uploads.length = 0;
    const again = (await inject('POST', '/api/phrase/push', {})).json<PhrasePushResponse>();
    expect(again.cancelled).toBe(false);
    expect(phrase.uploads).toHaveLength(3);
  });

  it('answers a cancel with 204 when no push runs', async () => {
    expect((await inject('POST', '/api/phrase/push/cancel')).statusCode).toBe(204);
  });

  it('rejects a malformed push request', async () => {
    await connect();
    expect((await inject('POST', '/api/phrase/push', { verify: 'yes' })).statusCode).toBe(400);
    expect((await inject('POST', '/api/phrase/push', { branch: '' })).statusCode).toBe(400);
    expect((await inject('POST', '/api/phrase/push', { branch: 3 })).statusCode).toBe(400);
    expect((await inject('POST', '/api/phrase/push', { other: true })).statusCode).toBe(400);
    expect(phrase.uploads).toHaveLength(0);
  });

  it('needs a config and a token', async () => {
    await openProject();
    expect((await inject('GET', '/api/phrase/branches')).statusCode).toBe(400);
    expect((await inject('POST', '/api/phrase/push')).statusCode).toBe(400);
    await writeFile(
      join(root, '.phrase.yml'),
      'phrase:\n  project_id: p1\n  push:\n    sources:\n      - file: ./messages.<locale_name>.xlf\n',
      'utf8',
    );
    const res = await inject('POST', '/api/phrase/push');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/access token/);
  });
});

/**
 * The incident: Phrase has "de-DE" and "Developer-German" (code `de`), and a
 * push of `messages.de.xlf` (target-language="de") made a third locale named
 * `de`. A push must never create a locale.
 */
describe('a push never creates a Phrase locale', () => {
  const DEV_GERMAN = { id: 'dev-de', name: 'Developer-German', code: 'de' };
  const sources = (deLocale: string, extra = '') =>
    'phrase:\n  project_id: p1\n  push:\n    sources:\n' +
    `      - file: ./messages.de.xlf\n        params:\n          file_format: xlf\n          locale_id: ${deLocale}${extra}\n` +
    '      - file: ./messages.fr.xlf\n        params:\n          file_format: xlf\n          locale_id: fr\n';

  beforeEach(() => {
    phrase.locales = [
      { id: 'loc-dede', name: 'de-DE', code: 'de-DE' },
      DEV_GERMAN,
      { id: 'loc-en', name: 'en-GB', code: 'en-GB', default: true },
      { id: 'loc-fr', name: 'fr', code: 'fr-FR' },
    ];
  });

  const setUp = async (yml: string) => {
    await writeFile(join(root, '.phrase.yml'), yml, 'utf8');
    await openProject();
    await setToken();
  };

  it('uploads to the locale the code names, by id, and makes Phrase use that id', async () => {
    await setUp(sources('de'));
    const status = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(status.files[0]?.target).toEqual(DEV_GERMAN);
    expect(status.problems).toEqual([]);
    expect(status.unpinned).toBe(2);

    const body = (await inject('POST', '/api/phrase/push', {})).json<PhrasePushResponse>();
    expect(body.ok).toBe(true);
    expect(body.createdLocales).toEqual([]);
    const de = phrase.uploads[0]!;
    expect(de.fields['locale_id']).toBe('dev-de');
    expect(de.fields['format_options[override_file_language]']).toBe('true');
    // The uploaded copy names the locale as Phrase does; the file on disk is untouched.
    expect(de.fileText).toContain('target-language="Developer-German"');
    expect(await readFile(join(root, 'messages.de.xlf'), 'utf8')).toContain('target-language="de"');
    expect(phrase.locales).toHaveLength(4);
  });

  it('overrides a config that turns override_file_language off, keeping its other options', async () => {
    await setUp(
      sources(
        'dev-de',
        '\n          format_options:\n            override_file_language: false\n            ignore_source_translations: true',
      ),
    );
    await inject('POST', '/api/phrase/push', {});
    expect(phrase.uploads[0]?.fields).toMatchObject({
      'format_options[override_file_language]': 'true',
      'format_options[ignore_source_translations]': 'true',
    });
  });

  it('pushes nothing when a locale is ambiguous or unknown', async () => {
    phrase.locales.push({ id: 'stray', name: 'de', code: 'de' });
    await setUp(sources('de'));
    const status = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(status.problems.join(' ')).toMatch(/"de" matches 2 Phrase locales/);
    expect(status.files[0]?.target).toBeNull();

    const res = await inject('POST', '/api/phrase/push', {});
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(
      /^Nothing was pushed\. messages\.de\.xlf: "de" matches 2/,
    );
    expect(phrase.uploads).toHaveLength(0);

    phrase.locales = phrase.locales.filter((l) => l.code !== 'de');
    expect((await inject('POST', '/api/phrase/push', {})).statusCode).toBe(409);
    expect(phrase.uploads).toHaveLength(0);
  });

  it('stops and names the locale when Phrase creates one anyway', async () => {
    await setUp(sources('dev-de'));
    phrase.createLocaleFor.add('dev-de');
    const body = (await inject('POST', '/api/phrase/push', {})).json<PhrasePushResponse>();
    expect(body.ok).toBe(false);
    expect(body.results.map((r) => [r.ok, r.error?.slice(0, 30)])).toEqual([
      [false, 'Phrase created a new locale fo'],
      [false, 'Not pushed: the push stopped a'],
    ]);
    expect(phrase.uploads).toHaveLength(1);
    expect(body.createdLocales).toEqual([
      'Phrase now has a locale dev-de (id new-dev-de) that the push created. Delete it in Phrase.',
    ]);
  });

  it('follows a pinned id to the same locale on a branch that has its own ids', async () => {
    await setUp(sources('dev-de'));
    phrase.branchLocales.set('release-2', [
      { id: 'b-dev-de', name: 'Developer-German', code: 'de' },
      { id: 'b-fr', name: 'fr', code: 'fr-FR' },
    ]);
    const body = (
      await inject('POST', '/api/phrase/push', { branch: 'release-2' })
    ).json<PhrasePushResponse>();
    expect(body.ok).toBe(true);
    expect(phrase.uploads.map((u) => u.fields['locale_id'])).toEqual(['b-dev-de', 'b-fr']);
  });

  it('checks the status against the picked branch, as the push will', async () => {
    // The incident's state on main (`de` ambiguous); a clean test branch with its own ids.
    phrase.locales.push({ id: 'stray', name: 'de', code: 'de' });
    phrase.branchLocales.set('test', [
      { id: 'b-dev-de', name: 'Developer-German', code: 'de' },
      { id: 'b-fr', name: 'fr', code: 'fr-FR' },
    ]);
    await setUp(sources('de'));

    const main = (await inject('GET', '/api/phrase/status?branch=')).json<PhraseStatus>();
    expect(main.branch).toBeNull();
    expect(main.files[0]?.target).toBeNull();
    expect(main.problems.join(' ')).toMatch(/matches 2 Phrase locales/);

    const onTest = (await inject('GET', '/api/phrase/status?branch=test')).json<PhraseStatus>();
    expect(onTest.branch).toBe('test');
    expect(onTest.problems).toEqual([]);
    expect(onTest.files.map((f) => f.target?.id)).toEqual(['b-dev-de', 'b-fr']);

    expect((await inject('POST', '/api/phrase/push', { branch: null })).statusCode).toBe(409);
    expect(phrase.uploads).toHaveLength(0);
    const pushed = (
      await inject('POST', '/api/phrase/push', { branch: 'test' })
    ).json<PhrasePushResponse>();
    expect(pushed.ok).toBe(true);
    expect(phrase.uploads.map((u) => u.fields['locale_id'])).toEqual(['b-dev-de', 'b-fr']);
  });

  it('follows pinned main-project ids to the branch in the status too', async () => {
    phrase.branchLocales.set('test', [
      { id: 'b-dev-de', name: 'Developer-German', code: 'de' },
      { id: 'b-fr', name: 'fr', code: 'fr-FR' },
    ]);
    await setUp(sources('dev-de'));
    const status = (await inject('GET', '/api/phrase/status?branch=test')).json<PhraseStatus>();
    expect(status.files[0]?.target).toEqual({
      id: 'b-dev-de',
      name: 'Developer-German',
      code: 'de',
    });
    // Counted against the main project, where pinning happens: fr by name, and
    // both still without the side option the CLI needs.
    expect(status.unpinned).toBe(2);
  });

  it('flags a pinned config the CLI would fail on, and pinning again adds the side option', async () => {
    const pinnedButOneSided =
      'phrase:\n  project_id: p1\n  push:\n    sources:\n' +
      '      - file: ./messages.de.xlf\n        params:\n          locale_id: dev-de # Developer-German (de)\n' +
      '          format_options:\n            override_file_language: true\n';
    await setUp(pinnedButOneSided);
    const status = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(status.problems.join(' ')).toMatch(/override_file_language without ignore_source/);
    expect(status.unpinned).toBe(1);

    const pinned = (
      await inject('POST', '/api/phrase/pin-locales')
    ).json<PhrasePinLocalesResponse>();
    expect(pinned).toEqual({ pinned: 1, problems: [] });
    const yml = await readFile(join(root, '.phrase.yml'), 'utf8');
    expect(yml).toContain('locale_id: dev-de # Developer-German (de)');
    expect(yml).toContain('ignore_source_translations: true');
    const after = (await inject('GET', '/api/phrase/status')).json<PhraseStatus>();
    expect(after.problems).toEqual([]);
    expect(after.unpinned).toBe(0);
  });

  it('pins locale ids into .phrase.yml, keeping comments, and pins nothing when one is ambiguous', async () => {
    await setUp('# our CI reads this\n' + sources('de'));
    const pinned = (
      await inject('POST', '/api/phrase/pin-locales')
    ).json<PhrasePinLocalesResponse>();
    expect(pinned).toEqual({ pinned: 2, problems: [] });
    const yml = await readFile(join(root, '.phrase.yml'), 'utf8');
    expect(yml).toMatch(/^# our CI reads this/);
    expect(yml).toContain('locale_id: dev-de # Developer-German (de)');
    expect(yml).toContain('locale_id: loc-fr # fr (fr-FR)');
    expect(yml.match(/override_file_language: true/g)).toHaveLength(2);
    expect(yml.match(/ignore_source_translations: true/g)).toHaveLength(2);
    expect((await inject('GET', '/api/phrase/status')).json<PhraseStatus>().unpinned).toBe(0);

    phrase.locales.push({ id: 'stray', name: 'de', code: 'de' });
    await writeFile(join(root, '.phrase.yml'), sources('de'), 'utf8');
    const refused = (
      await inject('POST', '/api/phrase/pin-locales')
    ).json<PhrasePinLocalesResponse>();
    expect(refused.pinned).toBe(0);
    expect(refused.problems.join(' ')).toMatch(/matches 2 Phrase locales/);
    expect(await readFile(join(root, '.phrase.yml'), 'utf8')).toBe(sources('de'));
  });
});
