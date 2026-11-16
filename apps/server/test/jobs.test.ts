// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RunLogEntrySchema,
  rowIdOf,
  type Job,
  type JobLocale,
  type JobLogResponse,
  type JobRecord,
  type Project,
  type RunLogEntry,
  type UnitDetail,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M11: "translate this unit" made into "draft N units" (FR-6.7).
 *
 * Runs against a REAL HTTP server standing in for the local model, same as
 * `prompt.test.ts` — a stub would skip exactly the layers worth testing here:
 * that a batch actually reaches the endpoint per unit, and that the existing
 * single-unit gates (FR-6.10's overwrite guard, FR-6.11's restore gate) still
 * run inside a loop instead of being bypassed by it.
 */

const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}
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
  [unit('a', 'Alpha'), unit('b', 'Bravo'), unit('c', 'Charlie'), unit('pay', 'Pay now')].join('\n'),
);

/** `pay` already carries a human translation — the job's FR-6.10 case. */
const deXlf = xlf(
  'de',
  [unit('a', 'Alpha'), unit('b', 'Bravo'), unit('pay', 'Pay now', 'Jetzt bezahlen')].join('\n'),
);

/** A second target locale, so one job can hold two. Nothing translated yet. */
const frXlf = xlf('fr', [unit('a', 'Alpha'), unit('b', 'Bravo'), unit('c', 'Charlie')].join('\n'));

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

const A = rowIdOf('messages', 'a');
const B = rowIdOf('messages', 'b');
const C = rowIdOf('messages', 'c');
const PAY = rowIdOf('messages', 'pay');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-jobs-')));
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
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), deXlf, 'utf8');
  await writeFile(join(root, 'messages.fr.xlf'), frXlf, 'utf8');

  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
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
  expect(res.statusCode).toBe(200);
  return res.json<Project>();
}

const configure = async (origin: string): Promise<void> => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: goodHeaders(),
    payload: { baseUrl: `${origin}/v1`, model: 'qwen2.5:14b' },
  });
  expect(res.statusCode).toBe(200);
};

/* -- a stand-in for the local model ---------------------------------------- */

interface FakeModel {
  readonly origin: string;
  readonly requests: number;
  close(): Promise<void>;
}

/**
 * Answers every request with `translation: "<source> (de)"`, after `delayMs` —
 * long enough for a test to observe `running` and call pause/cancel before the
 * job finishes on its own.
 */
function fakeModel(delayMs = 0): Promise<FakeModel> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      requests += 1;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const userMsg = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const sourceLine = /Source \(en-GB\):\n(.+)/.exec(userMsg)?.[1]?.trim() ?? 'x';
      const answer = JSON.stringify({
        translation: `${sourceLine} (de)`,
        confidence: 'high',
        notes_for_reviewer: null,
      });
      const respond = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        get requests() {
          return requests;
        },
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

/* -- helpers ----------------------------------------------------------------- */

const getUnit = async (rowId: string): Promise<UnitDetail> =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    })
  ).json<UnitDetail>();

const createJob = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/jobs', headers: goodHeaders(), payload });

/** A job request over the given locales, in the order written. */
const draft = (locales: Record<string, string[]>, extra: Record<string, unknown> = {}) => ({
  locales: Object.entries(locales).map(([locale, ids]) => ({ locale, ids })),
  ...extra,
});

/** One locale of a job, by code. */
const loc = (job: Job, locale = 'de'): JobLocale => {
  const found = job.locales.find((l) => l.locale === locale);
  expect(found).toBeDefined();
  return found!;
};

const post = (url: string) => app.inject({ method: 'POST', url, headers: goodHeaders() });

const getJob = async (id: string): Promise<Job> => {
  const res = await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: goodHeaders() });
  expect(res.statusCode).toBe(200);
  return res.json<Job>();
};

const jobLog = async (id: string, after?: number): Promise<JobLogResponse> => {
  const qs = after !== undefined ? `?after=${after}` : '';
  const res = await app.inject({
    method: 'GET',
    url: `/api/jobs/${id}/log${qs}`,
    headers: goodHeaders(),
  });
  expect(res.statusCode).toBe(200);
  return res.json<JobLogResponse>();
};

/** Polls `GET /api/jobs/:id` until `status` matches, returning the last read either way. */
async function waitForJobStatus(id: string, status: Job['status'], timeoutMs = 5000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  let job = await getJob(id);
  while (job.status !== status && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    job = await getJob(id);
  }
  return job;
}

/* -- tests --------------------------------------------------------------- */

