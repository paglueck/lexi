// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateState, UpdateStatus } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import type { Updater } from '../src/lib/updater.js';
import { freePort, goodHeaders, readFrames, testConfig, TEST_TOKEN } from './helpers.js';

/**
 * `/api/update` forwards the desktop shell's updater. What is under test is the
 * forwarding — the guards around each action, and that every state change
 * reaches the SSE stream — so the updater is a fake that records its calls.
 */

class FakeUpdater implements Updater {
  readonly mode = 'dmg' as const;
  readonly calls: string[] = [];
  #state: UpdateState = { phase: 'idle' };
  readonly #listeners = new Set<(state: UpdateState) => void>();
  /** What the next `check()` settles into. */
  next: UpdateState = { phase: 'available', version: '9.9.9', releaseNotes: '- Neu' };

  state(): UpdateState {
    return this.#state;
  }
  async check(): Promise<void> {
    this.calls.push('check');
    this.set({ phase: 'checking' });
    this.set(this.next);
  }
  async download(): Promise<void> {
    this.calls.push('download');
    this.set({ phase: 'downloading', version: '9.9.9', percent: 0 });
  }
  install(): void {
    this.calls.push('install');
  }
  onChange(listener: (state: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  set(state: UpdateState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const post = (action: string): Promise<LightMyRequestResponse> =>
  app!.inject({
    method: 'POST',
    url: `/api/update/${action}`,
    headers: goodHeaders(),
    payload: {},
  });

const status = async (): Promise<UpdateStatus> => {
  const res = await app!.inject({ method: 'GET', url: '/api/update', headers: goodHeaders() });
  expect(res.statusCode).toBe(200);
  return res.json<UpdateStatus>();
};

describe('without an updater', () => {
  it('answers GET with supported: false, and refuses the actions', async () => {
    app = await buildApp(testConfig(), { logger: false });
    expect(await status()).toEqual({
      supported: false,
      currentVersion: '0.0.0-test',
      mode: 'auto',
      state: { phase: 'idle' },
    });
    expect((await post('check')).statusCode).toBe(404);
    expect((await post('download')).statusCode).toBe(404);
    expect((await post('install')).statusCode).toBe(404);
  });
});

describe('with an updater', () => {
  it('reports the mode and the current state', async () => {
    const updater = new FakeUpdater();
    app = await buildApp(testConfig(), { logger: false, updater });
    expect(await status()).toMatchObject({
      supported: true,
      mode: 'dmg',
      state: { phase: 'idle' },
    });
  });

  it('waits for the check and answers with what it found', async () => {
    const updater = new FakeUpdater();
    app = await buildApp(testConfig(), { logger: false, updater });
    const res = await post('check');
    expect(res.statusCode).toBe(200);
    expect(res.json<UpdateStatus>().state).toEqual({
      phase: 'available',
      version: '9.9.9',
      releaseNotes: '- Neu',
    });
  });

  it('refuses a download before an update was found, and an install before it was downloaded', async () => {
    const updater = new FakeUpdater();
    app = await buildApp(testConfig(), { logger: false, updater });
    expect((await post('download')).statusCode).toBe(409);
    expect((await post('install')).statusCode).toBe(409);
    expect(updater.calls).toEqual([]);
  });

  it('starts the download without waiting for it', async () => {
    const updater = new FakeUpdater();
    app = await buildApp(testConfig(), { logger: false, updater });
    await post('check');
    const res = await post('download');
    expect(res.statusCode).toBe(202);
    expect(res.json<UpdateStatus>().state.phase).toBe('downloading');
    // A second click, or a check, while it runs changes nothing.
    expect((await post('download')).statusCode).toBe(200);
    expect((await post('check')).statusCode).toBe(200);
    expect(updater.calls).toEqual(['check', 'download']);
  });

  it('installs only once the reply has gone out', async () => {
    const updater = new FakeUpdater();
    app = await buildApp(testConfig(), { logger: false, updater });
    updater.set({ phase: 'ready', version: '9.9.9', releaseNotes: null });
    const res = await post('install');
    expect(res.statusCode).toBe(202);
    expect(updater.calls).toEqual(['install']);
  });

  it('forwards every state change to the SSE stream', async () => {
    const updater = new FakeUpdater();
    let base = '';
    for (let attempt = 0; ; attempt++) {
      const port = await freePort();
      const candidate = await buildApp(testConfig({ port, heartbeatMs: 60_000 }), {
        logger: false,
        updater,
      });
      try {
        await candidate.listen({ host: '127.0.0.1', port });
        app = candidate;
        base = `http://127.0.0.1:${port}`;
        break;
      } catch (error) {
        await candidate.close();
        if ((error as { code?: string }).code !== 'EADDRINUSE' || attempt >= 4) throw error;
      }
    }

    const res = await fetch(`${base}/api/events?token=${TEST_TOKEN}`);
    const frames = readFrames(res.body!, 3);
    // Give the stream a moment to register before publishing into it.
    await new Promise((r) => setTimeout(r, 50));
    await updater.check();

    const got = await frames;
    expect(got.map((f) => f.event)).toEqual(['hello', 'update', 'update']);
    expect(got.slice(1).map((f) => JSON.parse(f.data) as unknown)).toEqual([
      { type: 'update', state: { phase: 'checking' } },
      { type: 'update', state: { phase: 'available', version: '9.9.9', releaseNotes: '- Neu' } },
    ]);
  });
});
