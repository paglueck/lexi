// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { RunLogEntry, UnitTarget } from '@lexi/shared';

import {
  JobsStore,
  applyJobFrame,
  applyJobFrames,
  appendLogEntry,
  draftsToAdopt,
  pickInitialSelection,
  queueOrder,
  waitsFor,
} from './jobs-store.js';
import type { JobFrame } from './events-store.js';
import { jobFixture, jobLocale } from '../testing/job-fixture.js';

/**
 * The three pieces of M11's client-side bookkeeping that are easy to get
 * subtly wrong and invisible in a screenshot: which job an SSE frame patches,
 * whether a run-log entry can land twice, and which job a reviewer opening
 * the screen cold lands on. Tested as pure functions, same as
 * `nextSelectedIndex` in `units-store.spec.ts`. `JobsStore` itself goes
 * through `TestBed` only for M13's failed-list case at the bottom, which is
 * about what the store claims rather than how it folds frames.
 */

const job = jobFixture;

const target = (over: Partial<UnitTarget> = {}): UnitTarget => ({
  locale: 'de',
  isRtl: false,
  state: 'draftMachine',
  missing: false,
  noFile: false,
  newFile: null,
  segments: [{ k: 't', v: 'Alpha (de)' }],
  findings: [],
  missingPlaceholders: [],
  charCount: 10,
  previous: null,
  origin: null,
  reviewReasons: [],
  ...over,
});

const entry = (over: Partial<RunLogEntry> = {}): RunLogEntry => ({
  seq: 0,
  at: '2026-09-17T10:00:01Z',
  rowId: 'a',
  locale: 'de',
  outcome: 'accepted',
  run: null,
  rejection: null,
  message: null,
  findings: [],
  target: null,
  unsavedCount: 0,
  ...over,
});

