// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scan } from '@lexi/xliff';
import type {
  LexiEvent,
  PhraseCheckoutResult,
  PhraseOrigin,
  PhraseProjectDetail,
  PhraseScopeKeys,
  PhraseScopePreview,
  PhraseTagsResponse,
  PhraseToken,
  Project,
  ProjectResumeResponse,
  RecentsResponse,
  Settings,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { EventBus } from '../src/lib/event-bus.js';
import type { PhraseRouteOptions } from '../src/routes/phrase.js';
import { goodHeaders, testConfig } from './helpers.js';
import { fakePhrase, type FakePhrase } from './phrase-fake.js';

/**
 * S18 — a Phrase project checked out as a local project, all of it or the
 * union of some tags. The fake Phrase holds three keys tagged `checkout-v2`:
 * one with a description and placeholders, one plural, one with no base text;
 * and one more tagged `legacy`.
 */

let base: string;
let parent: string;
let stateDir: string;
let app: FastifyInstance;
let phrase: FakePhrase;
let tokenId: string;
let events: Array<Extract<LexiEvent, { type: 'phrase-checkout-progress' }>>;

const boot = async (extra: PhraseRouteOptions = {}): Promise<void> => {
  app = await buildApp(testConfig({ roots: [base], stateDir }), {
    logger: false,
    phrase: {
      fetch: phrase.fetch,
      pollIntervalMs: 0,
      env: {},
      delay: async () => undefined,
      ...extra,
    },
  });
  const res = await inject('POST', '/api/phrase/tokens', {
    note: 'Work',
    token: 'good-token',
    region: 'EU',
  });
  tokenId = res.json<PhraseToken>().id;
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-phrase-checkout-')));
  parent = join(base, 'projects');
  stateDir = join(base, 'state');
  phrase = fakePhrase();
  events = [];
  vi.spyOn(EventBus.prototype, 'publish').mockImplementation((event: LexiEvent) => {
    if (event.type === 'phrase-checkout-progress') events.push(event);
  });
  await boot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const inject = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url,
    headers: goodHeaders(),
    ...(payload === undefined ? {} : { payload }),
  });

const request = (over: Record<string, unknown> = {}) => ({
  tokenId,
  projectId: 'p1',
  scope: { kind: 'tags', tags: ['checkout-v2'] },
  parentDir: parent,
  folderName: 'web-checkout',
  locales: ['de-DE', 'fr-FR'],
  ...over,
});

const checkout = (over: Record<string, unknown> = {}) =>
  inject('POST', '/api/phrase/checkout', request(over));

