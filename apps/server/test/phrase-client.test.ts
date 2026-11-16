// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PhraseClient, PhraseError, normaliseHost } from '../src/services/phrase-client.js';
import { fakePhrase } from './phrase-fake.js';

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'lexi-phrase-client-')));
  file = join(dir, 'messages.de.xlf');
  await writeFile(file, '<xliff>de</xliff>', 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const client = (fake = fakePhrase(), token = 'good-token') =>
  new PhraseClient({ token, fetch: fake.fetch, pollIntervalMs: 0 });

describe('PhraseClient', () => {
  it('sends the token the way Phrase expects it', async () => {
    const fake = fakePhrase();
    expect(await client(fake).me()).toEqual({ name: 'Jane Doe', username: 'jdoe' });
    expect(fake.requests[0]).toMatchObject({
      url: 'https://api.phrase.com/v2/user',
      auth: 'token good-token',
    });
  });

  it('refuses to start without a token', () => {
    expect(() => new PhraseClient({ token: ' ' })).toThrow(PhraseError);
  });

  it('turns a 401 into a sentence about the token', async () => {
    await expect(client(fakePhrase(), 'bad').me()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('follows Link pagination and sorts projects by name', async () => {
    const projects = await client().listProjects();
    expect(projects).toEqual([
      { id: 'p1', name: 'App', account: 'ACME' },
      { id: 'p2', name: 'Web', account: 'ACME' },
    ]);
  });

  it('uploads the file with its params and waits until Phrase has processed it', async () => {
    const fake = fakePhrase();
    fake.processingPolls = 3;
    let processing = 0;
    const outcome = await client(fake).upload(
      'p1',
      file,
      {
        file_format: 'xlf',
        locale_id: 'loc-de',
        update_translations: true,
        tags: ['a', 'b'],
        format_options: { x: 1 },
      },
      () => processing++,
    );
    expect(outcome).toMatchObject({
      state: 'success',
      summary: { translation_keys_created: 1 },
      error: null,
    });
    expect(processing).toBe(1);
    expect(fake.uploads[0]).toEqual({
      projectId: 'p1',
      fileName: 'messages.de.xlf',
      fileText: '<xliff>de</xliff>',
      fields: {
        file_format: 'xlf',
        locale_id: 'loc-de',
        update_translations: 'true',
        tags: 'a,b',
        'format_options[x]': '1',
      },
    });
    expect(fake.requests.filter((r) => r.url.includes('/uploads/up1'))).toHaveLength(3);
  });

  it('reports a processing error from Phrase as the outcome, not an exception', async () => {
    const fake = fakePhrase();
    fake.failLocales.add('loc-de');
    const outcome = await client(fake).upload('p1', file, { locale_id: 'loc-de' });
    expect(outcome).toMatchObject({
      state: 'error',
      error: 'Could not parse the file',
      url: 'https://app.phrase.com/uploads/up1',
    });
  });

  it('names the upload in Phrase when Phrase gives no reason for a failure', async () => {
    const silent = (async () =>
      new Response(JSON.stringify({ id: 'u9', state: 'error', url: 'https://app.phrase.com/u9' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const c = new PhraseClient({ token: 't', fetch: silent, pollIntervalMs: 0 });
    const outcome = await c.upload('p1', file, { locale_id: 'loc-de' });
    expect(outcome.error).toBe(
      'Phrase could not process the file and did not say why — see https://app.phrase.com/u9',
    );
  });

  it('waits out a 429 until the reset time, at most three times', async () => {
    const fake = fakePhrase();
    const waits: number[] = [];
    const slept: number[] = [];
    const limited = new PhraseClient({
      token: 'good-token',
      fetch: fake.fetch,
      delay: async (ms) => void slept.push(ms),
      onWait: (ms) => waits.push(ms),
    });
    fake.rateLimited = 3;
    expect((await limited.me()).username).toBe('jdoe');
    expect(waits).toHaveLength(3);
    expect(waits.every((ms) => ms > 0 && ms <= 3000)).toBe(true);
    expect(slept).toEqual(waits);

    fake.rateLimited = 4;
    await expect(limited.me()).rejects.toMatchObject({ kind: 'rate-limit', status: 429 });
  });

  it('reads keys and plural translations for a tag', async () => {
    const c = client();
    expect((await c.listKeys('p1', 'checkout-v2')).map((k) => [k.name, k.plural])).toEqual([
      ['checkout.pay', false],
      ['checkout.items', true],
      ['checkout.blank', false],
    ]);
    const rows = await c.listTranslations('p1', 'loc-en', { tag: 'checkout-v2' });
    expect(rows.map((r) => [r.keyId, r.pluralSuffix, r.content])).toEqual([
      ['k1', '', 'Pay {amount} now & go'],
      ['k2', 'one', '1 item'],
      ['k2', 'other', '{count} items'],
    ]);
    expect((await c.listLocales('p1')).find((l) => l.isDefault)?.code).toBe('en-GB');
  });

  it('lists the open branches by name, across pages, and reads locales of one', async () => {
    const fake = fakePhrase();
    fake.pageSize = 2;
    const c = client(fake);
    expect(await c.listBranches('p1')).toEqual([
      { name: 'feature-x', updatedAt: null },
      { name: 'release-2', updatedAt: '2026-11-01T09:00:00Z' },
    ]);
    await c.listLocales('p1', { branch: 'feature x' });
    expect(fake.requests.at(-1)?.url).toMatch(/\/projects\/p1\/locales\?branch=feature%20x&/);
    await c.listLocales('p1');
    expect(fake.requests.at(-1)?.url).not.toMatch(/branch=/);
  });

  it('lists every key without a search, and reads the key total', async () => {
    const fake = fakePhrase();
    const c = client(fake);
    expect((await c.listKeys('p1', undefined)).map((k) => k.id)).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect((await c.listTranslations('p1', 'loc-en')).map((r) => r.keyId)).toEqual([
      'k1',
      'k2',
      'k2',
      'k4',
    ]);
    expect(fake.requests.every((r) => !new URL(r.url).searchParams.has('q'))).toBe(true);

    expect(await c.localeStatistics('p1', 'loc-en')).toBe(4);
    expect(fake.requests.at(-1)?.url).toBe('https://api.phrase.com/v2/projects/p1/locales/loc-en');
    fake.localeStatistics = false;
    expect(await c.localeStatistics('p1', 'loc-en')).toBeNull();
  });

  it('quotes a tag with a space in the search', async () => {
    const fake = fakePhrase();
    await client(fake).listKeys('p1', 'release 2');
    expect(new URL(fake.requests[0]!.url).searchParams.get('q')).toBe('tags:"release 2"');
  });

  it('stops at once when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client().listKeys('p1', 'x', { signal: controller.signal })).rejects.toMatchObject(
      { kind: 'aborted' },
    );
  });

  it('normalises a host with or without scheme and trailing slash', () => {
    expect(normaliseHost('api.us.app.phrase.com/v2/')).toBe('https://api.us.app.phrase.com/v2');
    expect(normaliseHost('')).toBe('https://api.phrase.com/v2');
  });
  it('reads tags, keys, translations and statistics from a branch', async () => {
    const fake = fakePhrase();
    fake.branchKeys.set('release-2', [{ id: 'b1', name: 'only.here', tags: ['rc'], base: 'Hi' }]);
    const c = client(fake);

    expect((await c.listTags('p1', { branch: 'release-2' })).map((t) => t.name)).toEqual(['rc']);
    expect((await c.listKeys('p1', 'rc', { branch: 'release-2' })).map((k) => k.name)).toEqual([
      'only.here',
    ]);
    expect(
      (await c.listTranslations('p1', 'loc-en', { tag: 'rc', branch: 'release-2' })).map(
        (t) => t.content,
      ),
    ).toEqual(['Hi']);
    expect(await c.localeStatistics('p1', 'loc-en', { branch: 'release-2' })).toBe(1);

    const urls = fake.requests.map((r) => new URL(r.url));
    expect(urls.every((u) => u.searchParams.get('branch') === 'release-2')).toBe(true);

    // The main project: no branch parameter anywhere.
    fake.requests.length = 0;
    await c.listTags('p1');
    await c.listKeys('p1', undefined);
    await c.localeStatistics('p1', 'loc-en');
    expect(fake.requests.some((r) => r.url.includes('branch='))).toBe(false);
  });
});