describe('applyJobFrame', () => {
  it('updates a job-progress frame onto the job it names', () => {
    const jobs = [job({ id: 'j1' }), job({ id: 'j2', currentIndex: 5 })];
    const frame: JobFrame = {
      type: 'job-progress',
      jobId: 'j1',
      locale: 'de',
      jobAvgMsPerUnit: null,
      currentIndex: 2,
      currentRowId: 'b',
      accepted: 1,
      rejected: 0,
      skipped: 1,
      failed: 0,
      avgMsPerUnit: 12.5,
    };
    const next = applyJobFrame(jobs, frame);
    expect(next[0]?.locales[0]).toMatchObject({
      currentIndex: 2,
      currentRowId: 'b',
      accepted: 1,
      skipped: 1,
    });
    // The OTHER job is untouched — a frame for j1 must not bleed into j2.
    expect(next[1]?.locales[0]).toMatchObject({ currentIndex: 5 });
  });

  it('updates the status AND the timestamps a job-state frame carries', () => {
    const jobs = [job({ status: 'running', finishedAt: null })];
    const frame: JobFrame = {
      type: 'job-state',
      jobId: 'j1',
      status: 'done',
      startedAt: '2026-09-21T11:34:00Z',
      finishedAt: '2026-09-21T11:36:14Z',
    };
    // Until M15 this folded `status` alone, so a job the user WATCHED finish
    // ended with `finishedAt: null` and its card showed no time at all until a
    // reload.
    expect(applyJobFrame(jobs, frame)[0]).toMatchObject({
      status: 'done',
      startedAt: '2026-09-21T11:34:00Z',
      finishedAt: '2026-09-21T11:36:14Z',
    });
  });

  it('carries a null start through for a job cancelled before it ever ran', () => {
    const jobs = [job({ status: 'queued', startedAt: '2026-09-21T11:34:00Z' })];
    const frame: JobFrame = {
      type: 'job-state',
      jobId: 'j1',
      status: 'cancelled',
      startedAt: null,
      finishedAt: '2026-09-21T11:35:00Z',
    };
    expect(applyJobFrame(jobs, frame)[0]?.startedAt).toBeNull();
  });

  it('patches only the locale a job-progress frame names, and the job-wide mean', () => {
    const jobs = [
      job({
        locales: [
          jobLocale({ locale: 'fr', status: 'done', currentIndex: 3 }),
          jobLocale({ locale: 'de' }),
        ],
      }),
    ];
    const frame: JobFrame = {
      type: 'job-progress',
      jobId: 'j1',
      locale: 'de',
      jobAvgMsPerUnit: 2000,
      currentIndex: 1,
      currentRowId: 'a',
      accepted: 1,
      rejected: 0,
      skipped: 0,
      failed: 0,
      avgMsPerUnit: 1900,
    };
    const next = applyJobFrame(jobs, frame)[0];
    expect(next?.locales.map((l) => [l.locale, l.currentIndex])).toEqual([
      ['fr', 3],
      ['de', 1],
    ]);
    expect(next?.avgMsPerUnit).toBe(2000);
    expect(next?.currentLocale).toBe('de');
  });

  it('moves a locale through its lifecycle with a job-locale-state frame', () => {
    const jobs = [
      job({
        locales: [
          jobLocale({ locale: 'de', status: 'done' }),
          jobLocale({ locale: 'fr', status: 'queued' }),
        ],
      }),
    ];
    const started: JobFrame = {
      type: 'job-locale-state',
      jobId: 'j1',
      locale: 'fr',
      status: 'running',
      startedAt: '2026-09-21T11:36:00Z',
      finishedAt: null,
    };
    const next = applyJobFrame(jobs, started)[0];
    expect(next?.locales[1]).toMatchObject({
      status: 'running',
      startedAt: '2026-09-21T11:36:00Z',
    });
    expect(next?.currentLocale).toBe('fr');

    const skipped = applyJobFrame(jobs, { ...started, status: 'skipped', startedAt: null })[0];
    expect(skipped?.locales[1]?.status).toBe('skipped');
  });

  it('drops a removed job from the list', () => {
    const jobs = [job({ id: 'j1' }), job({ id: 'j2', status: 'queued' })];
    expect(applyJobFrame(jobs, { type: 'job-removed', jobId: 'j2' }).map((j) => j.id)).toEqual([
      'j1',
    ]);
  });

  it('forgets the current locale once the job has finished', () => {
    const jobs = [job({ currentLocale: 'de' })];
    const frame: JobFrame = {
      type: 'job-state',
      jobId: 'j1',
      status: 'done',
      startedAt: null,
      finishedAt: null,
    };
    expect(applyJobFrame(jobs, frame)[0]?.currentLocale).toBeNull();
  });

  it('leaves the job list untouched on a job-log frame — the run log is a separate signal', () => {
    const jobs = [job()];
    const frame: JobFrame = { type: 'job-log', jobId: 'j1', entry: entry() };
    expect(applyJobFrame(jobs, frame)).toEqual(jobs);
  });

  it('is a no-op when the frame names a job that is not in the list', () => {
    const jobs = [job({ id: 'j1' })];
    const frame: JobFrame = {
      type: 'job-state',
      jobId: 'unknown',
      status: 'done',
      startedAt: null,
      finishedAt: null,
    };
    expect(applyJobFrame(jobs, frame)).toEqual(jobs);
  });
});

describe('appendLogEntry', () => {
  it('appends a new entry', () => {
    expect(appendLogEntry([entry({ seq: 0 })], entry({ seq: 1 }))).toEqual([
      entry({ seq: 0 }),
      entry({ seq: 1 }),
    ]);
  });

  it('drops a duplicate seq rather than double-count a re-delivered frame', () => {
    const entries = [entry({ seq: 0 }), entry({ seq: 1 })];
    expect(appendLogEntry(entries, entry({ seq: 1, message: 'a different message' }))).toEqual(
      entries,
    );
  });

  it('keeps entries in seq order even when they arrive out of order', () => {
    // Concurrency inside a job means unit 2 can finish before unit 1.
    const withSecond = appendLogEntry([], entry({ seq: 1 }));
    const withBoth = appendLogEntry(withSecond, entry({ seq: 0 }));
    expect(withBoth.map((e) => e.seq)).toEqual([0, 1]);
  });
});

