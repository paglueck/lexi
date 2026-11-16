// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PhraseToken,
  PhraseTokenVerifyResponse,
  PhraseTokensResponse,
  Settings,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { goodHeaders, testConfig } from './helpers.js';
import { fakePhrase, type FakePhrase } from './phrase-fake.js';

/**
 * S19 — saved Phrase tokens. The one property every test here leans on: the
 * secret goes in and never comes out, in any answer.
 */

const SECRET = 'good-token';

let base: string;
let stateDir: string;
let app: FastifyInstance;
let phrase: FakePhrase;
/** Every body the app sent back, so the last test can search them all. */
let bodies: string[];

const boot = async (): Promise<FastifyInstance> =>
  buildApp(testConfig({ roots: [base], stateDir }), {
    logger: false,
    phrase: { fetch: phrase.fetch, pollIntervalMs: 0, env: {}, delay: async () => undefined },
  });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-phrase-tokens-')));
  stateDir = join(base, 'state');
  phrase = fakePhrase();
  bodies = [];
  app = await boot();
});

afterEach(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const inject = async (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => {
  const res = await app.inject({
    method,
    url,
    headers: goodHeaders(),
    ...(payload === undefined ? {} : { payload }),
  });
  bodies.push(res.body);
  return res;
};

const add = async (note = 'Work', token = SECRET, region = 'EU') =>
  inject('POST', '/api/phrase/tokens', { note, token, region });

describe('verifying a token', () => {
  it('reports user, org and projects without saving anything', async () => {
    const res = await inject('POST', '/api/phrase/tokens/verify', { token: SECRET, region: 'EU' });
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseTokenVerifyResponse>()).toEqual({
      ok: true,
      detail: '',
      user: 'jdoe',
      org: 'ACME',
      scopes: '',
      projects: [
        { id: 'p1', name: 'App', account: 'ACME' },
        { id: 'p2', name: 'Web', account: 'ACME' },
      ],
    });
    expect((await inject('GET', '/api/phrase/tokens')).json<PhraseTokensResponse>().tokens).toEqual(
      [],
    );
  });

  it('answers ok: false for a rejected token rather than an HTTP error', async () => {
    const res = await inject('POST', '/api/phrase/tokens/verify', { token: 'nope', region: 'EU' });
    expect(res.statusCode).toBe(200);
    expect(res.json<PhraseTokenVerifyResponse>()).toMatchObject({ ok: false, projects: [] });
    expect(res.json<PhraseTokenVerifyResponse>().detail).toMatch(/rejected this token \(401\)/);
  });

  it('talks to the US data center for a US token', async () => {
    await inject('POST', '/api/phrase/tokens/verify', { token: SECRET, region: 'US' });
    expect(
      phrase.requests.every((r) => r.url.startsWith('https://api.us.app.phrase.com/v2/')),
    ).toBe(true);
  });
});

describe('saving and editing tokens', () => {
  it('saves a verified token with what Phrase said, and 400s a rejected one', async () => {
    const res = await add();
    expect(res.statusCode).toBe(201);
    const token = res.json<PhraseToken>();
    expect(token).toMatchObject({
      note: 'Work',
      region: 'EU',
      suffix: 'oken',
      user: 'jdoe',
      org: 'ACME',
      status: 'ok',
    });
    expect(token.projects).toHaveLength(2);
    expect(token.checkedAt).not.toBeNull();

    expect((await add('Bad', 'nope')).statusCode).toBe(400);
    expect(
      (await inject('GET', '/api/phrase/tokens')).json<PhraseTokensResponse>().tokens,
    ).toHaveLength(1);

    const onDisk = JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8')) as {
      phrase: { tokens: Array<{ secret: string }> };
    };
    expect(onDisk.phrase.tokens[0]?.secret).toBe(SECRET);
  });

  it('edits the note, and a new data center makes the token unchecked', async () => {
    const { id } = (await add()).json<PhraseToken>();
    const noted = await inject('PATCH', `/api/phrase/tokens/${id}`, { note: 'Client X' });
    expect(noted.json<PhraseToken>()).toMatchObject({ note: 'Client X', status: 'ok' });
    const moved = await inject('PATCH', `/api/phrase/tokens/${id}`, { region: 'US' });
    expect(moved.json<PhraseToken>()).toMatchObject({ region: 'US', status: 'unchecked' });
    expect((await inject('PATCH', '/api/phrase/tokens/nope', { note: 'x' })).statusCode).toBe(404);
  });

  it('marks a revoked token bad on a check and keeps its last projects', async () => {
    const { id } = (await add()).json<PhraseToken>();
    phrase.token = 'rotated-token';
    const checked = (await inject('POST', `/api/phrase/tokens/${id}/check`)).json<PhraseToken>();
    expect(checked.status).toBe('bad');
    expect(checked.projects).toHaveLength(2);

    // Replacing the secret verifies the new one first.
    expect(
      (await inject('PUT', `/api/phrase/tokens/${id}/secret`, { token: 'still-wrong' })).statusCode,
    ).toBe(400);
    const replaced = await inject('PUT', `/api/phrase/tokens/${id}/secret`, {
      token: 'rotated-token',
    });
    expect(replaced.json<PhraseToken>()).toMatchObject({ status: 'ok', suffix: 'oken' });
  });

  it('removes a token', async () => {
    const { id } = (await add()).json<PhraseToken>();
    expect((await inject('DELETE', `/api/phrase/tokens/${id}`)).statusCode).toBe(204);
    expect((await inject('DELETE', `/api/phrase/tokens/${id}`)).statusCode).toBe(404);
    expect((await inject('GET', '/api/settings')).json<Settings>().phrase.tokens).toEqual([]);
  });

  it('never sends a secret back, in any answer', async () => {
    const { id } = (await add()).json<PhraseToken>();
    await inject('GET', '/api/phrase/tokens');
    await inject('GET', '/api/settings');
    await inject('POST', `/api/phrase/tokens/${id}/check`);
    await inject('PUT', `/api/phrase/tokens/${id}/secret`, { token: SECRET });
    await inject('PATCH', `/api/phrase/tokens/${id}`, { note: 'n' });
    expect(bodies.length).toBeGreaterThan(5);
    for (const body of bodies) expect(body).not.toContain(SECRET);
  });
});

describe('the single token of an older settings file', () => {
  it('becomes "Default token" (EU, unchecked) and the push uses it', async () => {
    await app.close();
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ version: 1, phrase: { accessToken: SECRET } }),
      'utf8',
    );
    app = await boot();

    const tokens = (await inject('GET', '/api/phrase/tokens')).json<PhraseTokensResponse>().tokens;
    expect(tokens).toEqual([
      {
        id: 'default',
        note: 'Default token',
        region: 'EU',
        suffix: 'oken',
        user: '',
        org: '',
        scopes: '',
        projects: [],
        status: 'unchecked',
        checkedAt: null,
      },
    ]);
    const test = await inject('POST', '/api/phrase/test');
    expect(test.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('keeps the launch settings across a restart', async () => {
    await inject('PATCH', '/api/settings', { showLaunchMenu: false });
    await app.close();
    app = await boot();
    expect((await inject('GET', '/api/settings')).json<Settings>().launch).toEqual({
      showMenu: false,
      lastParentDir: null,
    });
  });
});
