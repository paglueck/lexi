// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The SSE stream, over a real socket — `inject()` cannot stream, and the things
 * most likely to break here (header flushing, buffering, shutdown) only exist
 * on a real socket.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { freePort, readFrames, testConfig, TEST_TOKEN } from './helpers.js';

let app: FastifyInstance | undefined;
let base = '';

/**
 * These tests need a REAL socket — the things most likely to break in SSE
 * (header flushing, buffering, shutdown) only exist on one — and the `Host`
 * allowlist is built from `cfg.port`, so listening on port 0 and discovering
 * the port afterwards is not an option. `freePort` therefore reports a port
 * that was free a moment ago, which is inherently racy: another test file's
 * ephemeral server can take it in between.
 *
 * So the whole start is retried on `EADDRINUSE` rather than the port being
 * picked more cleverly — there is no way to pick one that cannot be taken.
 */
async function start(heartbeatMs = 60): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    const candidate = await buildApp(testConfig({ port, heartbeatMs }), { logger: false });
    try {
      await candidate.listen({ host: '127.0.0.1', port });
      app = candidate;
      base = `http://127.0.0.1:${port}`;
      return;
    } catch (error) {
      await candidate.close();
      const taken = (error as { code?: string }).code === 'EADDRINUSE';
      if (!taken || attempt >= 4) throw error;
    }
  }
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/events', () => {
  it('requires the token as a query parameter, since EventSource cannot set headers', async () => {
    await start();
    expect((await fetch(`${base}/api/events`)).status).toBe(403);
    expect((await fetch(`${base}/api/events?token=nope`)).status).toBe(403);
  });

  it('opens a text/event-stream with the anti-buffering headers', async () => {
    await start();
    const res = await fetch(`${base}/api/events?token=${TEST_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.body?.cancel();
  });

  it('sends hello first, then named heartbeats, each with an id', async () => {
    await start(60);
    const res = await fetch(`${base}/api/events?token=${TEST_TOKEN}`);
    const frames = await readFrames(res.body!, 3);

    expect(frames).toHaveLength(3);
    expect(frames[0]?.event).toBe('hello');
    expect(JSON.parse(frames[0]!.data)).toMatchObject({ type: 'hello', serverId: 'test-server' });

    // A real named event, not a `:` comment — a comment would be invisible both
    // to the client and to this assertion.
    expect(frames[1]?.event).toBe('heartbeat');
    expect(frames[2]?.event).toBe('heartbeat');
    expect(frames.map((f) => f.id)).toEqual(['1', '2', '3']);
  });

  it('delivers heartbeats incrementally rather than in one buffered burst', async () => {
    await start(120);
    const res = await fetch(`${base}/api/events?token=${TEST_TOKEN}`);
    const frames = await readFrames(res.body!, 3);

    // Heartbeats arrive one by one, not in a buffered burst.
    const gap = frames[2]!.at - frames[1]!.at;
    expect(gap).toBeGreaterThan(60);
    expect(gap).toBeLessThan(400);
  });

  it('ends open streams on shutdown instead of hanging on them', async () => {
    await start(10_000);
    const res = await fetch(`${base}/api/events?token=${TEST_TOKEN}`);
    const reader = res.body!.getReader();
    await reader.read(); // the hello frame — the stream is now live

    const started = Date.now();
    await app!.close();
    app = undefined;

    // Without the preClose hook this read never resolves and close() waits out
    // the full grace period, which is what makes Ctrl-C look broken.
    let closed = false;
    while (Date.now() - started < 3000) {
      const { done } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
    }
    expect(closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
