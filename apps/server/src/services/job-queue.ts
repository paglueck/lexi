// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';

import {
  withoutPrompt,
  type Job,
  type JobLocale,
  type JobLocaleStatus,
  type JobLogOutcome,
  type JobRecord,
  type LexiEvent,
  type ParsedJobCreateRequest,
  type RunLogEntry,
  type TranslateUnitResponse,
} from '@lexi/shared';

import {
  appendJobLogLine,
  listJobRecordIds,
  readJobLogLines,
  readJobRecord,
  writeJobRecord,
} from '../lib/lexi-dir.js';
import { readStyleGuides } from '../lib/styleguides.js';
import { HttpError, badRequest, conflict } from '../lib/http-error.js';
import { normalizeRecord, type StoredJobRecord } from './job-report.js';
import { translateBatch, translateUnit, type TranslateDeps } from './translate.js';
import type { EventBus } from '../lib/event-bus.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from './project-service.js';
import type { SettingsService } from './settings-service.js';
import type { LlmClient } from './llm-client.js';

/**
 * FR-6.7 — "translate this unit" made into "draft 140 units" (M11).
 *
 * A job is a loop over `translateUnit` (M9) — or, with "Units per request"
 * above one, over `translateBatch` (FR-6.8), which drafts several units with
 * one request through the same prepare/finalize halves — plus bookkeeping:
 * which unit is running, how many were accepted / rejected / skipped / failed,
 * and a `.jsonl` line per UNIT either way. Nothing here composes a prompt,
 * calls the model directly, or touches the restore gates — that would be a
 * second implementation of the thing M9 already tested.
 *
 * A job holds an ordered list of locales (S14) and runs them ONE AFTER
 * ANOTHER, each through the same worker pool a single-locale job used to be.
 * Every unit's outcome is contained by `#entryFor`, so a rejection or a failed
 * request in one locale never stops the next one. A locale the user skipped
 * before it started is passed over and left untouched.
 *
 * ONE job runs at a time; the rest wait in a FIFO. That matches S8's mock
 * (one running card, queued rows reading "starts after the current job") and
 * keeps `settings.params.concurrency` meaningful as "how many units of THIS
 * job overlap" rather than a second axis nothing asked for.
 *
 * Pause/cancel are checked BETWEEN requests (units, or batches), never mid-request (cancelling
 * stops after the in-flight request) — so there is no `cancelling` status and
 * no `AbortController` on the HTTP call itself.
 */
export interface JobQueueDeps {
  readonly cfg: ServerConfig;
  readonly projects: ProjectService;
  readonly settings: SettingsService;
  readonly bus: EventBus;
  /** Injected by tests; production lets `translateUnit` create its own per call. */
  readonly client?: LlmClient | undefined;
}

interface Control {
  cancelled: boolean;
  paused: boolean;
  resumeWaiters: (() => void)[];
  /**
   * Captured at `create()` time rather than read from `projects.current` while
   * the job runs, so a project close/reopen mid-run cannot redirect a job's log
   * to a path it was never told about.
   */
  readonly projectPath: string;
  /**
   * FR-6.10, applied once at job creation rather than asked per unit — a batch
   * cannot pause to ask permission for each one. Not part of the wire `Job`
   * shape: nobody outside this class needs to know the job was told to
   * overwrite, only that a unit landed as `skipped` when it was not told to.
   */
  readonly overwrite: boolean;
  readonly instruction: string | undefined;
  /**
   * Everything in the job's `JobRecord` but the job itself, resolved once at
   * creation (the style guides are read from disk, hence the promise).
   */
  readonly record: Promise<Omit<JobRecord, 'job'>>;
  /** The last record write, so a finish never lands before the create it follows. */
  recordWrite: Promise<void>;
}

/** The run-log entry as it leaves the server: the sent prompt stays on disk. */
const forWire = (entry: RunLogEntry): RunLogEntry =>
  entry.run === null ? entry : { ...entry, run: withoutPrompt(entry.run) };

const isActive = (job: Job): boolean =>
  job.status === 'queued' || job.status === 'running' || job.status === 'paused';