describe('the dialog reads', () => {
  it('shows the project with its default locale as the base', async () => {
    const res = await inject('GET', `/api/phrase/tokens/${tokenId}/projects/p1`);
    expect(res.json<PhraseProjectDetail>()).toEqual({
      id: 'p1',
      name: 'Project p1',
      baseLocale: 'en-GB',
      locales: [
        { id: 'loc-de', code: 'de-DE', name: 'de', isDefault: false },
        { id: 'loc-en', code: 'en-GB', name: 'en-GB', isDefault: true },
        { id: 'loc-fr', code: 'fr-FR', name: 'fr', isDefault: false },
      ],
    });
    expect((await inject('GET', '/api/phrase/tokens/nope/projects/p1')).statusCode).toBe(404);
  });

  it('lists tags with key counts and previews one', async () => {
    const tags = (
      await inject('GET', `/api/phrase/tokens/${tokenId}/projects/p1/tags`)
    ).json<PhraseTagsResponse>();
    expect(tags.tags.map((t) => [t.name, t.keysCount])).toEqual([
      ['checkout-v2', 3],
      ['legacy', 1],
    ]);
  });

  const preview = (query: string) =>
    inject('GET', `/api/phrase/tokens/${tokenId}/projects/p1/preview?${query}`);

  it('previews one tag with its exact count', async () => {
    const res = await preview('tag=checkout-v2');
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseScopePreview>()).toEqual({
      scope: { kind: 'tags', tags: ['checkout-v2'] },
      keysCount: 3,
      exact: true,
      updatedAt: '2026-10-30T09:00:00Z',
      sample: [
        { key: 'checkout.pay', text: 'Pay {amount} now & go' },
        { key: 'checkout.items', text: '{count} items' },
        { key: 'checkout.blank', text: '' },
      ],
    });
    const keysCall = phrase.requests.find((r) => r.url.includes('/keys?'));
    expect(new URL(keysCall!.url).searchParams.get('q')).toBe('tags:checkout-v2');
  });

  it('previews several tags as a deduped union with an upper-bound count', async () => {
    phrase.keys.push({ id: 'k5', name: 'shared.ok', tags: ['legacy', 'checkout-v2'], base: 'OK' });
    // A tag with a comma survives as one value of a repeated parameter.
    phrase.keys.push({ id: 'k6', name: 'odd.one', tags: ['a,b'], base: 'Odd' });
    const res = await preview(
      ['checkout-v2', 'legacy', 'a,b'].map((t) => `tag=${encodeURIComponent(t)}`).join('&'),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseScopePreview>()).toEqual({
      scope: { kind: 'tags', tags: ['checkout-v2', 'legacy', 'a,b'] },
      keysCount: 4 + 2 + 1,
      exact: false,
      updatedAt: '2026-10-30T09:00:00Z',
      sample: [
        { key: 'checkout.pay', text: 'Pay {amount} now & go' },
        { key: 'checkout.items', text: '{count} items' },
        { key: 'checkout.blank', text: '' },
        { key: 'shared.ok', text: 'OK' },
        { key: 'legacy.title', text: 'Old' },
        { key: 'odd.one', text: 'Odd' },
      ],
    });
  });

  it('previews all keys with the base locale total', async () => {
    const res = await preview('scope=all');
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseScopePreview>()).toEqual({
      scope: { kind: 'all' },
      keysCount: 4,
      exact: true,
      updatedAt: null,
      sample: [
        { key: 'checkout.pay', text: 'Pay {amount} now & go' },
        { key: 'checkout.items', text: '{count} items' },
        { key: 'checkout.blank', text: '' },
        { key: 'legacy.title', text: 'Old' },
      ],
    });
    const keysCall = phrase.requests.find((r) => r.url.includes('/keys?'));
    expect(new URL(keysCall!.url).searchParams.has('q')).toBe(false);

    phrase.localeStatistics = false;
    expect((await preview('scope=all')).json<PhraseScopePreview>().keysCount).toBeNull();
  });

  it('answers 404 for an unknown tag and 400 for a bad query', async () => {
    const unknown = await preview('tag=checkout-v2&tag=nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
      'Phrase project has no tag nope.',
    );
    for (const query of ['', 'scope=all&tag=legacy', 'scope=some', 'tag=', 'tag=a&tag=a']) {
      expect((await preview(query)).statusCode, query).toBe(400);
    }
  });
});

describe('GET …/keys', () => {
  const keys = (query: string) =>
    inject('GET', `/api/phrase/tokens/${tokenId}/projects/p1/keys?${query}`);

  it('lists every key of the project with its base text, plural keys by their other form', async () => {
    phrase.pageSize = 2;
    const res = await keys('scope=all');
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseScopeKeys>()).toEqual({
      scope: { kind: 'all' },
      keys: [
        { key: 'checkout.pay', text: 'Pay {amount} now & go' },
        { key: 'checkout.items', text: '{count} items' },
        { key: 'checkout.blank', text: '' },
        { key: 'legacy.title', text: 'Old' },
      ],
    });
    // Every page, not just the first.
    expect(phrase.requests.filter((r) => r.url.includes('/keys?')).length).toBe(2);
  });

  it('lists the union of overlapping tags once each, in the order a checkout writes', async () => {
    phrase.keys.push({ id: 'k5', name: 'shared.ok', tags: ['legacy', 'checkout-v2'], base: 'OK' });
    const res = await keys('tag=checkout-v2&tag=legacy');
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseScopeKeys>()).toEqual({
      scope: { kind: 'tags', tags: ['checkout-v2', 'legacy'] },
      keys: [
        { key: 'checkout.pay', text: 'Pay {amount} now & go' },
        { key: 'checkout.items', text: '{count} items' },
        { key: 'checkout.blank', text: '' },
        { key: 'shared.ok', text: 'OK' },
        { key: 'legacy.title', text: 'Old' },
      ],
    });
    const keyQueries = phrase.requests
      .filter((r) => r.url.includes('/keys?'))
      .map((r) => new URL(r.url).searchParams.get('q'));
    expect(keyQueries).toEqual(['tags:checkout-v2', 'tags:legacy']);
  });

  it('answers 404 for an unknown tag or token and 400 for a bad query', async () => {
    const unknown = await keys('tag=checkout-v2&tag=nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
      'Phrase project has no tag nope.',
    );
    expect(
      (await inject('GET', '/api/phrase/tokens/nope/projects/p1/keys?scope=all')).statusCode,
    ).toBe(404);
    for (const query of ['', 'scope=all&tag=legacy', 'scope=some', 'tag=', 'tag=a&tag=a']) {
      expect((await keys(query)).statusCode, query).toBe(400);
    }
    // Phrase refusing the token is Phrase's error, not the request's.
    phrase.token = 'revoked';
    expect((await keys('scope=all')).statusCode).toBe(502);
  });
});

