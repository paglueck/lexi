// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rowIdOf, type Job, type JobLogResponse, type ProjectScanResponse } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { parseBatchAnswer } from '../src/services/translate.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * FR-6.8 — "Units per request". Several units, one request, and the one
 * property that makes it safe: an answer that does not line up with the keys
 * it was given can reject units, or fall back to one request per unit, but it
 * can never write one string's translation into another.
 */

const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}
      </trans-unit>`;

const xlf = (lang: string, units: string): string => `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="${lang}">
    <body>
${units}
    </body>
  </file>
</xliff>
`;

const WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
const IDS = WORDS.map((w) => w.toLowerCase());
const ROWS = IDS.map((id) => rowIdOf('messages', id));
const PAY = rowIdOf('messages', 'pay');

let root: string;
let stateDir: string;
let app: FastifyInstance;

type Mode = 'ok' | 'swap' | 'missing' | 'prose' | 'length';

interface FakeModel {
  readonly origin: string;
  /** Every user message received, in order. */
  readonly users: string[];
  close(): Promise<void>;
}

/**
 * Answers a batch (a user message with `### Item uN` sections) as `items`,
 * bent according to `mode`, and a single-unit request the ordinary way — which
 * is what the fallback path sends.
 */
function fakeModel(mode: Mode): Promise<FakeModel> {
  const users: string[] = [];
  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const user = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      users.push(parsed.messages.find((m) => m.role === 'user')?.content ?? '');
      const sections = [...user.matchAll(/### Item (u\d+)\n[\s\S]*?Source \(en-GB\):\n(.+)/g)];
      let content: string;
      let finish = 'stop';
      if (sections.length === 0) {
        const source =
          /Source \(en-GB\):\n(.+)/.exec(parsed.messages[1]?.content ?? '')?.[1]?.trim() ?? 'x';
        content = JSON.stringify({
          translation: `${source} (de)`,
          confidence: 'high',
          notes_for_reviewer: null,
        });
      } else if (mode === 'prose' || /not valid JSON/.test(user)) {
        content = 'Here are your translations, one per line.';
      } else {
        let items = sections.map(([, key, source]) => ({
          key,
          source: source!.trim(),
          translation: `${source!.trim()} (de)`,
          confidence: 'high',
          notes_for_reviewer: null,
        }));
        if (mode === 'swap') {
          // The two first items trade keys: exactly the silent damage FR-6.8 fears.
          items = [
            { ...items[0]!, key: items[1]!.key },
            { ...items[1]!, key: items[0]!.key },
            ...items.slice(2),
          ];
        }
        if (mode === 'missing') items = items.slice(0, -1);
        content = JSON.stringify({ items });
        if (mode === 'length') {
          content = content.slice(0, 40);
          finish = 'length';
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        users,
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

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-batch-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

afterEach(async () => {
  await model?.close();
  model = null;
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  const units = [...WORDS.map((w) => unit(w.toLowerCase(), w)), unit('pay', 'Pay now')].join('\n');
  await writeFile(join(root, 'messages.xlf'), xlf('en-GB', units), 'utf8');
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf(
      'de',
      [
        ...WORDS.map((w) => unit(w.toLowerCase(), w)),
        unit('pay', 'Pay now', 'Jetzt bezahlen'),
      ].join('\n'),
    ),
    'utf8',
  );
  app = await buildApp(testConfig({ roots: [root], stateDir }), {
    logger: false,
    projects: new ProjectService(),
  });
  const scan = (
    await app.inject({
      method: 'POST',
      url: '/api/projects/scan',
      headers: goodHeaders(),
      payload: { path: root },
    })
  ).json<ProjectScanResponse>();
  await app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: 'en-GB',
      mapping: scan.files.map((f) => ({
        path: f.path,
        fileIndex: f.fileIndex,
        locale: f.locale,
        fixTargetLanguage: false,
      })),
    },
  });
});

async function runJob(
  mode: Mode,
  ids: readonly string[],
  unitsPerRequest = 3,
): Promise<{ job: Job; log: JobLogResponse }> {
  model = await fakeModel(mode);
  const configured = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: goodHeaders(),
    payload: {
      baseUrl: `${model.origin}/v1`,
      model: 'qwen',
      params: { unitsPerRequest, concurrency: 1 },
    },
  });
  expect(configured.statusCode, configured.payload).toBe(200);
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: goodHeaders(),
      payload: { locales: [{ locale: 'de', ids }] },
    })
  ).json<Job>();
  const deadline = Date.now() + 5000;
  let job = created;
  while (job.status !== 'done' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    job = (
      await app.inject({ method: 'GET', url: `/api/jobs/${created.id}`, headers: goodHeaders() })
    ).json<Job>();
  }
  const log = (
    await app.inject({ method: 'GET', url: `/api/jobs/${created.id}/log`, headers: goodHeaders() })
  ).json<JobLogResponse>();
  return { job, log };
}