const isFinished = (job: Job): boolean => !isActive(job);

/** Running mean across a whole job, carried from one locale's worker pool to the next. */
interface JobTiming {
  completed: number;
  totalMs: number;
}

export class JobQueue {
  readonly #jobs = new Map<string, Job>();
  readonly #controls = new Map<string, Control>();
  /**
   * The rows each job actually WROTE per locale — its accepted outcomes, in order.
   *
   * `accepted` is a count and cannot answer "which ones", which is what
   * `pendingReview` needs. Kept beside the job rather than read back out of
   * `.lexi/logs/<id>.jsonl` because that file is append-only JSONL and this is
   * asked on every `GET /api/jobs`.
   */
  readonly #written = new Map<string, Map<string, string[]>>();
  /**
   * Project folder of each job brought back from disk by `restore`. Those jobs
   * have no worker, so a full `Control` (resume waiters, the record promise)
   * would be dead weight; this is all `projectPathOf` and `remove` need.
   */
  readonly #restoredPaths = new Map<string, string>();
  /** In-flight dismiss writes by job id, awaited by `settled()`. */
  readonly #dismissals = new Map<string, Promise<void>>();
  readonly #queue: string[] = [];
  #activeJobId: string | null = null;
  #seq = 0;
  #number = 0;

  constructor(private readonly deps: JobQueueDeps) {}

  list(): readonly Job[] {
    return [...this.#jobs.values()];
  }

  get(id: string): Job {
    const job = this.#jobs.get(id);
    if (!job) throw new HttpError(404, 'not_found', `no job ${id}`);
    return job;
  }

  /**
   * A job as the ROUTES hand it over: the live record plus how many of the
   * drafts each locale wrote are still waiting for a reviewer.
   *
   * Computed on read rather than tracked, because nothing tells this queue that
   * a review happened — reviewing is an ordinary `PATCH /api/units/...` and
   * emits no job event. The unit index already knows every cell's current
   * state, so the honest answer is to ask it at the moment somebody looks.
   *
   * The predicate is `toReview`'s — `draftMachine` OR `needsReview` — so the
   * count on a locale row and the length of S11's queue can never disagree
   * about what is left. Units the job skipped or rejected never enter it: it
   * wrote nothing for them, so there is nothing of ITS doing to review.
   */
  withReview(job: Job): Job {
    const index = this.deps.projects.index;
    const written = this.#written.get(job.id);
    let jobPending = 0;
    const locales = job.locales.map((loc) => {
      const rows = written?.get(loc.locale);
      if (index === null || rows === undefined)
        return { ...loc, ids: [...loc.ids], pendingReview: 0 };
      let pending = 0;
      for (const rowId of rows) {
        const state = index.byRowId.get(rowId)?.cells.get(loc.locale)?.state;
        if (state === 'draftMachine' || state === 'needsReview') pending += 1;
      }
      jobPending += pending;
      return { ...loc, ids: [...loc.ids], pendingReview: pending };
    });
    return { ...job, locales, pendingReview: jobPending };
  }

  create(request: ParsedJobCreateRequest): Job {
    const project = this.deps.projects.current;
    if (!project) throw badRequest('no project is open');

    // The S15 modal locks these rows; the server holds the same line so two
    // tabs (or a quick double click) cannot queue the same locale twice.
    for (const other of this.#jobs.values()) {
      if (!isActive(other) || other.task !== request.task) continue;
      for (const loc of other.locales) {
        if (loc.status === 'skipped') continue;
        if (request.locales.some((r) => r.locale === loc.locale)) {
          throw conflict(`${loc.locale} is already in active job #${other.number}`);
        }
      }
    }

    const job: Job = {
      id: randomUUID(),
      number: ++this.#number,
      task: request.task,
      // The schema trims it; an empty name is no name.
      name: request.name || null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      locales: request.locales.map((r): JobLocale => ({
        locale: r.locale,
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        total: r.ids.length,
        ids: [...r.ids],
        currentIndex: 0,
        currentRowId: null,
        accepted: 0,
        rejected: 0,
        skipped: 0,
        failed: 0,
        avgMsPerUnit: null,
        // Computed at the boundary by `withReview`, never read from the live
        // record — see the field's own comment in `packages/shared/src/jobs.ts`.
        pendingReview: 0,
      })),
      currentLocale: null,
      avgMsPerUnit: null,
      pendingReview: 0,
    };
    this.#jobs.set(job.id, job);
    const { settings } = this.deps;
    const record = Promise.all(
      request.locales.map(
        async (r) => [r.locale, await readStyleGuides(project.path, r.locale)] as const,
      ),
    ).then((guides) => ({
      projectName: project.name,
      sourceLocale: project.sourceLocale,
      instruction: request.instruction ?? null,
      overwrite: request.overwrite ?? false,
      model: settings.endpoint.model,
      params: { ...settings.params },
      styleguides: {
        // The global guide is the same file whichever locale read it.
        global: guides[0]?.[1].global ?? null,
        locales: Object.fromEntries(guides.map(([locale, g]) => [locale, g.locale])),
      },
    }));
    this.#controls.set(job.id, {
      cancelled: false,
      paused: false,
      resumeWaiters: [],
      projectPath: project.path,
      overwrite: request.overwrite ?? false,
      instruction: request.instruction,
      record,
      recordWrite: Promise.resolve(),
    });
    this.#saveRecord(job);
    this.#queue.push(job.id);

