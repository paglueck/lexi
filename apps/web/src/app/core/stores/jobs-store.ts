// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type {
  Job,
  JobCreateRequest,
  JobLocale,
  JobTask,
  ReportQuery,
  RunLogEntry,
  UnitTarget,
} from '@lexi/shared';

import { isActiveJob, lockedLocales } from '../job-math.js';

import { JobsApi } from '../api/jobs-api.js';
import { messageOf } from '../api/server-message.js';
import { DraftStore } from './draft-store.js';
import { EventsStore, type JobFrame } from './events-store.js';

/**
 * Fold one SSE frame into the job list.
 *
 * Pure, and exported for the spec, same as `nextSelectedIndex` in
 * `units-store.ts`: it is the one piece of this store's behaviour that would
 * otherwise only be checkable by driving a whole `EventsStore` through
 * `TestBed`, for a class this codebase's other stores do not test that way.
 */
export function applyJobFrame(jobs: readonly Job[], frame: JobFrame): readonly Job[] {
  const patchLocale = (job: Job, locale: string, patch: (l: JobLocale) => JobLocale): Job => ({
    ...job,
    locales: job.locales.map((l) => (l.locale === locale ? patch(l) : l)),
  });

  switch (frame.type) {
    case 'job-progress':
      return jobs.map((j) =>
        j.id === frame.jobId
          ? {
              ...patchLocale(j, frame.locale, (l) => ({
                ...l,
                currentIndex: frame.currentIndex,
                currentRowId: frame.currentRowId,
                accepted: frame.accepted,
                rejected: frame.rejected,
                skipped: frame.skipped,
                failed: frame.failed,
                avgMsPerUnit: frame.avgMsPerUnit,
              })),
              currentLocale: frame.locale,
              avgMsPerUnit: frame.jobAvgMsPerUnit,
            }
          : j,
      );

    case 'job-locale-state':
      return jobs.map((j) => {
        if (j.id !== frame.jobId) return j;
        const next = patchLocale(j, frame.locale, (l) => ({
          ...l,
          status: frame.status,
          startedAt: frame.startedAt,
          finishedAt: frame.finishedAt,
        }));
        // The locale that starts (or pauses) is the one the "now" line names.
        const moving = frame.status === 'running' || frame.status === 'paused';
        return moving ? { ...next, currentLocale: frame.locale } : next;
      });

    case 'job-state':
      // The timestamps come with the transition, because the transition is the
      // only moment they change. Folding them here is what makes a card show
      // "11:34 → 11:36" for a job the user actually watched, rather than only
      // after a reload.
      return jobs.map((j) =>
        j.id === frame.jobId
          ? {
              ...j,
              status: frame.status,
              startedAt: frame.startedAt,
              finishedAt: frame.finishedAt,
              ...(isActiveJob({ ...j, status: frame.status }) ? {} : { currentLocale: null }),
            }
          : j,
      );

    case 'job-removed':
      return jobs.filter((j) => j.id !== frame.jobId);

    case 'job-log':
      // The run log itself is a separate signal, keyed to whichever job is
      // selected — see `appendLogEntry` below. A `job-log` frame never
      // changes the job LIST, only whether it applies to what is on screen.
      return jobs;
  }
}

/** Append a run-log entry, de-duplicated and kept in `seq` order. */
export function appendLogEntry(
  entries: readonly RunLogEntry[],
  entry: RunLogEntry,
): readonly RunLogEntry[] {
  if (entries.some((e) => e.seq === entry.seq)) return entries;
  return [...entries, entry].sort((a, b) => a.seq - b.seq);
}

/**
 * Fold a WHOLE BATCH of queued frames, in arrival order — because
 * Angular's effects coalesce multiple signal writes into one
 * run, so `EventsStore` queues every frame rather than keeping only the
 * latest; this is the function that has to consume the whole queue in one
 * pass; folding one frame at a time via `applyJobFrame`/`appendLogEntry`
 * alone (called only once, on only the last frame) is precisely the bug.
 */
export function applyJobFrames(
  jobs: readonly Job[],
  log: readonly RunLogEntry[],
  selectedId: string | null,
  frames: readonly JobFrame[],
): { readonly jobs: readonly Job[]; readonly log: readonly RunLogEntry[] } {
  let nextJobs = jobs;
  let nextLog = log;
  for (const frame of frames) {
    nextJobs = applyJobFrame(nextJobs, frame);
    if (frame.type === 'job-log' && frame.jobId === selectedId) {
      nextLog = appendLogEntry(nextLog, frame.entry);
    }
  }
  return { jobs: nextJobs, log: nextLog };
}

export interface AdoptedDraft {
  readonly rowId: string;
  readonly locale: string;
  readonly target: UnitTarget;
  readonly unsavedCount: number;
}

/**
 * Which accepted job-log frames need mirroring into `DraftStore` — a batch job commits into the server's overlay entirely
 * server-side, so without this the client's dirty-buffer mirror (what the
 * Save button actually reads) never learns anything was written, even though
 * the grid — which reads server-rendered rows — shows the draft correctly.
 * Pure, so the "which frames" question is testable without a `DraftStore`.
 */
