// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rowIdOf, type LexiEvent, type Project, type ProjectScanResponse } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import type { EventBus } from '../src/lib/event-bus.js';
import { FileWatcher } from '../src/services/file-watcher.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * The file watcher (FR-1.5).
 *
 * The test that matters is the third one. A watcher that announces `git pull`
 * is easy; one that stays silent when WE write the file is the whole design
 * problem, because both arrive as the same filesystem notification. If that
 * test ever goes red, every save will raise a "3 files changed on disk" banner
 * and users will learn to dismiss the banner without reading it — at which
 * point the feature is worse than not having it.
 *
 * Driven against a stub bus rather than a live SSE socket: the transport is
 * already covered by events.test.ts, and what is under test here is which
 * writes reach it.
 */

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

const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${
          target === undefined ? '' : `\n        <target state="translated">${target}</target>`
        }
      </trans-unit>`;

/** Just enough of the bus to record what would have gone down the wire. */
class RecordingBus {
  readonly events: LexiEvent[] = [];
  publish(event: LexiEvent): void {
    this.events.push(event);
  }
  changed(): string[] {
    return this.events.flatMap((e) => (e.type === 'file-changed' ? e.paths : []));
  }
}

const DEBOUNCE_MS = 20;

/**
 * Wait for the bus to say something, rather than for a fixed time.
 *
 * A fixed sleep was the first version and it was flaky under the full suite —
 * not in isolation. `fs.watch` delivery is at the mercy of whatever else the
 * machine is doing, and `units-perf.test.ts` builds a 20,000 x 10 corpus in a
 * neighbouring worker, so a window that is generous on an idle laptop is not.
 * Polling for the condition removes the race instead of widening it.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The other direction, which no amount of polling can shorten: proving that
 * NOTHING arrives means waiting out the window in which it could have. Long
 * enough to survive a loaded machine, because a false green here is the
 * expensive kind — it would mean every save raises a reload banner in
 * production and nobody notices until a user does.
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 1200));

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;
let bus: RecordingBus;
let watcher: FileWatcher | undefined;

const dePath = (): string => join(root, 'messages.de.xlf');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-watch-')));
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

  await writeFile(
    join(root, 'messages.xlf'),
    xlf('en-GB', [unit('pay', 'Pay now'), unit('billing', 'Billing')].join('\n')),
    'utf8',
  );
  await writeFile(
    join(root, 'messages.de.xlf'),
    xlf('de', [unit('pay', 'Pay now', 'Jetzt bezahlen'), unit('billing', 'Billing')].join('\n')),
    'utf8',
  );

  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });

  const scan = (
    await app.inject({
      method: 'POST',
      url: '/api/projects/scan',
      headers: goodHeaders(),
      payload: { path: root },
    })
  ).json<ProjectScanResponse>();

  const opened = await app.inject({
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
  expect(opened.json<Project>().locales.map((l) => l.locale)).toEqual(['de']);

  bus = new RecordingBus();
  watcher = new FileWatcher({
    projects,
    bus: bus as unknown as EventBus,
    debounceMs: DEBOUNCE_MS,
  });
  watcher.watchProject(root);
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
});

describe('FileWatcher', () => {
  it('announces a file that changed underneath us', async () => {
    const before = await readFile(dePath(), 'utf8');
    await writeFile(dePath(), before.replace('Jetzt bezahlen', 'Jetzt zahlen'), 'utf8');
    await waitFor(() => bus.events.length > 0);

    expect(bus.changed()).toEqual([dePath()]);
  });

  it('stays silent when the bytes are the same, however many events arrive', async () => {
    const before = await readFile(dePath(), 'utf8');
    // The shape of an editor that saves without changing anything, and of the
    // duplicate notifications every platform emits for one write.
    await writeFile(dePath(), before, 'utf8');
    await writeFile(dePath(), before, 'utf8');
    await settle();

    expect(bus.events).toEqual([]);
  });

  it('stays silent for OUR OWN save, which is the whole point', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'billing'))}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Abrechnung' }] },
    });
    const saved = await app.inject({
      method: 'POST',
      url: '/api/save',
      headers: goodHeaders(),
      payload: {},
    });
    expect(saved.json<{ written: string[] }>().written).toEqual([dePath()]);
    expect(await readFile(dePath(), 'utf8')).toContain('Abrechnung');
    await settle();

    expect(bus.changed()).toEqual([]);
  });

  it('ignores files the project never opened', async () => {
    await writeFile(join(root, 'README.md'), '# not xliff\n', 'utf8');
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'messages.es.xlf'),
      xlf('es', unit('z', 'x')),
      'utf8',
    );
    await settle();

    expect(bus.events).toEqual([]);
  });

  it('coalesces a burst into one event, the way a git pull arrives', async () => {
    const de = await readFile(dePath(), 'utf8');
    const src = await readFile(join(root, 'messages.xlf'), 'utf8');
    await writeFile(dePath(), de.replace('Jetzt bezahlen', 'Jetzt zahlen'), 'utf8');
    await writeFile(join(root, 'messages.xlf'), src.replace('Billing', 'Invoicing'), 'utf8');
    await waitFor(() => bus.changed().length === 2);

    expect(bus.events).toHaveLength(1);
    expect(bus.changed().sort()).toEqual([dePath(), join(root, 'messages.xlf')].sort());
  });

  it('stops cleanly, and a stopped watcher says nothing', async () => {
    watcher?.stop();
    const before = await readFile(dePath(), 'utf8');
    await writeFile(dePath(), before.replace('Jetzt bezahlen', 'Jetzt zahlen'), 'utf8');
    await settle();

    expect(bus.events).toEqual([]);
  });
});
