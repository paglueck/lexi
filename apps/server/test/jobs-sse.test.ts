// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A job's progress, over a REAL socket — `app.inject()` cannot stream, and
 * "does the client see progress incrementally, or only once the job is
 * already done" is exactly the question `readFrames`'s per-frame timestamps
 * answer and a mocked transport cannot.
 *
 * Reported from use: a job's card stayed at "0 of N" for its entire run and
 * only showed the final figures after a manual page reload — which is either
 * the server batching its SSE writes until the job finishes, or the events
 * genuinely streaming and something downstream not applying them. This file
 * answers the first half.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rowIdOf, type Job } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { freePort, readFrames, TEST_TOKEN, testConfig } from './helpers.js';

const unit = (id: string, source: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>
      </trans-unit>`;

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

const sourceXlf = xlf(
  'en-GB',
  [unit('a', 'Alpha'), unit('b', 'Bravo'), unit('c', 'Charlie')].join('\n'),
);
const deXlf = xlf('de', '');

const A = rowIdOf('messages', 'a');
const B = rowIdOf('messages', 'b');
const C = rowIdOf('messages', 'c');

let root: string;
let stateDir: string;
let app: FastifyInstance | undefined;
let base = '';

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
  'sec-fetch-site': 'same-origin',
  'x-lexi-token': TEST_TOKEN,
  ...extra,
});

beforeAll(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'lexi-jobs-sse-')));
  root = join(dir, 'app');
  stateDir = join(dir, 'state');
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

/** Retried on `EADDRINUSE`, same reasoning as `events.test.ts`. */
async function start(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    // Heartbeats default to every 50ms in tests; at that rate they would
    // dilute a frame-count-based read window long before three real units
    // finish. Long enough here that none fire during the run.
    const candidate = await buildApp(
      testConfig({ port, stateDir, roots: [root], heartbeatMs: 60_000 }),
      { logger: false },
    );
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

beforeEach(async () => {
  await app?.close();
  app = undefined;
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  for (const name of await readdir(root)) {
    if (name.endsWith('.xlf')) await rm(join(root, name), { force: true });
  }
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), deXlf, 'utf8');
  await start();
  await open();
});

async function open(): Promise<void> {
  const scan = await fetch(`${base}/api/projects/scan`, {
    method: 'POST',
    headers: { ...authed(), 'content-type': 'application/json' },
    body: JSON.stringify({ path: root }),
  });
  const { files } = (await scan.json()) as {
    files: Array<{ path: string; fileIndex: number; locale: string | null }>;
  };
  const res = await fetch(`${base}/api/projects/open`, {
    method: 'POST',
    headers: { ...authed(), 'content-type': 'application/json' },
    body: JSON.stringify({
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
    }),
  });
  expect(res.status).toBe(200);
}

const configure = async (origin: string): Promise<void> => {
  const res = await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { ...authed(), 'content-type': 'application/json' },
    // concurrency: 1 so the three units complete strictly one after another —
    // the point of this test is the GAP between arrivals, which concurrency
    // above 1 would blur (two units dispatched together finish together).
    body: JSON.stringify({
      baseUrl: `${origin}/v1`,
      model: 'qwen2.5:14b',
      params: { concurrency: 1 },
    }),
  });
  expect(res.status).toBe(200);
};

interface FakeModel {
  readonly origin: string;
  close(): Promise<void>;
}

/** Answers after `delayMs`, long enough that a real-time observer could tell units apart. */
function fakeModel(delayMs: number): Promise<FakeModel> {
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const userMsg = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const sourceLine = /Source \(en-GB\):\n(.+)/.exec(userMsg)?.[1]?.trim() ?? 'x';
      const answer = JSON.stringify({
        translation: `${sourceLine} (de)`,
        confidence: 'high',
        notes_for_reviewer: null,
      });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => resolve(raw));
  });

let model: FakeModel | null = null;
afterEach(async () => {
  await model?.close();
  model = null;
});

describe("a job's progress over the real SSE stream", () => {
  it('publishes job-progress incrementally, spread out over the run — not only at the end', async () => {
    const DELAY_MS = 200;
    model = await fakeModel(DELAY_MS);
    await configure(model.origin);

    const streamRes = await fetch(`${base}/api/events?token=${TEST_TOKEN}`);
    expect(streamRes.status).toBe(200);
    expect(streamRes.body).not.toBeNull();

    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ locales: [{ locale: 'de', ids: [A, B, C] }] }),
    });
    const job = (await created.json()) as Job;
    expect(job.locales[0]?.total).toBe(3);

    // hello + 3x(job-log, job-progress) + at least one job-state — 8 is a
    // safe floor; give it generous headroom over 3 x DELAY_MS.
    // hello, job-state(running), 3x(job-log + job-progress), job-state(done):
    // 9 frames minimum. Heartbeats are pushed out of the window (see `start`).
    const frames = await readFrames(streamRes.body!, 9, DELAY_MS * 3 + 3000);
    const progress = frames.filter((f) => f.event === 'job-progress');

    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(
      progress.map((f) => (JSON.parse(f.data) as { currentIndex: number }).currentIndex),
    ).toEqual([1, 2, 3]);

    // The actual regression check: three real-time-spaced arrivals, not three
    // events that all landed within a few ms of each other at the very end.
    // Every consecutive pair is roughly one unit's delay apart — proof this is
    // three real arrivals, not three events that landed together at the end.
    for (let i = 1; i < progress.length; i++) {
      const gap = (progress[i]?.at ?? 0) - (progress[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThan(DELAY_MS * 0.5);
    }

    // A job-state frame carries the timestamps the
    // transition just set. Without them a client that WATCHES a job finish
    // never learns when it finished — the only path where the card's timing is
    // wrong is the one nobody reloads for.
    const states = frames
      .filter((f) => f.event === 'job-state')
      .map(
        (f) =>
          JSON.parse(f.data) as {
            status: string;
            startedAt: string | null;
            finishedAt: string | null;
          },
      );

    const running = states.find((f) => f.status === 'running');
    expect(running?.startedAt).toEqual(expect.any(String));
    expect(running?.finishedAt).toBeNull();

    const finished = states.find((f) => f.status === 'done');
    expect(finished?.startedAt).toEqual(expect.any(String));
    expect(finished?.finishedAt).toEqual(expect.any(String));
  });
});
