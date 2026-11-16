// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Job, JobLocale } from '@lexi/shared';

/** The fields that belong to a job's locale rather than to the job itself. */
const LOCALE_KEYS = [
  'total',
  'ids',
  'currentIndex',
  'currentRowId',
  'accepted',
  'rejected',
  'skipped',
  'failed',
] as const;

type LocaleKey = (typeof LOCALE_KEYS)[number];

/** A locale of a job, for specs. */
export function jobLocale(over: Partial<JobLocale> = {}): JobLocale {
  return {
    locale: 'de',
    status: 'running',
    startedAt: null,
    finishedAt: null,
    total: 3,
    ids: ['a', 'b', 'c'],
    currentIndex: 0,
    currentRowId: null,
    accepted: 0,
    rejected: 0,
    skipped: 0,
    failed: 0,
    avgMsPerUnit: null,
    pendingReview: 0,
    ...over,
  };
}

/**
 * A job for specs. Without `locales`, it is a one-locale job (`de`, or
 * `locale`), and any per-locale field passed flat — `accepted`, `total` … —
 * lands on that locale, so a spec about one locale reads like it used to.
 */
export function jobFixture(
  over: Partial<Job> & Partial<Pick<JobLocale, LocaleKey>> & { locale?: string } = {},
): Job {
  const { locale, ...rest } = over;
  const localeOver: Partial<JobLocale> = {};
  const jobOver: Partial<Job> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((LOCALE_KEYS as readonly string[]).includes(key))
      (localeOver as Record<string, unknown>)[key] = value;
    else (jobOver as Record<string, unknown>)[key] = value;
  }
  const status = jobOver.status ?? 'running';
  const localeStatus: JobLocale['status'] =
    status === 'running' || status === 'paused' || status === 'queued' || status === 'done'
      ? status
      : 'cancelled';
  return {
    id: 'j1',
    number: 1,
    task: 'draft',
    name: null,
    status,
    createdAt: '2026-09-17T10:00:00Z',
    startedAt: '2026-09-17T10:00:00Z',
    finishedAt: null,
    locales: [jobLocale({ locale: locale ?? 'de', status: localeStatus, ...localeOver })],
    currentLocale: status === 'running' || status === 'paused' ? (locale ?? 'de') : null,
    avgMsPerUnit: null,
    pendingReview: 0,
    ...jobOver,
  };
}