    void this.#runNext();
    return job;
  }

  pause(id: string): Job {
    const job = this.get(id);
    if (job.status !== 'running') throw badRequest(`job ${id} is not running`);
    this.#control(id).paused = true;
    this.#setStatus(job, 'paused');
    const current = this.#current(job);
    if (current?.status === 'running') this.#setLocaleStatus(job, current, 'paused');
    return job;
  }

  resume(id: string): Job {
    const job = this.get(id);
    if (job.status !== 'paused') throw badRequest(`job ${id} is not paused`);
    const control = this.#control(id);
    control.paused = false;
    this.#setStatus(job, 'running');
    const current = this.#current(job);
    if (current?.status === 'paused') this.#setLocaleStatus(job, current, 'running');
    const waiters = control.resumeWaiters.splice(0);
    for (const wake of waiters) wake();
    return job;
  }

  cancel(id: string): Job {
    const job = this.get(id);
    if (isFinished(job)) throw badRequest(`job ${id} has already finished`);

    if (job.status === 'queued') {
      const at = this.#queue.indexOf(id);
      if (at !== -1) this.#queue.splice(at, 1);
      job.finishedAt = new Date().toISOString();
      this.#closeLocales(job, 'cancelled');
      this.#setStatus(job, 'cancelled');
      return job;
    }

    // running or paused: flip the flag and wake a paused worker so it can see
    // it and stop, rather than waiting for a resume that may never come.
    const control = this.#control(id);
    control.cancelled = true;
    const waiters = control.resumeWaiters.splice(0);
    for (const wake of waiters) wake();
    return job;
  }

  /**
   * S14's "Remove": a queued job leaves the queue, a finished one leaves the
   * list. A running or paused job is refused — it has to be cancelled first,
   * or its worker would go on writing for a job nobody can see. The job's
   * files stay on disk, so its report still opens from the current project.
   */
  remove(id: string): void {
    const job = this.get(id);
    if (job.status === 'running' || job.status === 'paused') {
      throw badRequest(`job ${id} is still ${job.status}; cancel it first`);
    }
    const at = this.#queue.indexOf(id);
    if (at !== -1) this.#queue.splice(at, 1);
    // Written before the job is forgotten, or `restore` would bring it back.
    const path = this.projectPathOf(id);
    if (path !== null) void this.#dismiss(id, path);
    this.#forget(id);
    this.#publish({ type: 'job-removed', jobId: id });
  }

  #forget(id: string): void {
    this.#jobs.delete(id);
    this.#controls.delete(id);
    this.#restoredPaths.delete(id);
    this.#written.delete(id);
  }

  /**
   * Re-write the job's record from disk with `dismissed: true`, after its own
   * pending write (if any) so the finished copy cannot land on top of the flag.
   * Never throws: a record that cannot be updated only means the card returns
   * after the next restart.
   */
  async #dismiss(id: string, projectPath: string): Promise<void> {
    // Behind an earlier dismiss of the same job, or the job's own record write,
    // so two quick writes land in order. Tracked by id in `#dismissals` (not on
    // the control, which `#forget` deletes and restored jobs lack) so `settled()`
    // can still reach it.
    const before = this.#dismissals.get(id) ?? this.#controls.get(id)?.recordWrite ?? Promise.resolve();
    const done: Promise<void> = before
      .then(async () => {
        const stored = await readJobRecord<StoredJobRecord>(projectPath, id);
        if (stored === null) return;
        await writeJobRecord(this.deps.cfg, projectPath, id, { ...normalizeRecord(stored), dismissed: true });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.#dismissals.get(id) === done) this.#dismissals.delete(id);
      });
    this.#dismissals.set(id, done);
    await done;
  }

  /**
   * Bring the finished jobs of `projectPath` back from `.lexi/logs/*.json`, so a
   * job card (and what hangs off it) outlives a server restart.
   *
   * Finished jobs of any OTHER project are dropped first: `cancelAll` on open
   * stops the running ones but leaves finished ones listed, and their reports
   * would read the wrong project. Dropping does not dismiss their records.
   * Active records (the server died mid-run) and dismissed ones are skipped.
   * Restored jobs have no `#written` entry, so their `pendingReview` reads 0.
   * No event is published, matching `create`: the client lists jobs by GET.
   *
   * @returns how many jobs were added.
   */
  async restore(projectPath: string): Promise<number> {
    for (const job of [...this.#jobs.values()]) {
      if (isFinished(job) && this.projectPathOf(job.id) !== projectPath) this.#forget(job.id);
    }
    let restored = 0;
    for (const id of await listJobRecordIds(projectPath)) {
      if (this.#jobs.has(id)) continue;
      const stored = await readJobRecord<StoredJobRecord>(projectPath, id);
      if (stored === null) continue;
      let record;
      try {
        record = normalizeRecord(stored);
      } catch {
        continue;
      }
      if (record.dismissed === true || isActive(record.job)) continue;
      this.#jobs.set(id, record.job);
      this.#restoredPaths.set(id, projectPath);
      this.#number = Math.max(this.#number, record.job.number);
      restored += 1;
    }
    return restored;
  }

  /** S14's "Clear finished": every done, cancelled or failed job leaves the list. Returns their ids. */
  clearFinished(): string[] {
    const ids = [...this.#jobs.values()].filter(isFinished).map((j) => j.id);
    for (const id of ids) this.remove(id);
    return ids;
  }

  /**
   * S14's "Skip": a locale that has not started yet is passed over when its
   * turn comes, and its units are left untouched. Only while the job has not
   * finished — afterwards there is no turn left to skip.
   */
  skipLocale(id: string, locale: string): Job {
    const { job, loc } = this.#localeOf(id, locale);
    if (loc.status !== 'queued')
      throw badRequest(`${locale} is ${loc.status}, only a queued locale can be skipped`);
    this.#setLocaleStatus(job, loc, 'skipped');
    return job;
  }

  /** S14's "Undo": a skipped locale goes back in line, in its original place. */
  unskipLocale(id: string, locale: string): Job {
    const { job, loc } = this.#localeOf(id, locale);
    if (loc.status !== 'skipped') throw badRequest(`${locale} is not skipped`);
    this.#setLocaleStatus(job, loc, 'queued');
    return job;
  }

  /** Every project close cancels whatever this process still has in flight for it. */
  cancelAll(): void {
    for (const job of this.#jobs.values()) {
      if (isActive(job)) {
        try {
          this.cancel(job.id);
        } catch {
          // Already finishing on its own between the check and the call.
        }
      }
    }
  }

  async log(id: string, after: number): Promise<RunLogEntry[]> {
    this.get(id); // 404s on an unknown id before touching disk.
    const all = await readJobLogLines<RunLogEntry>(this.projectPathOf(id) as string, id);
    // `seq` is assigned at DISPATCH time, but with concurrency > 1 units can
    // finish — and therefore append — out of that order. The file is in
    // append order; the response is sorted back into seq order so `after`
    // means the same thing regardless of which unit happened to answer first.
    return all
      .filter((entry) => entry.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .map(forWire);
  }

  /** Resolves once every job record write in flight has landed (or failed). */
  async settled(): Promise<void> {
    await Promise.all([
      ...[...this.#controls.values()].map((c) => c.recordWrite),
      ...this.#dismissals.values(),
    ]);
  }

  /** The project folder a job writes to, for routes that read its files. Null for an unknown job. */
  projectPathOf(id: string): string | null {
    return this.#controls.get(id)?.projectPath ?? this.#restoredPaths.get(id) ?? null;
  }

  /**
   * Persist the job's `JobRecord` (at creation, and again once it finishes).
   *
   * Never throws and never fails the job: the record serves the review report,
   * and a report that cannot be written is no reason to stop translating. The
   * writes are chained so the finished copy cannot be overtaken by the first.
   */
  #saveRecord(job: Job): void {
    const control = this.#controls.get(job.id);
    if (!control) return;
    const snapshot: Job = { ...job, locales: job.locales.map((l) => ({ ...l, ids: [...l.ids] })) };
    control.recordWrite = control.recordWrite
      .then(async () => {
        const meta = await control.record;
        await writeJobRecord(this.deps.cfg, control.projectPath, job.id, {
          job: snapshot,
          ...meta,
        });
      })
      .catch(() => undefined);
  }

  #control(id: string): Control {
    const control = this.#controls.get(id);
    if (!control) throw new HttpError(404, 'not_found', `no job ${id}`);
    return control;
  }

  #current(job: Job): JobLocale | undefined {
    return job.locales.find((l) => l.locale === job.currentLocale);
  }

  #localeOf(id: string, locale: string): { job: Job; loc: JobLocale } {
    const job = this.get(id);
    if (isFinished(job)) throw badRequest(`job ${id} has already finished`);
    const loc = job.locales.find((l) => l.locale === locale);
    if (!loc) throw new HttpError(404, 'not_found', `job ${id} has no locale ${locale}`);
    return { job, loc };
  }

  /**
   * Every caller sets `finishedAt` (or `startedAt`) BEFORE calling this, so the
   * frame reports the job as it now is rather than as it was a line earlier.
   * That ordering is what lets the client fold the timestamps straight in
   * instead of re-fetching the job.
   */
  #setStatus(job: Job, status: Job['status']): void {
    job.status = status;
    if (status === 'done' || status === 'cancelled' || status === 'failed') this.#saveRecord(job);
    this.#publish({
      type: 'job-state',
      jobId: job.id,
      status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  }

  /** Same contract as `#setStatus`: timestamps first, then the frame. */
  #setLocaleStatus(job: Job, loc: JobLocale, status: JobLocaleStatus): void {
    loc.status = status;
    this.#publish({
      type: 'job-locale-state',
      jobId: job.id,
      locale: loc.locale,
      status,
      startedAt: loc.startedAt,
      finishedAt: loc.finishedAt,
    });
  }

  /** A job that stops early: every locale that neither finished nor was skipped stops with it. */
  #closeLocales(job: Job, status: 'cancelled' | 'failed'): void {
    const at = new Date().toISOString();
    for (const loc of job.locales) {
      if (loc.status === 'done' || loc.status === 'skipped' || loc.status === status) continue;
      loc.finishedAt = at;
      this.#setLocaleStatus(job, loc, status);
    }
    job.currentLocale = null;
  }

  #publish(event: LexiEvent): void {
    this.deps.bus.publish(event);
  }

  async #runNext(): Promise<void> {
    if (this.#activeJobId !== null) return;
    const id = this.#queue.shift();
    if (id === undefined) return;

    const job = this.#jobs.get(id);
    const control = this.#controls.get(id);
    if (!job || !control) return void this.#runNext();

    this.#activeJobId = id;
    job.startedAt = new Date().toISOString();
    this.#setStatus(job, 'running');

    try {
      await this.#run(job, control);
    } catch {
      // `#runOne` already catches everything a unit can throw, so reaching
      // here means something OUTSIDE a unit failed — a disk error appending
      // the log, say. Marking the job `failed` rather than leaving it
      // `running` forever is what makes `failed` a reachable status at all;
      // without this the queue would wedge on the first surprise.
      job.finishedAt = new Date().toISOString();
      this.#closeLocales(job, 'failed');
      this.#setStatus(job, 'failed');
    } finally {
      // MUST run whatever happened above, or a queued job behind this one
      // never gets its turn.
      this.#activeJobId = null;
      void this.#runNext();
    }
  }

  /**
   * The locales, strictly in stored order. A locale's status is read at the
   * moment its turn comes, so a Skip (or an Undo) sent while an earlier locale
   * was still running is honoured.
   */
  async #run(job: Job, control: Control): Promise<void> {
    const timing: JobTiming = { completed: 0, totalMs: 0 };
    for (const loc of job.locales) {
      if (control.cancelled) break;
      if (loc.status !== 'queued') continue;

      job.currentLocale = loc.locale;
      loc.startedAt = new Date().toISOString();
      // A job paused between two locales starts the next one paused, so the
      // row and the job never disagree about whether anything is moving.
      this.#setLocaleStatus(job, loc, control.paused ? 'paused' : 'running');

      await this.#runLocale(job, loc, control, timing);

      if (control.cancelled) break;
      loc.finishedAt = new Date().toISOString();
      this.#setLocaleStatus(job, loc, 'done');
    }

    job.finishedAt = new Date().toISOString();
    if (control.cancelled) {
      this.#closeLocales(job, 'cancelled');
      this.#setStatus(job, 'cancelled');
    } else {
      job.currentLocale = null;
      this.#setStatus(job, 'done');
    }
  }

  /**
   * The worker pool for one locale: a shared cursor N workers pull from, same
   * shape as `scan-project.ts`'s bounded walk, but stateful — pause and cancel
   * are checked between iterations rather than the pool running to completion
   * unconditionally.
   */
  async #runLocale(job: Job, loc: JobLocale, control: Control, timing: JobTiming): Promise<void> {
    const perRequest = Math.max(1, Math.round(this.deps.settings.params.unitsPerRequest));
    const concurrency = Math.max(
      1,
      Math.min(this.deps.settings.params.concurrency, Math.ceil(loc.total / perRequest)),
    );
    let cursor = 0;
    let completed = 0;
    let totalMs = 0;

    const waitIfPaused = async (): Promise<void> => {
      while (control.paused && !control.cancelled) {
        await new Promise<void>((resolve) => control.resumeWaiters.push(resolve));
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (control.cancelled) return;
        await waitIfPaused();
        if (control.cancelled) return;

        const from = cursor;
        if (from >= loc.ids.length) return;
        cursor += perRequest;
        const rowIds = loc.ids.slice(from, from + perRequest);

        loc.currentRowId = rowIds[0] ?? null;
        const started = Date.now();
        const entries =
          rowIds.length === 1
            ? [await this.#runOne(loc.locale, rowIds[0]!, control)]
            : await this.#runBatch(loc.locale, rowIds, control);
        // Time is per REQUEST; a batch's is shared evenly by its units, so the
        // card's "2.1 s per unit" keeps meaning what it says.
        const elapsed = (Date.now() - started) / entries.length;

        for (const entry of entries) {
          loc.currentRowId = entry.rowId;
          totalMs += elapsed;
          completed += 1;
          loc.currentIndex = completed;
          loc.avgMsPerUnit = totalMs / completed;
          timing.totalMs += elapsed;
          timing.completed += 1;
          job.avgMsPerUnit = timing.totalMs / timing.completed;
          this.#tally(job, loc, entry.outcome, entry.rowId);

          await appendJobLogLine(this.deps.cfg, control.projectPath, job.id, entry);
          this.#publish({ type: 'job-log', jobId: job.id, entry: forWire(entry) });
          this.#publish({
            type: 'job-progress',
            jobId: job.id,
            locale: loc.locale,
            jobAvgMsPerUnit: job.avgMsPerUnit,
            currentIndex: loc.currentIndex,
            currentRowId: loc.currentRowId,
            accepted: loc.accepted,
            rejected: loc.rejected,
            skipped: loc.skipped,
            failed: loc.failed,
            avgMsPerUnit: loc.avgMsPerUnit,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  #tally(job: Job, loc: JobLocale, outcome: JobLogOutcome, rowId: string): void {
    if (outcome === 'accepted') {
      loc.accepted += 1;
      let byLocale = this.#written.get(job.id);
      if (byLocale === undefined)
        this.#written.set(job.id, (byLocale = new Map<string, string[]>()));
      const rows = byLocale.get(loc.locale);
      if (rows === undefined) byLocale.set(loc.locale, [rowId]);
      else rows.push(rowId);
      return;
    }
    if (outcome === 'rejected') loc.rejected += 1;
    else if (outcome === 'skipped') loc.skipped += 1;
    else loc.failed += 1;
  }

  get #translateDeps(): TranslateDeps {
    return {
      cfg: this.deps.cfg,
      projects: this.deps.projects,
      settings: this.deps.settings,
      client: this.deps.client,
    };
  }

  async #runOne(locale: string, rowId: string, control: Control): Promise<RunLogEntry> {
    // Reserved at DISPATCH, not at completion — `log()` sorts by it, and a
    // unit's place in the log is when it was sent, whichever finishes first.
    const seq = this.#seq++;
    try {
      const result = await translateUnit(this.#translateDeps, {
        rowId,
        locale,
        overwrite: control.overwrite,
        instruction: control.instruction,
      });
      return this.#entryFor(locale, rowId, seq, result);
    } catch (error) {
      return this.#entryFor(locale, rowId, seq, null, error);
    }
  }

  /**
   * One request for several units (FR-6.8). Entries come back in the locale's
   * order, one per unit, exactly as `#runOne` would have made them — the run
   * log, the SSE frames and the client's draft mirror cannot tell the two
   * paths apart. A failure of the request itself (the endpoint is down) fails
   * every unit in it, which is what a loop of single runs would also have done.
   */
  async #runBatch(
    locale: string,
    rowIds: readonly string[],
    control: Control,
  ): Promise<RunLogEntry[]> {
    const seqs = rowIds.map(() => this.#seq++);
    try {
      const outcomes = await translateBatch(this.#translateDeps, {
        rowIds,
        locale,
        overwrite: control.overwrite,
        instruction: control.instruction,
      });
      return outcomes.map((o, i) =>
        'result' in o
          ? this.#entryFor(locale, o.rowId, seqs[i]!, o.result)
          : this.#entryFor(locale, o.rowId, seqs[i]!, null, o.error),
      );
    } catch (error) {
      return rowIds.map((rowId, i) => this.#entryFor(locale, rowId, seqs[i]!, null, error));
    }
  }

  #entryFor(
    locale: string,
    rowId: string,
    seq: number,
    result: TranslateUnitResponse | null,
    error?: unknown,
  ): RunLogEntry {
    const at = new Date().toISOString();
    const base = { seq, at, rowId, locale };

    if (result !== null) {
      if (result.ok) {
        return {
          ...base,
          outcome: 'accepted',
          run: result.run,
          rejection: null,
          message: null,
          findings: result.findings,
          target: result.target,
          unsavedCount: result.unsavedCount,
        };
      }
      return {
        ...base,
        outcome: 'rejected',
        run: result.run,
        rejection: result.rejection,
        message: null,
        findings: [],
        target: null,
        unsavedCount: result.unsavedCount,
      };
    }
    // FR-6.10: a batch cannot stop to ask permission per unit, so a human
    // translation in the way is a SKIP, not a failure — the string is fine,
    // it is simply someone else's work.
    if (error instanceof HttpError && error.status === 409) {
      return {
        ...base,
        outcome: 'skipped',
        run: null,
        rejection: null,
        message: error.message,
        findings: [],
        target: null,
        unsavedCount: this.deps.projects.unsavedCount,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      outcome: 'failed',
      run: null,
      rejection: null,
      message,
      findings: [],
      target: null,
      unsavedCount: this.deps.projects.unsavedCount,
    };
  }
}