export function draftsToAdopt(frames: readonly JobFrame[]): readonly AdoptedDraft[] {
  const drafts: AdoptedDraft[] = [];
  for (const frame of frames) {
    if (
      frame.type === 'job-log' &&
      frame.entry.outcome === 'accepted' &&
      frame.entry.target !== null
    ) {
      drafts.push({
        rowId: frame.entry.rowId,
        locale: frame.entry.locale,
        target: frame.entry.target,
        unsavedCount: frame.entry.unsavedCount,
      });
    }
  }
  return drafts;
}

/**
 * Which job a reviewer opening this screen most likely wants to see: the one
 * actually running, or — if none is — the most recently created.
 */
export function pickInitialSelection(jobs: readonly Job[]): string | null {
  if (jobs.length === 0) return null;
  return (jobs.find((j) => j.status === 'running') ?? jobs[jobs.length - 1])?.id ?? null;
}

/** Creation order, oldest first — the order the queue RUNS jobs in (FIFO). */
export function runOrder(jobs: readonly Job[]): readonly Job[] {
  return [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
}

/** S14's list order: the newest job at the top, the oldest at the bottom, whatever their status. */
export function queueOrder(jobs: readonly Job[]): readonly Job[] {
  return [...runOrder(jobs)].reverse();
}

/**
 * The unfinished job a queued one waits for — the last one created before it
 * that has not finished — or null when it is next. Read from run order, not
 * the newest-first list, so "starts after #14" stays true.
 */
export function waitsFor(jobs: readonly Job[], id: string): Job | null {
  const order = runOrder(jobs);
  const at = order.findIndex((j) => j.id === id);
  return order.slice(0, Math.max(0, at)).filter(isActiveJob).pop() ?? null;
}

export type LogLocaleFilter = 'all' | (string & {});

/**
 * S14 — the job queue (M11).
 *
 * The list is loaded once (`refresh`, called by the Jobs page on entry) and
 * kept current by SSE from then on: `EventsStore` queues each `job-progress` /
 * `job-state` / `job-log` frame, and the `effect()` below drains the WHOLE
 * queue and folds every frame in, in order — not just the latest one. Angular
 * coalesces multiple signal writes into one effect run, so a queue is not
 * optional here: `job-log` and `job-progress` are published back to back with
 * no `await` between them (`job-queue.ts`), routinely land in the same task,
 * and a version that read only the latest frame silently dropped whichever
 * one lost that race. Cheap regardless, because a project has
 * a handful of jobs, not twenty thousand rows — `UnitsStore`'s window-and-LRU
 * machinery would be solving a problem this screen does not have.
 *
 * The selected job's run log is fetched in full on selection and topped up
 * from the same SSE frames afterward, so switching jobs never re-fetches what
 * is already on screen.
 *
 * Every ACCEPTED entry also lands in `DraftStore`, the same call
 * `TranslateStore` makes for a single-unit run (M9) — without it a job's
 * drafts exist only on the server: visible in the grid, which reads
 * server-rendered rows, but invisible to the Save button, which reads the
 * client's own dirty-buffer mirror (reported from use).
 */
@Injectable({ providedIn: 'root' })
export class JobsStore {
  readonly #api = inject(JobsApi);
  readonly #events = inject(EventsStore);
  readonly #drafts = inject(DraftStore);

  readonly #jobs = signal<readonly Job[]>([]);
  readonly #selectedId = signal<string | null>(null);
  readonly #log = signal<readonly RunLogEntry[]>([]);
  readonly #loaded = signal(false);
  readonly #error = signal<string | null>(null);
  /**
   * A completed card's "Show flagged units" link (S8) cannot honestly point at
   * a grid filter: a REJECTED unit's target is left untouched (FR-6.11), so
   * there is no cell for the grid to find. It narrows the run log instead.
   */
  readonly #logFilter = signal<'all' | 'flagged'>('all');
  /** S14's run-log segments: every entry, or one locale's. */
  readonly #logLocale = signal<LogLocaleFilter>('all');

  readonly jobs = this.#jobs.asReadonly();
  readonly selectedId = this.#selectedId.asReadonly();
  readonly log = this.#log.asReadonly();
  readonly loaded = this.#loaded.asReadonly();
  /**
   * The last list request failed. Without it a server that did not answer
   * rendered as "No jobs yet", which is a claim about the queue the page had no
   * way of knowing.
   */
  readonly error = this.#error.asReadonly();
  readonly logFilter = this.#logFilter.asReadonly();
  readonly logLocale = this.#logLocale.asReadonly();

  /** The selected job's log after the flagged filter, before the locale one — what the segments count. */
  readonly filteredLog = computed<readonly RunLogEntry[]>(() => {
    const entries = this.#log();
    return this.#logFilter() === 'all'
      ? entries
      : entries.filter(
          (e) => e.outcome === 'rejected' || e.outcome === 'skipped' || e.outcome === 'failed',
        );
  });

  readonly visibleLog = computed<readonly RunLogEntry[]>(() => {
    const locale = this.#logLocale();
    const entries = this.filteredLog();
    return locale === 'all' ? entries : entries.filter((e) => e.locale === locale);
  });

  readonly running = computed(() => this.#jobs().filter((j) => j.status === 'running'));
  /** Running and paused share one card slot at the top of the queue column. */
  readonly active = computed(() =>
    this.#jobs().filter((j) => j.status === 'running' || j.status === 'paused'),
  );
  readonly queued = computed(() => this.#jobs().filter((j) => j.status === 'queued'));
  /** Everything not finished — running, paused and queued. */
  readonly unfinished = computed(() => this.#jobs().filter(isActiveJob));
  /** The whole list in S14's order. */
  readonly ordered = computed(() => queueOrder(this.#jobs()));
  readonly completed = computed(() =>
    this.#jobs().filter(
      (j) => j.status === 'done' || j.status === 'cancelled' || j.status === 'failed',
    ),
  );

  readonly selected = computed<Job | null>(
    () => this.#jobs().find((j) => j.id === this.#selectedId()) ?? null,
  );

  constructor() {
    effect(() => {
      const frames = this.#events.drainJobFrames();
      if (frames.length === 0) return;
      const folded = applyJobFrames(this.#jobs(), this.#log(), this.#selectedId(), frames);
      this.#jobs.set(folded.jobs);
      this.#log.set(folded.log);

      // Mirror every accepted draft into the client's dirty buffer, exactly
      // the way a single-unit run already does — otherwise the Save button
      // never learns a background job wrote anything.
      for (const draft of draftsToAdopt(frames)) {
        this.#drafts.adopt(draft.rowId, draft.locale, draft.target, draft.unsavedCount);
      }
    });
  }

  async refresh(): Promise<void> {
    let jobs: Job[];
    try {
      jobs = await this.#api.list();
    } catch (error) {
      this.#error.set(messageOf(error, 'The job queue could not be loaded.'));
      return;
    }
    this.#error.set(null);
    this.#jobs.set(jobs);
    this.#loaded.set(true);
    if (this.#selectedId() === null) {
      const id = pickInitialSelection(jobs);
      if (id !== null) void this.select(id);
    }
  }

  setLogFilter(filter: 'all' | 'flagged'): void {
    this.#logFilter.set(filter);
  }

  setLogLocale(locale: LogLocaleFilter): void {
    this.#logLocale.set(locale);
  }

  /** Locales an active job of `task` already holds, mapped to its number. */
  locked(task: JobTask): ReadonlyMap<string, number> {
    return lockedLocales(this.#jobs(), task);
  }

  async select(id: string, filter: 'all' | 'flagged' = 'all'): Promise<void> {
    this.#selectedId.set(id);
    this.#log.set([]);
    this.#logFilter.set(filter);
    this.#logLocale.set('all');
    const { entries } = await this.#api.log(id);
    // A frame for this job may have arrived while the fetch was in flight —
    // keep whichever run log is longer rather than risk dropping an entry.
    if (this.#selectedId() === id && entries.length >= this.#log().length) {
      this.#log.set(entries);
    }
  }

  /**
   * Queue one job over every locale in the request, in its order. Selected
   * only when nothing else is, so queueing from the Grid while a job runs
   * does not pull the run log away from the one that is moving.
   */
  async create(request: JobCreateRequest): Promise<Job> {
    const job = await this.#api.create(request);
    this.#patch(job);
    if (this.#selectedId() === null || this.selected() === null) void this.select(job.id);
    return job;
  }

  async remove(id: string): Promise<void> {
    await this.#api.remove(id);
    this.#drop(new Set([id]));
  }

  /** Takes every finished job off the list. Their logs and reports stay on disk. */
  async clearFinished(): Promise<void> {
    const { removed } = await this.#api.clearFinished();
    this.#drop(new Set(removed));
  }

  #drop(ids: ReadonlySet<string>): void {
    this.#jobs.update((list) => list.filter((j) => !ids.has(j.id)));
    const selected = this.#selectedId();
    if (selected !== null && ids.has(selected)) {
      const next = pickInitialSelection(this.#jobs());
      this.#selectedId.set(null);
      this.#log.set([]);
      if (next !== null) void this.select(next);
    }
  }

  async skipLocale(id: string, locale: string): Promise<void> {
    this.#patch(await this.#api.skipLocale(id, locale));
  }

  async unskipLocale(id: string, locale: string): Promise<void> {
    this.#patch(await this.#api.unskipLocale(id, locale));
  }

  async pause(id: string): Promise<void> {
    this.#patch(await this.#api.pause(id));
  }

  async resume(id: string): Promise<void> {
    this.#patch(await this.#api.resume(id));
  }

  async cancel(id: string): Promise<void> {
    this.#patch(await this.#api.cancel(id));
  }

  /** Saves the job's review report, or its translations as CSV for a market reviewer. */
  async downloadReport(id: string, query: ReportQuery): Promise<void> {
    const { blob, filename } = await this.#api.report(id, query);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  #patch(job: Job): void {
    this.#jobs.update((list) => {
      const at = list.findIndex((j) => j.id === job.id);
      if (at === -1) return [...list, job];
      const next = [...list];
      next[at] = job;
      return next;
    });
  }
}
