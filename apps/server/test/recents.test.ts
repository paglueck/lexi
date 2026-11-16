// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecentsResponse } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { recentIdFor } from '../src/lib/recents.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * S17's launch menu reads the recents: whether each folder is still there,
 * whether it came from a Phrase checkout, and the two actions on a list that
 * went stale — clear it, or point an entry at the folder's new place.
 */

let base: string;
let stateDir: string;
let app: FastifyInstance;

const entry = (path: string, name: string) => ({
  id: recentIdFor(path),
  path,
  name,
  openedAt: '2026-11-01T10:00:00.000Z',
  localeCount: 2,
  unitCount: 10,
  coverage: { translated: 50, draft: 0, needsReview: 0 },
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-recents-')));
  stateDir = join(base, 'state');
  await mkdir(join(base, 'web', '.lexi'), { recursive: true });
  await writeFile(
    join(base, 'web', '.lexi', 'phrase.json'),
    JSON.stringify({ tag: 'checkout-v2', projectId: 'p1' }),
    'utf8',
  );
  await mkdir(join(base, 'app'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'recents.json'),
    JSON.stringify([
      entry(join(base, 'web'), 'web'),
      entry(join(base, 'app'), 'app'),
      entry(join(base, 'moved'), 'moved'),
    ]),
    'utf8',
  );
  app = await buildApp(testConfig({ roots: [base], stateDir }), { logger: false });
});

afterEach(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: goodHeaders(),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

describe('GET /api/recents', () => {
  it('says which folders exist and which came from Phrase', async () => {
    const { recents } = (await inject('GET', '/api/recents')).json<RecentsResponse>();
    expect(recents.map((r) => [r.name, r.exists, r.origin])).toEqual([
      ['web', true, { kind: 'phrase', tags: ['checkout-v2'] }],
      ['app', true, undefined],
      ['moved', false, undefined],
    ]);
    // Served, never stored.
    expect(await readFile(join(stateDir, 'recents.json'), 'utf8')).not.toContain('exists');
  });

  it('reads the scope of a newer phrase.json, all keys as no tags', async () => {
    const write = (scope: unknown) =>
      writeFile(
        join(base, 'web', '.lexi', 'phrase.json'),
        JSON.stringify({ scope, tag: 'ignored', projectId: 'p1' }),
        'utf8',
      );
    const originOf = async () =>
      (await inject('GET', '/api/recents')).json<RecentsResponse>().recents[0]?.origin;

    await write({ kind: 'tags', tags: ['a', 'b'] });
    expect(await originOf()).toEqual({ kind: 'phrase', tags: ['a', 'b'] });
    await write({ kind: 'all' });
    expect(await originOf()).toEqual({ kind: 'phrase', tags: [] });
  });
});

describe('DELETE /api/recents', () => {
  it('clears the list', async () => {
    expect((await inject('DELETE', '/api/recents')).statusCode).toBe(204);
    expect((await inject('GET', '/api/recents')).json<RecentsResponse>().recents).toEqual([]);
  });
});

describe('POST /api/recents/:id/locate', () => {
  it('points the entry at the new folder and keeps its place', async () => {
    await mkdir(join(base, 'found'), { recursive: true });
    const res = await inject('POST', `/api/recents/${recentIdFor(join(base, 'moved'))}/locate`, {
      path: join(base, 'found'),
    });
    expect(res.statusCode).toBe(200);
    const { recents } = res.json<RecentsResponse>();
    expect(recents.map((r) => [r.name, r.path, r.exists])).toEqual([
      ['web', join(base, 'web'), true],
      ['app', join(base, 'app'), true],
      ['moved', join(base, 'found'), true],
    ]);
    expect(recents[2]?.id).toBe(recentIdFor(join(base, 'found')));
  });

  it('refuses a missing folder, a path outside the roots, and an unknown id', async () => {
    const id = recentIdFor(join(base, 'moved'));
    expect(
      (await inject('POST', `/api/recents/${id}/locate`, { path: join(base, 'nope') })).statusCode,
    ).toBe(404);
    expect((await inject('POST', `/api/recents/${id}/locate`, { path: '/' })).statusCode).toBe(403);
    expect(
      (await inject('POST', '/api/recents/unknown/locate', { path: join(base, 'app') })).statusCode,
    ).toBe(404);
  });
});