describe('applyJobFrames', () => {
  it('applies every queued frame, not just the last one', () => {
    // The bug this regression test pins: EventsStore queues frames because
    // Angular coalesces multiple signal writes into one effect run. Folding
    // only the LAST frame of a batch would still pass every other test here
    // — this is the one that fails if `applyJobFrames` goes back to reading
    // a single slot instead of iterating the whole queue.
    const jobs = [job({ id: 'j1', accepted: 0, currentIndex: 0 })];
    const frames: JobFrame[] = [
      {
        type: 'job-progress',
        jobId: 'j1',
        locale: 'de',
        jobAvgMsPerUnit: null,
        currentIndex: 1,
        currentRowId: 'a',
        accepted: 1,
        rejected: 0,
        skipped: 0,
        failed: 0,
        avgMsPerUnit: 100,
      },
      {
        type: 'job-progress',
        jobId: 'j1',
        locale: 'de',
        jobAvgMsPerUnit: null,
        currentIndex: 2,
        currentRowId: 'b',
        accepted: 2,
        rejected: 0,
        skipped: 0,
        failed: 0,
        avgMsPerUnit: 110,
      },
    ];
    const result = applyJobFrames(jobs, [], null, frames);
    // Both frames landed — not just frame 2 overwriting frame 1's effect,
    // and not frame 1 lost to frame 2's coalesced write.
    expect(result.jobs[0]?.locales[0]).toMatchObject({ currentIndex: 2, accepted: 2 });
  });

  it("appends every job-log entry in a batch to the selected job's run log", () => {
    const frames: JobFrame[] = [
      { type: 'job-log', jobId: 'j1', entry: entry({ seq: 0 }) },
      {
        type: 'job-progress',
        jobId: 'j1',
        locale: 'de',
        jobAvgMsPerUnit: null,
        currentIndex: 1,
        currentRowId: 'b',
        accepted: 1,
        rejected: 0,
        skipped: 0,
        failed: 0,
        avgMsPerUnit: 90,
      },
      { type: 'job-log', jobId: 'j1', entry: entry({ seq: 1, rowId: 'b' }) },
    ];
    const result = applyJobFrames([job({ id: 'j1' })], [], 'j1', frames);
    // Neither log entry was dropped by the progress frame sitting between them.
    expect(result.log.map((e) => e.seq)).toEqual([0, 1]);
    expect(result.jobs[0]?.locales[0]).toMatchObject({ currentIndex: 1, accepted: 1 });
  });

  it('ignores job-log entries for a job that is not the one currently selected', () => {
    const frames: JobFrame[] = [{ type: 'job-log', jobId: 'j2', entry: entry() }];
    const result = applyJobFrames([job({ id: 'j1' }), job({ id: 'j2' })], [], 'j1', frames);
    expect(result.log).toEqual([]);
  });

  it('is a no-op over an empty batch', () => {
    const jobs = [job()];
    const log = [entry()];
    expect(applyJobFrames(jobs, log, 'j1', [])).toEqual({ jobs, log });
  });
});

describe('draftsToAdopt', () => {
  it('picks out an accepted entry with a target — what DraftStore.adopt needs', () => {
    const t = target();
    const frames: JobFrame[] = [
      {
        type: 'job-log',
        jobId: 'j1',
        entry: entry({ rowId: 'a', outcome: 'accepted', target: t, unsavedCount: 1 }),
      },
    ];
    expect(draftsToAdopt(frames)).toEqual([
      { rowId: 'a', locale: 'de', target: t, unsavedCount: 1 },
    ]);
  });

  it('ignores rejected, skipped and failed entries — none of them wrote a target', () => {
    // Reported from use: a job's drafts showed up correctly in
    // the grid — which reads server-rendered rows — but the Save button never
    // appeared, because nothing told the client's dirty-buffer mirror that a
    // background job had written anything at all.
    const frames: JobFrame[] = [
      { type: 'job-log', jobId: 'j1', entry: entry({ outcome: 'rejected', target: null }) },
      { type: 'job-log', jobId: 'j1', entry: entry({ outcome: 'skipped', target: null }) },
      { type: 'job-log', jobId: 'j1', entry: entry({ outcome: 'failed', target: null }) },
    ];
    expect(draftsToAdopt(frames)).toEqual([]);
  });

  it('ignores job-progress and job-state frames, and an accepted entry with no target', () => {
    const frames: JobFrame[] = [
      {
        type: 'job-progress',
        jobId: 'j1',
        locale: 'de',
        jobAvgMsPerUnit: null,
        currentIndex: 1,
        currentRowId: 'a',
        accepted: 1,
        rejected: 0,
        skipped: 0,
        failed: 0,
        avgMsPerUnit: 100,
      },
      { type: 'job-state', jobId: 'j1', status: 'done', startedAt: null, finishedAt: null },
      { type: 'job-log', jobId: 'j1', entry: entry({ outcome: 'accepted', target: null }) },
    ];
    expect(draftsToAdopt(frames)).toEqual([]);
  });

  it('adopts every accepted draft in a batch, not just one', () => {
    const frames: JobFrame[] = [
      {
        type: 'job-log',
        jobId: 'j1',
        entry: entry({ rowId: 'a', outcome: 'accepted', target: target(), unsavedCount: 1 }),
      },
      {
        type: 'job-log',
        jobId: 'j1',
        entry: entry({ rowId: 'b', outcome: 'accepted', target: target(), unsavedCount: 2 }),
      },
    ];
    expect(draftsToAdopt(frames).map((d) => d.rowId)).toEqual(['a', 'b']);
  });
});

