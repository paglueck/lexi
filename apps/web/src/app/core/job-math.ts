// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Job, JobLocale, JobTask } from '@lexi/shared';

/**
 * The numbers S14's job card and S15's draft modal derive from a `Job` — the
 * client half of the design's `jbVals()`.
 *
 * Pure and in one place, because the card's bar, its stats row, the modal's
 * ETA and the locked-locale rule all have to agree on what "done" and
 * "flagged" mean, and on which locales count at all.
 */

/** Used for an ETA before anything has run: the design's measured 2.1 s per unit. */
export const DEFAULT_MS_PER_UNIT = 2100;

export const TASK_LABEL: Record<JobTask, string> = {
  draft: 'Draft untranslated units',
};

export const isActiveJob = (job: Job): boolean =>
  job.status === 'running' || job.status === 'paused' || job.status === 'queued';

/**
 * A unit that needs a human look: the restore gate rejected it, the overwrite
 * guard left a person's translation in place, or the request failed. Same sum
 * the single-locale card used.
 */
export const flaggedOf = (loc: JobLocale): number => loc.rejected + loc.skipped + loc.failed;

/** A locale the user skipped drops out of every total, bar and ETA. */
export const countedLocales = (job: Job): readonly JobLocale[] =>
  job.locales.filter((l) => l.status !== 'skipped');

export interface JobTotals {
  readonly total: number;
  readonly done: number;
  readonly flagged: number;
}

export function jobTotals(job: Job): JobTotals {
  let total = 0;
  let done = 0;
  let flagged = 0;
  for (const loc of countedLocales(job)) {
    total += loc.total;
    done += loc.currentIndex;
    flagged += flaggedOf(loc);
  }
  return { total, done, flagged };
}

/** `de, fr, pl` for up to three locales, `5 locales` beyond that. */
export function localeList(job: Job): string {
  return localeCodeList(job.locales.map((l) => l.locale));
}

/** `de, fr, pl` for up to three locale codes, `5 locales` beyond that. */
export function localeCodeList(codes: readonly string[]): string {
  return codes.length <= 3 ? codes.join(', ') : `${codes.length} locales`;
}

/** The generated title, `Draft untranslated units · de, fr` — also the S15 modal's name prefill. */
export const defaultJobTitle = (task: JobTask, codes: readonly string[]): string =>
  codes.length === 0 ? TASK_LABEL[task] : `${TASK_LABEL[task]} · ${localeCodeList(codes)}`;

export const jobTitle = (job: Job): string =>
  defaultJobTitle(
    job.task,
    job.locales.map((l) => l.locale),
  );

/** What a job is called wherever one job is shown: the name the user gave it, else its title. */
export const jobDisplayName = (job: Job): string => job.name ?? jobTitle(job);

/** `~4 min`, or `~1 h 12 min` from an hour up. Empty for nothing left to do. */
export function etaText(units: number, msPerUnit: number | null = null): string {
  if (units <= 0) return '';
  const seconds = (units * (msPerUnit ?? DEFAULT_MS_PER_UNIT)) / 1000;
  if (seconds < 3600) return `~${Math.max(1, Math.ceil(seconds / 60))} min`;
  const hours = Math.floor(seconds / 3600);
  return `~${hours} h ${Math.ceil((seconds - hours * 3600) / 60)} min`;
}

/** `1 locale`, `3 locales`. */
export const localesText = (n: number): string => `${n} ${n === 1 ? 'locale' : 'locales'}`;

/**
 * Locales already held by an active job of the same task, mapped to that
 * job's number — the S15 rows that show `in #14` and cannot be picked. A
 * locale the user skipped there is free again. The server refuses the same
 * set with a 409, so the two can never disagree.
 */
export function lockedLocales(jobs: readonly Job[], task: JobTask): ReadonlyMap<string, number> {
  const locked = new Map<string, number>();
  for (const job of jobs) {
    if (!isActiveJob(job) || job.task !== task) continue;
    for (const loc of job.locales) {
      if (loc.status !== 'skipped') locked.set(loc.locale, job.number);
    }
  }
  return locked;
}
