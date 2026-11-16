// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Job } from '@lexi/shared';

import { toastForJob } from './toast-store.js';
import { jobFixture, jobLocale } from '../testing/job-fixture.js';

/**
 * What a finished job says, and where its action points. Pure, so the decision
 * is testable without an SSE stream or a fake clock — the parts that need
 * those (the transition edge, the auto-dismiss) are one `setTimeout` and one
 * `Map` around this function.
 */

const job = (over: Parameters<typeof jobFixture>[0] = {}): Job =>
  jobFixture({
    status: 'done',
    finishedAt: '2026-09-17T10:01:00Z',
    total: 24,
    ids: [],
    currentIndex: 24,
    accepted: 20,
    rejected: 4,
    avgMsPerUnit: 2100,
    ...over,
  });

describe('toastForJob', () => {
  it('names the locale, the counts, and links to exactly what the job wrote', () => {
    const toast = toastForJob(job(), 1);
    expect(toast?.title).toBe('Draft job finished · de');
    expect(toast?.detail).toBe('20 drafts written · 4 flagged');
    expect(toast?.action).toEqual({
      label: 'Review 20 →',
      route: '/review',
      // The locale rides along so the queue is still right once the run log is
      // gone — `JobQueue` keeps its jobs in memory.
      queryParams: { job: 'j1', locale: 'de' },
    });
  });

  it('leaves out the flagged count when nothing was flagged', () => {
    expect(toastForJob(job({ rejected: 0, skipped: 0, failed: 0 }), 1)?.detail).toBe(
      '20 drafts written',
    );
  });

  it('offers no review action when the job wrote nothing', () => {
    // Not a failure: every unit may have been skipped because a person had
    // already translated it (FR-6.10). There is simply nothing to review.
    const toast = toastForJob(job({ accepted: 0, skipped: 24, rejected: 0 }), 1);
    expect(toast?.action).toBeUndefined();
    expect(toast?.tone).toBe('warn');
  });

  it('reports a failure as one, with how far it got', () => {
    const toast = toastForJob(job({ status: 'failed', accepted: 7 }), 1);
    expect(toast?.tone).toBe('danger');
    expect(toast?.detail).toBe('7 of 24 written before it stopped');
  });

  it('says nothing about a cancellation', () => {
    // The user cancelled it themselves a moment ago, on the screen that did it.
    expect(toastForJob(job({ status: 'cancelled' }), 1)).toBeNull();
  });

  it('says nothing about a job that is still running', () => {
    expect(toastForJob(job({ status: 'running' }), 1)).toBeNull();
  });

  it('adds up every locale, and sends a job over several to its card', () => {
    const toast = toastForJob(
      job({
        locales: [
          jobLocale({
            locale: 'de',
            status: 'done',
            total: 10,
            currentIndex: 10,
            accepted: 9,
            rejected: 1,
          }),
          jobLocale({ locale: 'fr', status: 'done', total: 5, currentIndex: 5, accepted: 5 }),
          jobLocale({ locale: 'pl', status: 'skipped', total: 50 }),
        ],
      }),
      1,
    );
    expect(toast?.title).toBe('Draft job finished · de, fr, pl');
    expect(toast?.detail).toBe('14 drafts written · 1 flagged');
    // Review is one locale's queue; the card has a link per locale.
    expect(toast?.action).toEqual({ label: 'View in Jobs →', route: '/jobs' });
  });

  it('gets the singular right for a one-unit job', () => {
    expect(toastForJob(job({ accepted: 1, total: 1, rejected: 0 }), 1)?.detail).toBe(
      '1 draft written',
    );
  });
});