describe('pickInitialSelection', () => {
  it('lands on the running job over a queued or finished one', () => {
    const jobs = [job({ id: 'j1', status: 'done' }), job({ id: 'j2', status: 'running' })];
    expect(pickInitialSelection(jobs)).toBe('j2');
  });

  it('falls back to the most recently created job when nothing is running', () => {
    const jobs = [job({ id: 'j1', status: 'done' }), job({ id: 'j2', status: 'queued' })];
    expect(pickInitialSelection(jobs)).toBe('j2');
  });

  it('reports no selection for an empty list', () => {
    expect(pickInitialSelection([])).toBeNull();
  });
});

describe('queueOrder', () => {
  it('puts the newest job at the top and the oldest at the bottom, whatever their status', () => {
    const at = (min: number) => `2026-10-16T10:${String(min).padStart(2, '0')}:00Z`;
    const jobs = [
      job({ id: 'oldest', number: 1, status: 'done', createdAt: at(1) }),
      job({ id: 'run', number: 2, status: 'running', createdAt: at(2) }),
      job({ id: 'q', number: 3, status: 'queued', createdAt: at(3) }),
      job({ id: 'newest', number: 4, status: 'cancelled', createdAt: at(4) }),
    ];
    expect(queueOrder(jobs).map((j) => j.id)).toEqual(['newest', 'q', 'run', 'oldest']);
  });
});

describe('waitsFor', () => {
  const at = (min: number) => `2026-10-16T10:${String(min).padStart(2, '0')}:00Z`;

  it('names the last unfinished job created before a queued one, in run order', () => {
    const jobs = [
      job({ id: 'q2', number: 3, status: 'queued', createdAt: at(3) }),
      job({ id: 'run', number: 1, status: 'running', createdAt: at(1) }),
      job({ id: 'q1', number: 2, status: 'queued', createdAt: at(2) }),
    ];
    expect(waitsFor(jobs, 'q2')?.number).toBe(2);
    expect(waitsFor(jobs, 'q1')?.number).toBe(1);
  });

  it('is null for a job with nothing unfinished ahead of it', () => {
    const jobs = [
      job({ id: 'done', status: 'done', createdAt: at(1) }),
      job({ id: 'q', status: 'queued', createdAt: at(2) }),
    ];
    expect(waitsFor(jobs, 'q')).toBeNull();
  });
});

describe('JobsStore.clearFinished', () => {
  it('drops exactly the jobs the server cleared, and moves the run log off a cleared one', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const store = TestBed.inject(JobsStore);
    const http = TestBed.inject(HttpTestingController);

    const loading = store.refresh();
    http
      .expectOne('/api/jobs')
      .flush([job({ id: 'done', status: 'done' }), job({ id: 'run', status: 'running' })]);
    await loading;
    // The refresh selected the running job; point the log at the finished one.
    void store.select('done');
    http.match((r) => r.url.endsWith('/log')).forEach((r) => r.flush({ entries: [] }));

    const clearing = store.clearFinished();
    http
      .expectOne({ method: 'POST', url: '/api/jobs/clear-finished' })
      .flush({ removed: ['done'] });
    await clearing;

    expect(store.jobs().map((j) => j.id)).toEqual(['run']);
    expect(store.selectedId()).toBe('run');
  });
});

describe('JobsStore.refresh (M13)', () => {
  it("reports a failed list in the server's words, and does not claim the queue is empty", async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const store = TestBed.inject(JobsStore);
    const http = TestBed.inject(HttpTestingController);

    const done = store.refresh();
    http
      .expectOne('/api/jobs')
      .flush(
        { error: { message: 'No project is open.' } },
        { status: 409, statusText: 'Conflict' },
      );
    await done;

    expect(store.error()).toBe('No project is open.');
    // `loaded` stays false: the page must not render "No jobs yet".
    expect(store.loaded()).toBe(false);
  });
});