describe('validating the folder', () => {
  const validate = async (folderName: string, parentDir = parent) =>
    (await inject('POST', '/api/phrase/checkout/validate', { parentDir, folderName })).json<{
      error: string | null;
    }>().error;

  it('says what is wrong with the name, in the dialog copy', async () => {
    expect(await validate('web-checkout')).toBeNull();
    expect(await validate('  ')).toBe('Enter a folder name.');
    expect(await validate('a/b')).toBe("A folder name can't contain / or :");
    expect(await validate('a:b')).toBe("A folder name can't contain / or :");
    expect(await validate('x', '/definitely/outside')).toBe(
      'This folder is outside the folders Lexi may write to.',
    );
  });

  it('refuses a folder with something in it, and accepts an empty one', async () => {
    await mkdir(join(parent, 'empty'), { recursive: true });
    await mkdir(join(parent, 'full'), { recursive: true });
    await writeFile(join(parent, 'full', 'x.txt'), 'x', 'utf8');
    expect(await validate('empty')).toBeNull();
    expect(await validate('full')).toBe('This folder already exists. Choose another name.');

    const res = await checkout({ folderName: 'full' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'This folder already exists. Choose another name.',
    );
    expect(events).toEqual([]);

    expect((await checkout({ folderName: 'empty' })).statusCode).toBe(200);
  });
});

describe('POST /api/phrase/checkout', () => {
  it('writes the project, its origin and push config, and lists it in the recents', async () => {
    const res = await checkout();
    expect(res.statusCode).toBe(200);
    const target = join(await realpath(base), 'projects', 'web-checkout');
    const result = res.json<PhraseCheckoutResult>();
    expect(result).toEqual({
      path: target,
      keys: 3,
      files: [
        'messages.xlf',
        'messages.de-DE.xlf',
        'messages.fr-FR.xlf',
        '.lexi/project.json',
        '.lexi/phrase.json',
        '.phrase.yml',
      ],
    });

    // The base: source text, notes, no target-language, no targets.
    const baseText = await readFile(join(target, 'messages.xlf'), 'utf8');
    expect(baseText).toContain(
      '<file source-language="en-GB" datatype="plaintext" original="ng2.template">',
    );
    expect(baseText).not.toContain('target-language');
    const units = scan(baseText).files[0]!.units;
    expect(units.map((u) => [u.id, u.sourcePlain, u.notes.map((n) => n.text)])).toEqual([
      ['checkout.pay', 'Pay {amount} now & go', ['Main button']],
      ['checkout.items', '{count} items', ['Plural key in Phrase']],
      ['checkout.blank', '', []],
    ]);
    expect(units.every((u) => u.target === undefined)).toBe(true);

    const de = await readFile(join(target, 'messages.de-DE.xlf'), 'utf8');
    expect(de).toContain('target-language="de-DE"');
    expect(de.match(/<target state="new"><\/target>/g)).toHaveLength(3);

    const project = JSON.parse(
      await readFile(join(target, '.lexi', 'project.json'), 'utf8'),
    ) as unknown;
    expect(project).toEqual({
      version: 1,
      sourceLocale: 'en-GB',
      visibleLocales: [],
      mapping: [
        { relPath: 'messages.xlf', fileIndex: 0, locale: 'en-GB' },
        { relPath: 'messages.de-DE.xlf', fileIndex: 0, locale: 'de-DE' },
        { relPath: 'messages.fr-FR.xlf', fileIndex: 0, locale: 'fr-FR' },
      ],
    });
    expect(await readFile(join(target, '.lexi', '.gitignore'), 'utf8')).toContain('drafts.json');

    const origin = JSON.parse(
      await readFile(join(target, '.lexi', 'phrase.json'), 'utf8'),
    ) as PhraseOrigin;
    expect(origin).toMatchObject({
      region: 'EU',
      projectId: 'p1',
      projectName: 'Project p1',
      scope: { kind: 'tags', tags: ['checkout-v2'] },
      baseLocale: 'en-GB',
      locales: ['de-DE', 'fr-FR'],
      keyIds: ['k1', 'k2', 'k3'],
      tokenRef: tokenId,
    });
    expect(origin).not.toHaveProperty('tag');
    expect(JSON.stringify(origin)).not.toContain('good-token');

    const yml = await readFile(join(target, '.phrase.yml'), 'utf8');
    expect(yml).toContain('project_id: p1');
    expect(yml).toContain('tags: checkout-v2');
    expect(yml).not.toContain('./messages.xlf');
    expect(yml).not.toMatch(/host:/);
    expect(yml.match(/- file:/g)).toHaveLength(2);
    // Pinned by Phrase locale id, so a push can never be read as another locale.
    expect(yml).toContain('locale_id: loc-de # de (de-DE)');
    expect(yml).toContain('locale_id: loc-fr # fr (fr-FR)');
    // Translations only, so their XLIFF source side is never imported.
    expect(yml.match(/ignore_source_translations: true/g)).toHaveLength(2);

    // Nothing left beside it.
    expect(await readdir(parent)).toEqual(['web-checkout']);

    const recents = (await inject('GET', '/api/recents')).json<RecentsResponse>().recents;
    expect(recents[0]).toMatchObject({
      path: target,
      name: 'web-checkout',
      exists: true,
      origin: { kind: 'phrase', tags: ['checkout-v2'] },
      coverage: { translated: 0, draft: 0, needsReview: 0 },
    });
    expect((await inject('GET', '/api/settings')).json<Settings>().launch.lastParentDir).toBe(
      join(await realpath(base), 'projects'),
    );

    // The six rows, in order, each ending done.
    expect(events.filter((e) => e.state === 'done').map((e) => [e.step, e.detail])).toEqual([
      ['fetch-keys', '3 keys · 1 request'],
      ['fetch-base', '2 translations · 1 key has no base text'],
      ['write-base', 'source-language="en-GB" · 3 units'],
      ['write-targets', 'de-DE, fr-FR'],
      ['write-origin', 'Phrase project, tag, key ids, fetch time'],
      ['add-recent', 'Shown in the launch menu'],
    ]);

    // And it opens without the wizard.
    const resumed = await inject('POST', '/api/projects/resume', { path: target });
    const body = resumed.json<ProjectResumeResponse & { project?: Project }>();
    expect(body.needsSetup).toBe(false);
    expect(body.project?.sourceLocale).toBe('en-GB');
    expect(body.project?.files.map((f) => [f.relPath, f.locale]).sort()).toEqual([
      ['messages.de-DE.xlf', 'de-DE'],
      ['messages.fr-FR.xlf', 'fr-FR'],
      ['messages.xlf', 'en-GB'],
    ]);
  });

  it('checks out every key without a tag query or push tags', async () => {
    const res = await checkout({ scope: { kind: 'all' }, folderName: 'everything' });
    expect(res.statusCode).toBe(200);
    const result = res.json<PhraseCheckoutResult>();
    expect(result.keys).toBe(4);
    const units = scan(await readFile(join(result.path, 'messages.xlf'), 'utf8')).files[0]!.units;
    expect(units.map((u) => [u.id, u.sourcePlain])).toEqual([
      ['checkout.pay', 'Pay {amount} now & go'],
      ['checkout.items', '{count} items'],
      ['checkout.blank', ''],
      ['legacy.title', 'Old'],
    ]);
    const listed = phrase.requests.filter(
      (r) => r.url.includes('/keys?') || r.url.includes('/translations?'),
    );
    expect(listed).toHaveLength(2);
    expect(listed.every((r) => !new URL(r.url).searchParams.has('q'))).toBe(true);

    const origin = JSON.parse(
      await readFile(join(result.path, '.lexi', 'phrase.json'), 'utf8'),
    ) as PhraseOrigin;
    expect(origin.scope).toEqual({ kind: 'all' });
    expect(origin.keyIds).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(await readFile(join(result.path, '.phrase.yml'), 'utf8')).not.toMatch(/tags:/);

    const recents = (await inject('GET', '/api/recents')).json<RecentsResponse>().recents;
    expect(recents[0]?.origin).toEqual({ kind: 'phrase', tags: [] });
    expect(events.find((e) => e.step === 'fetch-keys' && e.state === 'done')?.detail).toBe(
      '4 keys · 1 request',
    );
    expect(events.find((e) => e.step === 'write-origin' && e.state === 'done')?.detail).toBe(
      'Phrase project, key ids, fetch time',
    );
  });

  it('checks out the union of two overlapping tags, each key once', async () => {
    phrase.keys.push({ id: 'k5', name: 'shared.ok', tags: ['legacy', 'checkout-v2'], base: 'OK' });
    const res = await checkout({
      scope: { kind: 'tags', tags: ['checkout-v2', 'legacy'] },
      folderName: 'two-tags',
    });
    expect(res.statusCode).toBe(200);
    const result = res.json<PhraseCheckoutResult>();
    expect(result.keys).toBe(5);
    const baseText = await readFile(join(result.path, 'messages.xlf'), 'utf8');
    const units = scan(baseText).files[0]!.units;
    expect(units.map((u) => [u.id, u.sourcePlain])).toEqual([
      ['checkout.pay', 'Pay {amount} now & go'],
      ['checkout.items', '{count} items'],
      ['checkout.blank', ''],
      ['shared.ok', 'OK'],
      ['legacy.title', 'Old'],
    ]);
    const de = await readFile(join(result.path, 'messages.de-DE.xlf'), 'utf8');
    expect(de.match(/<target state="new"><\/target>/g)).toHaveLength(5);

    const keyQueries = phrase.requests
      .filter((r) => r.url.includes('/keys?'))
      .map((r) => new URL(r.url).searchParams.get('q'));
    expect(keyQueries).toEqual(['tags:checkout-v2', 'tags:legacy']);

    const origin = JSON.parse(
      await readFile(join(result.path, '.lexi', 'phrase.json'), 'utf8'),
    ) as PhraseOrigin;
    expect(origin.scope).toEqual({ kind: 'tags', tags: ['checkout-v2', 'legacy'] });
    expect(origin.keyIds).toEqual(['k1', 'k2', 'k3', 'k5', 'k4']);

    // `tags` sits on the target sources only; the base is never pushed.
    const yml = await readFile(join(result.path, '.phrase.yml'), 'utf8');
    expect(yml.match(/tags: checkout-v2,legacy/g)).toHaveLength(2);
    expect(yml).not.toContain('./messages.xlf');

    expect(events.filter((e) => e.step === 'fetch-keys').map((e) => e.detail)).toEqual([
      '',
      '4 keys · tag 1/2',
      '6 keys · tag 2/2',
      '5 keys · 2 requests',
    ]);
    expect(events.find((e) => e.step === 'fetch-base' && e.state === 'done')?.detail).toBe(
      '4 translations · 1 key has no base text',
    );
    const recents = (await inject('GET', '/api/recents')).json<RecentsResponse>().recents;
    expect(recents[0]?.origin).toEqual({ kind: 'phrase', tags: ['checkout-v2', 'legacy'] });
  });

  it('pages through keys and writes host for a US token', async () => {
    await app.close();
    phrase.pageSize = 1;
    await boot();
    // A US token: the same fake answers on every host.
    const us = (
      await inject('POST', '/api/phrase/tokens', { note: 'US', token: 'good-token', region: 'US' })
    ).json<PhraseToken>();
    phrase.requests.length = 0;

    const res = await checkout({ tokenId: us.id, locales: ['de-DE'] });
    expect(res.statusCode).toBe(200);
    expect(phrase.requests.filter((r) => r.url.includes('/keys?'))).toHaveLength(3);
    expect(
      phrase.requests.every((r) => r.url.startsWith('https://api.us.app.phrase.com/v2/')),
    ).toBe(true);
    const target = res.json<PhraseCheckoutResult>().path;
    expect(await readFile(join(target, '.phrase.yml'), 'utf8')).toContain(
      'host: https://api.us.app.phrase.com/v2',
    );
  });

  it('waits out a rate limit and says so in the running row', async () => {
    phrase.rateLimited = 2;
    const res = await checkout();
    expect(res.statusCode).toBe(200);
    expect(events.filter((e) => e.state === 'waiting')).toEqual([
      {
        type: 'phrase-checkout-progress',
        step: 'fetch-keys',
        state: 'waiting',
        detail: 'Waiting for Phrase rate limit…',
      },
      {
        type: 'phrase-checkout-progress',
        step: 'fetch-keys',
        state: 'waiting',
        detail: 'Waiting for Phrase rate limit…',
      },
    ]);
  });

  it('can be cancelled while fetching, and leaves nothing behind', async () => {
    let release = (): void => undefined;
    phrase.hold = new Promise<void>((r) => (release = r));
    const running = checkout();
    // Wait until the keys request is in flight.
    for (let i = 0; i < 100 && !phrase.requests.some((r) => r.url.includes('/keys?')); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await checkout({ folderName: 'second' })).statusCode).toBe(409);
    expect((await inject('POST', '/api/phrase/checkout/cancel')).statusCode).toBe(204);
    const res = await running;
    release();
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Checkout cancelled.');
    expect(events.at(-1)).toMatchObject({ step: 'fetch-keys', state: 'failed' });
    expect(await readdir(parent).catch(() => [])).toEqual([]);
    expect((await inject('GET', '/api/recents')).json<RecentsResponse>().recents).toEqual([]);
    // Nothing running any more.
    expect((await inject('POST', '/api/phrase/checkout/cancel')).statusCode).toBe(204);
  });

  it('removes the partial folder when a write fails', async () => {
    await app.close();
    await boot({
      beforeCheckoutRename: async () => {
        throw Object.assign(new Error('disk full at /secret/path'), { code: 'ENOSPC' });
      },
    });
    const res = await checkout();
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'Could not write the project (ENOSPC).',
    );
    expect(events.at(-1)).toMatchObject({ step: 'write-origin', state: 'failed' });
    expect(await readdir(parent)).toEqual([]);
    expect((await inject('GET', '/api/recents')).json<RecentsResponse>().recents).toEqual([]);
  });

  it('fails a tag with no keys and a locale the project lacks', async () => {
    const none = await checkout({ scope: { kind: 'tags', tags: ['nothing', 'neither'] } });
    expect(none.statusCode).toBe(400);
    expect(none.json<{ error: { message: string } }>().error.message).toBe(
      'No keys are tagged nothing, neither.',
    );
    phrase.keys.length = 0;
    const empty = await checkout({ scope: { kind: 'all' } });
    expect(empty.json<{ error: { message: string } }>().error.message).toBe(
      'This project has no keys.',
    );
    const unknown = await checkout({ locales: ['ja'] });
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
      'The Phrase project has no locale ja.',
    );
    expect(await readdir(parent).catch(() => [])).toEqual([]);
  });
});