const translationOf = (log: JobLogResponse, rowId: string): string | undefined => {
  const entry = log.entries.find((e) => e.rowId === rowId);
  const segs = entry?.target?.segments ?? [];
  return segs.map((s) => (s.k === 't' ? s.v : '')).join('');
};

describe('units per request (FR-6.8)', () => {
  it('drafts seven units in three requests, with one log entry per unit in job order', async () => {
    const { job, log } = await runJob('ok', ROWS);
    expect(job.status).toBe('done');
    expect(job.locales[0]?.accepted).toBe(7);
    expect(model!.users).toHaveLength(3); // ceil(7 / 3)
    expect(log.entries.map((e) => e.rowId)).toEqual(ROWS);
    expect(log.entries.map((e) => e.unsavedCount)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const [i, word] of WORDS.entries()) {
      expect(translationOf(log, ROWS[i]!)).toBe(`${word} (de)`);
    }
    expect(log.entries[0]?.run?.batch).toEqual({ size: 3, key: 'u1' });
  });

  it('never asks the model about a unit the overwrite guard skips', async () => {
    const { job, log } = await runJob('ok', [ROWS[0]!, PAY, ROWS[1]!]);
    expect(job.locales[0]?.skipped).toBe(1);
    expect(log.entries.find((e) => e.rowId === PAY)?.outcome).toBe('skipped');
    expect(model!.users.join('\n')).not.toContain('Pay now');
  });

  it('rejects exactly the units whose keys came back swapped — and writes nothing for them', async () => {
    // A swap parses as a perfect answer: every key is present exactly once.
    // Only the echoed source gives it away — "Bravo" under Alpha's key.
    const { log } = await runJob('swap', ROWS.slice(0, 3));
    expect(log.entries.map((e) => e.outcome)).toEqual(['rejected', 'rejected', 'accepted']);
    expect(log.entries[0]?.rejection?.reason).toBe('batch-misaligned');
    expect(log.entries[0]?.target).toBeNull();
    expect(translationOf(log, ROWS[2]!)).toBe('Charlie (de)');
    // Nothing Bravo-shaped reached Alpha's cell.
    const alpha = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(ROWS[0]!)}`,
      headers: goodHeaders(),
    });
    expect(alpha.body).not.toContain('Bravo (de)');
  });

  it('rejects a unit whose key is missing, and only that one', async () => {
    const { log } = await runJob('missing', ROWS.slice(0, 3));
    expect(log.entries.map((e) => e.outcome)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(log.entries[2]?.rejection?.reason).toBe('batch-misaligned');
    expect(log.entries[2]?.target).toBeNull();
  });

  it('falls back to one request per unit when the answer is not items at all', async () => {
    const { job, log } = await runJob('prose', ROWS.slice(0, 3));
    expect(job.locales[0]?.accepted).toBe(3);
    // One batch, its stricter retry, then three single-unit requests.
    expect(model!.users).toHaveLength(5);
    expect(log.entries.every((e) => e.run?.batch === undefined)).toBe(true);
  });

  it('falls back when the batch hit the token ceiling', async () => {
    const { job } = await runJob('length', ROWS.slice(0, 3));
    expect(job.locales[0]?.accepted).toBe(3);
    expect(model!.users).toHaveLength(4);
  });

  it('behaves exactly as before with one unit per request', async () => {
    const { job, log } = await runJob('ok', ROWS.slice(0, 3), 1);
    expect(job.locales[0]?.accepted).toBe(3);
    expect(model!.users).toHaveLength(3);
    expect(log.entries.every((e) => e.run?.batch === undefined)).toBe(true);
  });
});

describe('a string that IS a Term Base term never reaches the model', () => {
  // Alpha has a German entry, Bravo is DNT, Charlie is translated for French
  // only — so German keeps it as written (the fallback rule). None of the three
  // is asked about; Delta, not a term, is.
  const termBase = (): Promise<void> =>
    mkdir(join(root, '.lexi'), { recursive: true }).then(() =>
      writeFile(
        join(root, '.lexi', 'termbase.csv'),
        'id,term,note,dnt,de,fr\nt1,Alpha,,no,Alfa,\nt2,Bravo,,yes,,\nt3,Charlie,,no,,Charles\n',
        'utf8',
      ),
    );

  it('writes the entry as the target, final, and batches only the rest', async () => {
    await termBase();
    const { job, log } = await runJob('ok', ROWS.slice(0, 4));
    expect(job.locales[0]?.accepted).toBe(4);
    expect(translationOf(log, ROWS[0]!)).toBe('Alfa');
    expect(translationOf(log, ROWS[1]!)).toBe('Bravo');
    expect(translationOf(log, ROWS[2]!)).toBe('Charlie');
    expect(translationOf(log, ROWS[3]!)).toBe('Delta (de)');
    for (const row of ROWS.slice(0, 3)) {
      const entry = log.entries.find((e) => e.rowId === row);
      expect(entry?.run?.parse).toBe('termbase');
      expect(entry?.run?.model).toBe('Term Base');
      expect(entry?.target?.state).toBe('final');
    }
    expect(log.entries.find((e) => e.rowId === ROWS[3])?.target?.state).toBe('draftMachine');
    // The queue chunks [Alpha, Bravo, Charlie] [Delta]: the first chunk is all
    // terms and sends nothing; Delta goes alone.
    expect(model!.users).toHaveLength(1);
    expect(model!.users[0]).not.toMatch(/Source \(en-GB\):\n(Alpha|Bravo|Charlie)/);
  });

  it('asks the model nothing when every string is a term, one unit per request too', async () => {
    await termBase();
    const { job, log } = await runJob('ok', ROWS.slice(0, 2), 1);
    expect(job.locales[0]?.accepted).toBe(2);
    expect(model!.users).toHaveLength(0);
    expect(log.entries.map((e) => e.run?.parse)).toEqual(['termbase', 'termbase']);
  });

  it('still leaves a human translation alone', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'termbase.csv'),
      'id,term,note,dnt,de\nt1,Pay now,,no,Bezahlen\n',
      'utf8',
    );
    const { job, log } = await runJob('ok', [PAY]);
    expect(job.locales[0]?.skipped).toBe(1);
    expect(log.entries[0]?.target).toBeNull();
  });
});

describe('the review report for a batched job', () => {
  it('shows the shared request once and points the other units of it there', async () => {
    const { job } = await runJob('ok', ROWS.slice(0, 3));
    expect(job.locales[0]?.accepted).toBe(3);

    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/report`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('one request for 3 texts, this one is <code>u1</code>');
    expect(html).toContain('Sent in the same request as <a href="#u1">#1</a> (as <code>u2</code>)');
    expect(html).toContain('Sent in the same request as <a href="#u1">#1</a> (as <code>u3</code>)');
    for (const word of ['Alpha', 'Bravo', 'Charlie']) expect(html).toContain(`${word} (de)`);
  });
});

describe('parseBatchAnswer', () => {
  it('keeps the echoed source, so a swap can be detected', () => {
    const items = parseBatchAnswer('{"items":[{"key":"u1","source":"Alpha","translation":"A"}]}');
    expect(items?.get('u1')).toMatchObject({ source: 'Alpha', translation: 'A' });
  });

  it('reads items from a fenced answer, and marks a repeated key', () => {
    const items = parseBatchAnswer(
      '```json\n{"items":[{"key":"u1","translation":"A"},{"key":"u2","translation":"B"},{"key":"u2","translation":"C"}]}\n```',
    );
    expect(items?.get('u1')).toMatchObject({ translation: 'A' });
    expect(items?.get('u2')).toBe('duplicate');
  });

  it('accepts a bare array and a key-to-item object, and returns null for prose', () => {
    expect(parseBatchAnswer('[{"key":"u1","translation":"A"}]')?.size).toBe(1);
    expect(parseBatchAnswer('{"u1":{"translation":"A"},"u2":{"translation":"B"}}')?.size).toBe(2);
    expect(parseBatchAnswer('Sure! Here you go.')).toBeNull();
  });
});