describe('POST /api/jobs', () => {
  it('drafts every unit, one run-log line each, and lands them as machine drafts', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const created = await createJob(draft({ de: [A, B] }));
    expect(created.statusCode).toBe(200);
    const job = created.json<Job>();
    expect(loc(job).total).toBe(2);

    const final = await waitForJobStatus(job.id, 'done');
    expect(final.status).toBe('done');
    expect(loc(final).accepted).toBe(2);
    expect(loc(final).currentIndex).toBe(2);

    const log = await jobLog(job.id);
    expect(log.entries).toHaveLength(2);
    expect(log.entries.every((e) => e.outcome === 'accepted')).toBe(true);
    expect(new Set(log.entries.map((e) => e.rowId))).toEqual(new Set([A, B]));

    // Every accepted entry carries the target and the unsaved count at that
    // moment — what `DraftStore.adopt` needs client-side to mirror the draft
    // into its own dirty buffer, the same way a single-unit run already does.
    // Without this the Save button never learns a job wrote
    // anything, even though the grid (server-rendered) shows it.
    for (const entry of log.entries) {
      expect(entry.target?.state).toBe('draftMachine');
      expect(entry.unsavedCount).toBeGreaterThan(0);
    }
    expect(log.entries.map((e) => e.unsavedCount).sort()).toEqual([1, 2]);

    // Landed in the overlay as a draftMachine cell, visible before any save —
    // the same guarantee M9 already gives a single unit.
    const project = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: goodHeaders(),
    });
    expect(project.statusCode).toBe(200);
  });

  it('skips a unit whose target is a human translation, without asking the model for it', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const created = await createJob(draft({ de: [A, PAY] }));
    const job = created.json<Job>();

    const final = await waitForJobStatus(job.id, 'done');
    expect(loc(final).accepted).toBe(1);
    expect(loc(final).skipped).toBe(1);
    // The model was never asked about `pay` — only `a` produced a request.
    expect(model.requests).toBe(1);

    const log = await jobLog(job.id);
    const skip = log.entries.find((e) => e.rowId === PAY);
    expect(skip?.outcome).toBe('skipped');
    expect(skip?.run).toBeNull();
    expect(skip?.message).toContain('written by a person');
  });

  it('overwrite: true on the job actually reaches every unit, not just the request that carried it', async () => {
    // Found from use: `JobCreateRequestSchema` accepts `overwrite`, but
    // `#runOne` never threaded it through to `translateUnit` — every unit
    // silently fell back to FR-6.10's default (protect a human translation),
    // so `overwrite: true` at job creation was a no-op.
    model = await fakeModel();
    await configure(model.origin);

    const created = await createJob(draft({ de: [A, PAY] }, { overwrite: true }));
    const job = created.json<Job>();

    const final = await waitForJobStatus(job.id, 'done');
    expect(loc(final).accepted).toBe(2);
    expect(loc(final).skipped).toBe(0);
    expect(model.requests).toBe(2);

    const log = await jobLog(job.id);
    expect(log.entries.find((e) => e.rowId === PAY)?.outcome).toBe('accepted');
  });

  it('pauses, holds the next unit, and resumes from where it left off', async () => {
    model = await fakeModel(150);
    await configure(model.origin);

    const created = await createJob(draft({ de: [A, B, C] }));
    const job = created.json<Job>();

    await waitForJobStatus(job.id, 'running', 2000);
    const pauseRes = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/pause`,
      headers: goodHeaders(),
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json<Job>().status).toBe('paused');

    // Give any in-flight request time to land, then confirm nothing NEW starts.
    await new Promise((r) => setTimeout(r, 400));
    const requestsAtPause = model.requests;
    await new Promise((r) => setTimeout(r, 300));
    expect(model.requests).toBe(requestsAtPause);

    const resumeRes = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/resume`,
      headers: goodHeaders(),
    });
    expect(resumeRes.statusCode).toBe(200);

    const final = await waitForJobStatus(job.id, 'done');
    expect(loc(final).currentIndex).toBe(3);
    expect(loc(final).accepted).toBe(3);
  });

  it('cancel stops after the in-flight unit and leaves the rest untouched', async () => {
    model = await fakeModel(150);
    await configure(model.origin);

    const created = await createJob(draft({ de: [A, B, C] }));
    const job = created.json<Job>();

    await waitForJobStatus(job.id, 'running', 2000);
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/cancel`,
      headers: goodHeaders(),
    });
    expect(cancelRes.statusCode).toBe(200);

    const final = await waitForJobStatus(job.id, 'cancelled');
    expect(final.status).toBe('cancelled');
    expect(loc(final).currentIndex).toBeLessThan(3);
    const requestsAtCancel = model.requests;
    await new Promise((r) => setTimeout(r, 400));
    expect(model.requests).toBe(requestsAtCancel);
  });

  it('closing the project cancels the job running against it', async () => {
    // The ids a running job holds point into a row index that close() is about
    // to drop. Left alone the job would fail unit by unit against a project
    // that no longer exists.
    model = await fakeModel(150);
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B, C] }))).json<Job>();
    await waitForJobStatus(job.id, 'running', 2000);

    const closed = await app.inject({
      method: 'POST',
      url: '/api/project/close',
      headers: goodHeaders(),
    });
    expect(closed.statusCode).toBe(204);

    const final = await waitForJobStatus(job.id, 'cancelled');
    expect(final.status).toBe('cancelled');
  });

  it('a second job queues behind the first and starts once it finishes', async () => {
    model = await fakeModel(80);
    await configure(model.origin);

    const first = (await createJob(draft({ de: [A, B] }))).json<Job>();
    // Another locale: the same one would be refused while the first job holds it.
    const second = (await createJob(draft({ fr: [C] }))).json<Job>();
    expect((await getJob(second.id)).status).toBe('queued');

    await waitForJobStatus(first.id, 'done');
    const finalSecond = await waitForJobStatus(second.id, 'done');
    expect(loc(finalSecond, 'fr').accepted).toBe(1);
  });

  it('GET .../log?after= returns only the tail', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const all = await jobLog(job.id);
    expect(all.entries).toHaveLength(2);
    const tail = await jobLog(job.id, all.entries[0]?.seq ?? 0);
    expect(tail.entries).toHaveLength(1);
  });

  it('stores the name a job was given, trimmed, and null without one', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const named = (await createJob(draft({ de: [A] }, { name: '  Release 4.2  ' }))).json<Job>();
    expect(named.name).toBe('Release 4.2');
    expect((await getJob(named.id)).name).toBe('Release 4.2');
    await waitForJobStatus(named.id, 'done');

    const unnamed = (await createJob(draft({ fr: [A] }))).json<Job>();
    expect(unnamed.name).toBeNull();
    await waitForJobStatus(unnamed.id, 'done');

    // Only spaces is the same as no name.
    const blank = (await createJob(draft({ pl: [A] }, { name: '   ' }))).json<Job>();
    expect(blank.name).toBeNull();
    await waitForJobStatus(blank.id, 'done');
  });

  it('refuses a name longer than 120 characters', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const res = await createJob(draft({ de: [A] }, { name: 'x'.repeat(121) }));
    expect(res.statusCode).toBe(400);
  });

  it('refuses to create a job with no project open', async () => {
    await app.close();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false });
    const res = await createJob(draft({ de: [A] }));
    expect(res.statusCode).toBe(400);
  });
});

describe('a job over several locales', () => {
  it('runs the locales strictly in the order given, each to the end', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const job = (await createJob(draft({ fr: [A, C], de: [A, B] }))).json<Job>();
    // The first locale may already have started by the time the answer is written.
    expect(job.locales.map((l) => [l.locale, l.total])).toEqual([
      ['fr', 2],
      ['de', 2],
    ]);
    expect(loc(job, 'de').status).toBe('queued');
    expect(job.number).toBeGreaterThan(0);
    expect(job.task).toBe('draft');

    const final = await waitForJobStatus(job.id, 'done');
    expect(final.locales.map((l) => [l.locale, l.status, l.accepted])).toEqual([
      ['fr', 'done', 2],
      ['de', 'done', 2],
    ]);
    expect(final.currentLocale).toBeNull();
    expect(final.avgMsPerUnit).not.toBeNull();

    const { entries } = await jobLog(job.id);
    expect(entries.map((e) => e.locale)).toEqual(['fr', 'fr', 'de', 'de']);
  });

  it('a locale whose every unit fails still lets the next locale run', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const gone = rowIdOf('messages', 'no-such-unit');
    const job = (await createJob(draft({ de: [gone], fr: [A] }))).json<Job>();
    const final = await waitForJobStatus(job.id, 'done');
    expect(loc(final, 'de')).toMatchObject({ status: 'done', failed: 1, accepted: 0 });
    expect(loc(final, 'fr')).toMatchObject({ status: 'done', accepted: 1 });
  });

  it('skips a queued locale while an earlier one runs, and leaves its units alone', async () => {
    model = await fakeModel(120);
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B], fr: [A, B] }))).json<Job>();
    await waitForJobStatus(job.id, 'running', 2000);

    // The running locale cannot be skipped — only one that has not started.
    expect((await post(`/api/jobs/${job.id}/locales/de/skip`)).statusCode).toBe(400);
    const skipped = await post(`/api/jobs/${job.id}/locales/fr/skip`);
    expect(skipped.statusCode).toBe(200);
    expect(loc(skipped.json<Job>(), 'fr').status).toBe('skipped');

    const final = await waitForJobStatus(job.id, 'done');
    expect(loc(final, 'de').status).toBe('done');
    expect(loc(final, 'fr')).toMatchObject({ status: 'skipped', accepted: 0, currentIndex: 0 });
    expect((await jobLog(job.id)).entries.every((e) => e.locale === 'de')).toBe(true);

    // Finished: there is no turn left to skip or put back.
    expect((await post(`/api/jobs/${job.id}/locales/fr/unskip`)).statusCode).toBe(400);
  });

  it('puts a skipped locale back in line with Undo', async () => {
    model = await fakeModel(120);
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B], fr: [A] }))).json<Job>();
    expect((await post(`/api/jobs/${job.id}/locales/fr/skip`)).statusCode).toBe(200);
    expect((await post(`/api/jobs/${job.id}/locales/fr/unskip`)).statusCode).toBe(200);
    // Undo only means something for a skipped locale.
    expect((await post(`/api/jobs/${job.id}/locales/fr/unskip`)).statusCode).toBe(400);

    const final = await waitForJobStatus(job.id, 'done');
    expect(loc(final, 'fr')).toMatchObject({ status: 'done', accepted: 1 });
  });

  it('refuses a locale that is already in an active job, but not once it was skipped there', async () => {
    model = await fakeModel(120);
    await configure(model.origin);

    const first = (await createJob(draft({ de: [A, B], fr: [A] }))).json<Job>();
    const clash = await createJob(draft({ fr: [C] }));
    expect(clash.statusCode).toBe(409);
    expect(clash.body).toContain(`#${first.number}`);

    await post(`/api/jobs/${first.id}/locales/fr/skip`);
    const second = await createJob(draft({ fr: [C] }));
    expect(second.statusCode).toBe(200);
    await waitForJobStatus(second.json<Job>().id, 'done');
  });

  it('refuses the same locale twice in one request', async () => {
    const res = await createJob({
      locales: [
        { locale: 'de', ids: [A] },
        { locale: 'de', ids: [B] },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('pausing pauses the running locale with the job', async () => {
    model = await fakeModel(150);
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B, C], fr: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'running', 2000);
    const paused = (await post(`/api/jobs/${job.id}/pause`)).json<Job>();
    expect(loc(paused, 'de').status).toBe('paused');
    expect(loc(paused, 'fr').status).toBe('queued');

    const resumed = (await post(`/api/jobs/${job.id}/resume`)).json<Job>();
    expect(loc(resumed, 'de').status).toBe('running');
    await waitForJobStatus(job.id, 'done');
  });

  it('cancel stops every locale that has not finished, and keeps what was written', async () => {
    model = await fakeModel(150);
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B, C], fr: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'running', 2000);
    await post(`/api/jobs/${job.id}/cancel`);

    const final = await waitForJobStatus(job.id, 'cancelled');
    expect(loc(final, 'de').status).toBe('cancelled');
    expect(loc(final, 'fr').status).toBe('cancelled');
    expect(final.currentLocale).toBeNull();
  });

  it('removes a queued job from the queue, but not one that runs', async () => {
    model = await fakeModel(120);
    await configure(model.origin);

    const first = (await createJob(draft({ de: [A, B] }))).json<Job>();
    const second = (await createJob(draft({ fr: [A] }))).json<Job>();

    const del = (id: string) =>
      app.inject({ method: 'DELETE', url: `/api/jobs/${id}`, headers: goodHeaders() });
    expect((await del(second.id)).statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/jobs/${second.id}`, headers: goodHeaders() }))
        .statusCode,
    ).toBe(404);
    await waitForJobStatus(first.id, 'running', 2000);
    expect((await del(first.id)).statusCode).toBe(400);

    await waitForJobStatus(first.id, 'done');
    // It never ran: nothing was asked of the model for fr.
    expect(model.requests).toBe(2);
  });

  it('removes a finished job from the list, and its report still opens', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${job.id}`,
      headers: goodHeaders(),
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/jobs', headers: goodHeaders() })).json<Job[]>(),
    ).toEqual([]);
    const report = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report`,
      headers: goodHeaders(),
    });
    expect(report.statusCode).toBe(200);
  });

  it('clears every finished job and leaves the running and queued ones', async () => {
    model = await fakeModel(120);
    await configure(model.origin);

    const done = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(done.id, 'done');
    const cancelled = (await createJob(draft({ de: [B] }))).json<Job>();
    await waitForJobStatus(cancelled.id, 'running', 2000);
    await post(`/api/jobs/${cancelled.id}/cancel`);
    await waitForJobStatus(cancelled.id, 'cancelled');
    const running = (await createJob(draft({ de: [A, B, C] }))).json<Job>();
    const queued = (await createJob(draft({ fr: [A] }))).json<Job>();
    await waitForJobStatus(running.id, 'running', 2000);

    const res = await post('/api/jobs/clear-finished');
    expect(res.statusCode).toBe(200);
    expect(new Set(res.json<{ removed: string[] }>().removed)).toEqual(
      new Set([done.id, cancelled.id]),
    );
    const left = (
      await app.inject({ method: 'GET', url: '/api/jobs', headers: goodHeaders() })
    ).json<Job[]>();
    expect(left.map((j) => j.id).sort()).toEqual([running.id, queued.id].sort());

    await waitForJobStatus(queued.id, 'done');
  });

  it('counts what is waiting for review per locale', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, PAY], fr: [A, B] }))).json<Job>();
    const done = await waitForJobStatus(job.id, 'done');
    expect(loc(done, 'de').pendingReview).toBe(1);
    expect(loc(done, 'fr').pendingReview).toBe(2);
    expect(done.pendingReview).toBe(3);
  });
});

/**
 * `pendingReview` (M15) — what S8's completed card counts down, and why it
 * stops offering a review that is finished.
 *
 * Computed on read from the unit index, because nothing tells `JobQueue` that a
 * review happened: reviewing is an ordinary target PATCH and emits no job
 * event. These tests therefore review through the real PATCH route rather than
 * poking the queue.
 */
describe('how much of a job is still waiting for a reviewer', () => {
  const review = (rowId: string, segments: Array<{ k: 't'; v: string }>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(rowId)}/targets/de`,
      headers: goodHeaders(),
      payload: { segments, state: 'reviewed', review: { decision: 'approve', reasons: [] } },
    });

  it('starts equal to what the job wrote, and falls as each draft is decided', async () => {
    model = await fakeModel();
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A, B] }))).json<Job>();
    const done = await waitForJobStatus(job.id, 'done');
    expect(loc(done).accepted).toBe(2);
    expect(done.pendingReview).toBe(2);

    const target = (await getUnit(A)).targets.find((t) => t.locale === 'de');
    expect((await review(A, target?.segments as Array<{ k: 't'; v: string }>)).statusCode).toBe(
      200,
    );
    expect((await getJob(job.id)).pendingReview).toBe(1);
  });

  it("reaches zero once the last one is decided — the card's whole condition", async () => {
    model = await fakeModel();
    await configure(model.origin);

    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const target = (await getUnit(A)).targets.find((t) => t.locale === 'de');
    await review(A, target?.segments as Array<{ k: 't'; v: string }>);
    expect((await getJob(job.id)).pendingReview).toBe(0);
  });

  it('never counts a unit the job skipped, however that unit reads now', async () => {
    model = await fakeModel();
    await configure(model.origin);

    // `pay` already has a human translation, so FR-6.10's guard skips it and
    // the job writes nothing for it. There is nothing of the JOB'S doing to
    // review, whatever state the cell happens to be in.
    const job = (await createJob(draft({ de: [A, PAY] }))).json<Job>();
    const done = await waitForJobStatus(job.id, 'done');
    expect(loc(done).skipped).toBe(1);
    expect(loc(done).accepted).toBe(1);
    expect(done.pendingReview).toBe(1);
  });

  it('is zero for a job that has not written anything yet', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const created = (await createJob(draft({ de: [A, B] }))).json<Job>();
    // The POST answer is the job at creation; whatever it says about review, it
    // must not be a number somebody could act on.
    expect(created.pendingReview).toBe(0);
    await waitForJobStatus(created.id, 'done');
  });
});