describe('checking out from a branch', () => {
  /** release-2 has its own keys, and its own locale ids. */
  const useBranch = (): void => {
    phrase.branchKeys.set('release-2', [
      { id: 'b1', name: 'release.title', tags: ['rc'], base: 'Release' },
      { id: 'b2', name: 'release.body', tags: ['rc', 'docs'], base: 'Body' },
    ]);
    phrase.branchLocales.set('release-2', [
      { id: 'bloc-de', name: 'de', code: 'de-DE' },
      { id: 'bloc-en', name: 'en-GB', code: 'en-GB', default: true },
      { id: 'bloc-fr', name: 'fr', code: 'fr-FR' },
    ]);
  };
  const enc = encodeURIComponent;
  const base_ = '/api/phrase/tokens';

  it('lists only the open branches', async () => {
    const res = await inject('GET', `${base_}/${enc(tokenId)}/projects/p1/branches`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ branches: Array<{ name: string }> }>().branches.map((b) => b.name)).toEqual([
      'feature-x',
      'release-2',
    ]);
  });

  it('reads locales, tags, preview and keys from the branch', async () => {
    useBranch();
    const root = `${base_}/${enc(tokenId)}/projects/p1`;

    const detail = await inject('GET', `${root}?branch=release-2`);
    expect(detail.json<PhraseProjectDetail>().locales.map((l) => l.id)).toEqual([
      'bloc-de',
      'bloc-en',
      'bloc-fr',
    ]);

    const tags = await inject('GET', `${root}/tags?branch=release-2`);
    expect(tags.json<PhraseTagsResponse>().tags.map((t) => [t.name, t.keysCount])).toEqual([
      ['docs', 1],
      ['rc', 2],
    ]);

    const preview = await inject('GET', `${root}/preview?tag=rc&branch=release-2`);
    expect(preview.json<PhraseScopePreview>()).toMatchObject({
      keysCount: 2,
      sample: [
        { key: 'release.title', text: 'Release' },
        { key: 'release.body', text: 'Body' },
      ],
    });

    const keys = await inject('GET', `${root}/keys?scope=all&branch=release-2`);
    expect(keys.json<PhraseScopeKeys>().keys.map((k) => k.key)).toEqual([
      'release.title',
      'release.body',
    ]);

    // Without the parameter: still the main project.
    const main = await inject('GET', `${root}/keys?scope=all`);
    expect(main.json<PhraseScopeKeys>().keys).toHaveLength(4);
  });

  it('checks out the branch’s keys and remembers the branch for a push', async () => {
    useBranch();
    const res = await checkout({
      branch: 'release-2',
      scope: { kind: 'tags', tags: ['rc'] },
      folderName: 'release',
    });
    expect(res.statusCode).toBe(200);
    const target = join(parent, 'release');
    expect(res.json<PhraseCheckoutResult>().keys).toBe(2);

    const units = scan(await readFile(join(target, 'messages.xlf'), 'utf8')).files[0]!.units;
    expect(units.map((u) => u.id)).toEqual(['release.title', 'release.body']);

    const origin = JSON.parse(
      await readFile(join(target, '.lexi', 'phrase.json'), 'utf8'),
    ) as PhraseOrigin;
    expect(origin).toMatchObject({ branch: 'release-2', keyIds: ['b1', 'b2'] });

    const yml = await readFile(join(target, '.phrase.yml'), 'utf8');
    expect(yml.match(/branch: release-2/g)).toHaveLength(2);
    // The branch's own locale ids, not the main project's.
    expect(yml).toContain('locale_id: bloc-de');
    expect(yml).not.toContain('locale_id: loc-de');

    expect(events.find((e) => e.step === 'write-origin' && e.state === 'done')?.detail).toBe(
      'Phrase project, branch, tag, key ids, fetch time',
    );
    // Every read of the checkout went to the branch.
    const reads = phrase.requests.filter((r) => /\/(keys|translations|locales)\b/.test(r.url));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.url.includes('branch=release-2'))).toBe(true);
  });

  it('writes no branch for a main-project checkout', async () => {
    const res = await checkout();
    expect(res.statusCode).toBe(200);
    const target = join(parent, 'web-checkout');
    expect(await readFile(join(target, '.phrase.yml'), 'utf8')).not.toContain('branch:');
    const origin = JSON.parse(
      await readFile(join(target, '.lexi', 'phrase.json'), 'utf8'),
    ) as PhraseOrigin;
    expect(origin.branch ?? null).toBeNull();
  });

  it('answers 404 for a branch that is not open, and leaves nothing behind', async () => {
    const merged = await checkout({ branch: 'done' });
    expect(merged.statusCode).toBe(404);
    expect(merged.json<{ error: { message: string } }>().error.message).toBe(
      'Phrase project has no open branch done.',
    );
    expect(await readdir(parent).catch(() => [])).toEqual([]);
  });
});