describe('the review report', () => {
  /** The record's finishing write lands in the background, just after the status flips. */
  async function finishedRecord(id: string): Promise<JobRecord> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const raw = await readFile(join(root, '.lexi', 'logs', `${id}.json`), 'utf8').catch(
        () => null,
      );
      const record = raw === null ? null : (JSON.parse(raw) as JobRecord);
      if (record?.job.status === 'done' || Date.now() > deadline) return record as JobRecord;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const report = (id: string) =>
    app.inject({ method: 'GET', url: `/api/jobs/${id}/report`, headers: goodHeaders() });

  it('keeps the prompt that was sent in the log file, but not on the wire', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const onDisk = (await readFile(join(root, '.lexi', 'logs', `${job.id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as RunLogEntry);
    expect(onDisk[0]?.run?.prompt?.user).toContain('Alpha');
    expect(onDisk[0]?.run?.prompt?.system.length).toBeGreaterThan(0);

    const wire = await jobLog(job.id);
    expect(wire.entries[0]?.run).not.toBeNull();
    expect(wire.entries[0]?.run?.prompt).toBeUndefined();
  });

  it('writes a record of what the job was told, and updates it when the job finishes', async () => {
    model = await fakeModel();
    await configure(model.origin);
    await mkdir(join(root, '.lexi', 'styleguides'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'styleguides', 'de.md'),
      '# Deutsch\n\nAlways use "Sie".\n',
      'utf8',
    );

    const job = (
      await createJob(draft({ de: [A, B] }, { instruction: 'Keep it short.' }))
    ).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const record = await finishedRecord(job.id);
    expect(record.instruction).toBe('Keep it short.');
    expect(record.model).toBe('qwen2.5:14b');
    expect(record.sourceLocale).toBe('en-GB');
    expect(record.job.status).toBe('done');
    expect(loc(record.job).accepted).toBe(2);
    expect(record.styleguides.locales['de']?.text).toContain('Always use "Sie".');
  });

  it('is one HTML file with the source, the translation, the instruction and the prompt', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A, PAY] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const res = await report(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lexi-review-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.html"$/,
    );

    const html = res.body;
    expect(html).toContain('<code class="key">a</code>');
    expect(html).toContain('Alpha (de)');
    expect(html).toContain('Instructions sent to the model');
    // The skipped human translation is reported in its own section, with why.
    expect(html).toContain('Skipped');
    expect(html).toContain('id="u2"');
  });

  it('is a CSV of id, description, source and translation when asked, in the delimiter asked for', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A, PAY] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report?format=csv`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lexi-review-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv"$/,
    );
    // Semicolon by default, and the skipped unit shows the human translation it kept.
    const exportId = res.body.split('\r\n')[1]?.split(';')[2] ?? '';
    expect(exportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toBe(
      `\uFEFFUnit ID;Description;Export;Source;de\r\na;;${exportId};Alpha;Alpha (de)\r\npay;;${exportId};Pay now;Jetzt bezahlen\r\n`,
    );

    const comma = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report?format=csv&delimiter=,`,
      headers: goodHeaders(),
    });
    expect(comma.body.split('\r\n')[0]).toBe('﻿Unit ID,Description,Export,Source,de');
  });

  describe('CSV export snapshot and split', () => {
    const csvOf = (id: string, query: string) =>
      app.inject({
        method: 'GET',
        url: `/api/jobs/${id}/report?format=csv${query}`,
        headers: goodHeaders(),
      });
    const snapshotFiles = () =>
      readdir(join(root, '.lexi', 'exports')).catch(() => [] as string[]);

    it('snapshots what the single CSV says, under the id in its Export column', async () => {
      model = await fakeModel();
      await configure(model.origin);
      const job = (await createJob(draft({ de: [A, PAY] }))).json<Job>();
      await waitForJobStatus(job.id, 'done');

      const res = await csvOf(job.id, '&split=single');
      const dataRows = res.body.split('\r\n').slice(1).filter((l) => l !== '');
      const id = dataRows[0]?.split(';')[2] ?? '';

      const files = await snapshotFiles();
      expect(files).toEqual([`${id}.json`]);
      const raw = await readFile(join(root, '.lexi', 'exports', `${id}.json`), 'utf8');
      // One line: a snapshot holds every exported cell, and it is committed.
      expect(raw).toBe(`${JSON.stringify(JSON.parse(raw))}\n`);
      const snap = JSON.parse(raw) as { id: string; jobId: string; rows: unknown[] };
      expect(snap.id).toBe(id);
      expect(snap.jobId).toBe(job.id);
      expect(snap.rows.length).toBe(dataRows.length);
    });

    it('does not snapshot an HTML report', async () => {
      model = await fakeModel();
      await configure(model.origin);
      const job = (await createJob(draft({ de: [A] }))).json<Job>();
      await waitForJobStatus(job.id, 'done');
      await report(job.id);
      expect(await snapshotFiles()).toEqual([]);
    });

    it('zips one CSV per locale under one export id and one snapshot', async () => {
      model = await fakeModel();
      await configure(model.origin);
      const job = (await createJob(draft({ de: [A], fr: [A, B] }))).json<Job>();
      await waitForJobStatus(job.id, 'done');

      const res = await app.inject({
        method: 'GET',
        url: `/api/jobs/${job.id}/report?format=csv&split=perLocale`,
        headers: goodHeaders(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
      const disposition = String(res.headers['content-disposition']);
      const match = /filename="(lexi-review-\d{4}-\d{2}-\d{2}-[0-9a-f]{8})\.zip"/.exec(disposition);
      expect(match).not.toBeNull();
      const base = match?.[1] ?? '';

      const dir = await mkdtemp(join(tmpdir(), 'lexi-zip-'));
      try {
        const file = join(dir, 'out.zip');
        await writeFile(file, res.rawPayload);
        const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
        const ids = new Set<string>();
        for (const locale of ['de', 'fr']) {
          expect(listing).toContain(`${base}-${locale}.csv`);
          const csv = execFileSync('unzip', ['-p', file, `${base}-${locale}.csv`], {
            encoding: 'utf8',
          });
          const rows = csv.split('\r\n').slice(1).filter((l) => l !== '');
          expect(rows.length).toBeGreaterThan(0);
          expect(csv.split('\r\n')[0]?.split(';').slice(4)).toEqual([locale]);
          for (const r of rows) ids.add(r.split(';')[2] ?? '');
        }
        expect(ids.size).toBe(1);
        expect(await snapshotFiles()).toEqual([`${[...ids][0]}.json`]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('answers perLocale on a one-locale job with a plain CSV', async () => {
      model = await fakeModel();
      await configure(model.origin);
      const job = (await createJob(draft({ de: [A] }))).json<Job>();
      await waitForJobStatus(job.id, 'done');
      const res = await csvOf(job.id, '&split=perLocale');
      expect(res.headers['content-type']).toContain('text/csv');
      expect(String(res.headers['content-disposition'])).toMatch(/\.csv"$/);
    });

    it('commits the exports: .lexi/.gitignore does not list them', async () => {
      model = await fakeModel();
      await configure(model.origin);
      const job = (await createJob(draft({ de: [A] }))).json<Job>();
      await waitForJobStatus(job.id, 'done');
      await csvOf(job.id, '');
      const ignore = await readFile(join(root, '.lexi', '.gitignore'), 'utf8');
      expect(ignore).not.toContain('exports');
    });
  });

  it('refuses a format it does not know', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report?format=xlsx`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('escapes everything that came from the project', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (
      await createJob(draft({ de: [A] }, { instruction: '<script>alert(1)</script>' }))
    ).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const html = (await report(job.id)).body;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('marks a translation somebody changed after the job', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(A)}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Alpha, korrigiert' }] },
    });
    expect(edit.statusCode).toBe(200);

    const html = (await report(job.id)).body;
    expect(html).toContain('Changed since the job');
    expect(html).toContain('Alpha, korrigiert');
  });

  // A restart no longer makes the queue forget a finished job (it is restored),
  // so the queue only lacks one the person dismissed.
  it('still works after the server restarts and the queue has forgotten the job', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');
    await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: goodHeaders() });

    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
    await open();

    expect(
      (await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: goodHeaders() }))
        .statusCode,
    ).toBe(404);
    const res = await report(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Alpha (de)');
  });

  it('still parses a log line written before prompts were kept', () => {
    const old = {
      seq: 0,
      at: '2026-01-01T00:00:00.000Z',
      rowId: A,
      locale: 'de',
      outcome: 'rejected',
      run: {
        at: '2026-01-01T00:00:00.000Z',
        model: 'm',
        placeholderStyle: 'masked',
        latencyMs: 1,
        promptTokens: null,
        completionTokens: null,
        parse: 'json',
        confidence: null,
        notesForReviewer: null,
        raw: '{}',
      },
      rejection: { reason: 'r', detail: 'd', missing: [], extra: [] },
      message: null,
      findings: [],
      target: null,
      unsavedCount: 0,
    };
    expect(RunLogEntrySchema.parse(old).run?.prompt).toBeUndefined();
  });

  it('covers every locale of the job: a section each in HTML, a locale column in CSV', async () => {
    model = await fakeModel();
    await configure(model.origin);
    await mkdir(join(root, '.lexi', 'styleguides'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'styleguides', 'fr.md'),
      '# Français\n\nVouvoyez.\n',
      'utf8',
    );

    const job = (await createJob(draft({ de: [A], fr: [A, B] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const record = await finishedRecord(job.id);
    expect(record.styleguides.locales['fr']?.text).toContain('Vouvoyez.');
    expect(record.styleguides.locales['de']).toBeNull();

    const html = (await report(job.id)).body;
    expect(html).toContain('id="locale-de"');
    expect(html).toContain('id="locale-fr"');
    expect(html).toContain('Vouvoyez.');

    const csv = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report?format=csv`,
      headers: goodHeaders(),
    });
    const id = csv.body.split('\r\n')[1]?.split(';')[2] ?? '';
    expect(csv.body.split('\r\n').slice(0, 3)).toEqual([
      '\uFEFFUnit ID;Description;Export;Source;de;fr',
      `a;;${id};Alpha;Alpha (de);Alpha (de)`,
      `b;;${id};Bravo;;Bravo (de)`,
    ]);
  });

  it('still opens a record written when a job held one locale', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    // Rewrite the record into the shape it had before jobs held several locales.
    const record = await finishedRecord(job.id);
    const de = loc(record.job);
    const rest: Partial<Job> = { ...record.job };
    delete rest.locales;
    delete rest.number;
    delete rest.task;
    delete rest.currentLocale;
    delete rest.name;
    const legacy = {
      ...record,
      job: {
        ...rest,
        locale: 'de',
        ids: de.ids,
        total: de.total,
        currentIndex: de.currentIndex,
        currentRowId: null,
        accepted: de.accepted,
        rejected: 0,
        skipped: 0,
        failed: 0,
      },
      styleguides: { global: null, locale: null },
    };
    await writeFile(join(root, '.lexi', 'logs', `${job.id}.json`), JSON.stringify(legacy), 'utf8');

    const res = await report(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Alpha (de)');
  });

  it("leads a named job's HTML report with its name, and puts it in the file name", async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }, { name: 'Release <4.2>' }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const res = await report(job.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Release &lt;4.2&gt; · Translation review');
    expect(res.body).toContain('<h1>Release &lt;4.2&gt; · Translation review');
    expect(res.body).toContain('<dt>Name</dt><dd>Release &lt;4.2&gt;</dd>');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lexi-review-\d{4}-\d{2}-\d{2}-Release__4\.2_-[0-9a-f]{8}\.html"$/,
    );

    const csv = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report?format=csv`,
      headers: goodHeaders(),
    });
    // The first line stays the column header the import reads back.
    expect(csv.body.split('\n')[0]).toMatch(/^\uFEFFUnit ID;/);
    expect(csv.headers['content-disposition']).toContain('-Release__4.2_-');
  });

  it('404s for an unknown id, and for one that is not a job id at all', async () => {
    expect((await report('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await report('..%2F..%2Fsettings')).statusCode).toBe(404);
  });
});

/**
 * Finished jobs survive a restart: a fresh server (new `ProjectService`, new
 * `JobQueue`) opening the same folder brings their cards back from
 * `.lexi/logs/<id>.json`.
 */
describe('restoring finished jobs when a project opens', () => {
  const restart = async (): Promise<void> => {
    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
    await open();
  };
  const listJobs = async (): Promise<Job[]> =>
    (await app.inject({ method: 'GET', url: '/api/jobs', headers: goodHeaders() })).json<Job[]>();

  it('lists a finished job again with the same id, number and status', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    await restart();
    const jobs = await listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: job.id, number: job.number, status: 'done' });
    // Its log and report still resolve through the restored project path.
    expect((await jobLog(job.id)).entries).toHaveLength(1);

    // The counter carries on from the restored number.
    const next = (await createJob(draft({ fr: [A] }))).json<Job>();
    expect(next.number).toBe(job.number + 1);
    await waitForJobStatus(next.id, 'done');
  });

  it("keeps a job's name across a restart, and reads a record from before names as unnamed", async () => {
    model = await fakeModel();
    await configure(model.origin);
    const named = (await createJob(draft({ de: [A] }, { name: 'Release 4.2' }))).json<Job>();
    await waitForJobStatus(named.id, 'done');
    const old = (await createJob(draft({ fr: [A] }))).json<Job>();
    await waitForJobStatus(old.id, 'done');

    // Rewrite the second record into the shape it had before jobs had names.
    const path = join(root, '.lexi', 'logs', `${old.id}.json`);
    const deadline = Date.now() + 5000;
    let record = JSON.parse(await readFile(path, 'utf8')) as JobRecord;
    while (record.job.status !== 'done' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      record = JSON.parse(await readFile(path, 'utf8')) as JobRecord;
    }
    const job: Partial<Job> = { ...record.job };
    delete job.name;
    await writeFile(path, JSON.stringify({ ...record, job }), 'utf8');

    await restart();
    const jobs = await listJobs();
    expect(jobs.find((j) => j.id === named.id)?.name).toBe('Release 4.2');
    const restored = jobs.find((j) => j.id === old.id);
    expect(restored).toBeDefined();
    expect(restored?.name).toBeNull();
  });

  it('does not bring back a job that was removed', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${job.id}`,
      headers: goodHeaders(),
    });
    expect(del.statusCode).toBe(204);

    await restart();
    expect(await listJobs()).toEqual([]);
  });

  it('a shutdown right after remove still keeps the job dismissed on disk', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');
    await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers: goodHeaders() });
    // `close` awaits `JobQueue.settled()` through the onClose hook.
    await app.close();
    const record = JSON.parse(
      await readFile(join(root, '.lexi', 'logs', `${job.id}.json`), 'utf8'),
    ) as JobRecord;
    expect(record.dismissed).toBe(true);
  });

  it('removes a restored job for good, and clear-finished dismisses it too', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const a = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(a.id, 'done');
    const b = (await createJob(draft({ fr: [A] }))).json<Job>();
    await waitForJobStatus(b.id, 'done');

    await restart();
    expect(await listJobs()).toHaveLength(2);
    const del = await app.inject({ method: 'DELETE', url: `/api/jobs/${a.id}`, headers: goodHeaders() });
    expect(del.statusCode).toBe(204);
    await post('/api/jobs/clear-finished');
    expect(await listJobs()).toEqual([]);

    await restart();
    expect(await listJobs()).toEqual([]);
  });

  it('does not restore a job whose record says it was still running', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');
    const file = join(root, '.lexi', 'logs', `${job.id}.json`);
    const record = JSON.parse(await readFile(file, 'utf8')) as JobRecord;
    record.job.status = 'running';
    await writeFile(file, JSON.stringify(record), 'utf8');

    await restart();
    expect(await listJobs()).toEqual([]);
  });

  it('drops the finished jobs of the previous project when another one opens', async () => {
    model = await fakeModel();
    await configure(model.origin);
    const job = (await createJob(draft({ de: [A] }))).json<Job>();
    await waitForJobStatus(job.id, 'done');

    const other = join(root, '..', 'other');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'messages.xlf'), sourceXlf, 'utf8');
    await writeFile(join(other, 'messages.de.xlf'), deXlf, 'utf8');
    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root, other], stateDir }), {
      logger: false,
      projects,
    });
    await open();
    expect(await listJobs()).toHaveLength(1);

    const scan = await app.inject({
      method: 'POST',
      url: '/api/projects/scan',
      headers: goodHeaders(),
      payload: { path: other },
    });
    const files = scan.json<{ files: Array<{ path: string; fileIndex: number; locale: string | null }> }>().files;
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/open',
      headers: goodHeaders(),
      payload: {
        path: other,
        sourceLocale: 'en-GB',
        mapping: files
          .filter((f) => f.locale !== null)
          .map((f) => ({ ...f, fixTargetLanguage: false })),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await listJobs()).toEqual([]);
  });
});
