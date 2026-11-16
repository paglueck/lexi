// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { Job } from '@lexi/shared';

import { JobsStore } from './jobs-store.js';
import { countedLocales, jobTotals, localeList } from '../job-math.js';

/**
 * Transient notifications (M14).
 *
 * The app already had two ways to say something: a shell banner that stays
 * until it is answered (`LxReloadBanner` — files moved under you, decide what
 * to do) and an inline row inside the panel that owns the fact. Neither fits
 * "your batch finished": it needs no decision, it is not about the screen the
 * user is looking at, and a banner that outlives its usefulness trains people
 * to dismiss banners without reading them.
 *
 * So: short-lived, announced politely to a screen reader, and carrying at most
 * one action. Nothing here is the only way to reach anything — a missed toast
 * costs nothing, because the Jobs screen and the Review tab both still say the
 * same thing.
 */

export type ToastTone = 'accent' | 'warn' | 'danger';

export interface ToastAction {
  readonly label: string;
  readonly route: string;
  readonly queryParams?: Readonly<Record<string, string>>;
}

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ToastAction;
}

/** Long enough to read two lines and reach for the action, short enough to forget. */
export const TOAST_MS = 9000;

/**
 * What a finished job has to say, or null when it has nothing to say yet.
 *
 * Pure and exported, so the interesting part — which statuses speak, what the
 * counts read as, and where the action points — is testable without an SSE
 * stream, a fake clock or a `TestBed`.
 */
export function toastForJob(job: Job, id: number): Toast | null {
  const { total, flagged } = jobTotals(job);
  const accepted = countedLocales(job).reduce((n, l) => n + l.accepted, 0);
  const where = localeList(job);
  // Review is per locale, so a one-locale job links straight into it; a job
  // over several sends the user to its card, where each locale row has its own.
  const only = job.locales.length === 1 ? job.locales[0] : undefined;

  if (job.status === 'done') {
    // `accepted`, not `pendingReview`: this fires on the `done` transition,
    // when nothing can have been reviewed yet, and the frame that triggered it
    // carries no review count to be more accurate with. The CARD counts down
    // from `pendingReview`; the toast is a snapshot of a moment.
    const drafts = `${accepted} ${accepted === 1 ? 'draft' : 'drafts'}`;
    return {
      id,
      tone: accepted === 0 ? 'warn' : 'accent',
      title: `Draft job finished · ${where}`,
      detail: flagged === 0 ? `${drafts} written` : `${drafts} written · ${flagged} flagged`,
      // Nothing to review is not a failure — every unit may have been skipped
      // because a person had already translated it (FR-6.10).
      ...(accepted === 0
        ? {}
        : only === undefined
          ? { action: { label: 'View in Jobs →', route: '/jobs' } }
          : {
              action: {
                label: `Review ${accepted} →`,
                route: '/review',
                // The locale rides along so the queue is right even if the run log
                // is gone by the time the link is followed.
                queryParams: { job: job.id, locale: only.locale },
              },
            }),
    };
  }

  if (job.status === 'failed') {
    return {
      id,
      tone: 'danger',
      title: `Draft job failed · ${where}`,
      detail: `${accepted} of ${total} written before it stopped`,
    };
  }

  // A cancellation was the user's own doing a moment ago, on the screen that
  // did it. Telling them about it would be noise.
  return null;
}

@Injectable({ providedIn: 'root' })
export class ToastStore {
  readonly #jobs = inject(JobsStore);

  readonly #toasts = signal<readonly Toast[]>([]);
  readonly toasts = this.#toasts.asReadonly();
  readonly hasToasts = computed(() => this.#toasts().length > 0);

  #nextId = 1;
  /**
   * The status each job was last seen in.
   *
   * A toast belongs to a TRANSITION, not to a state: `JobsStore.jobs` is
   * rewritten on every progress frame, so an effect that merely looked for
   * finished jobs would re-announce the same one several times a second.
   */
  readonly #seen = new Map<string, Job['status']>();
  #primed = false;

  constructor() {
    effect(() => {
      const jobs = this.#jobs.jobs();
      // The first read is the initial `GET /api/jobs`, which routinely returns
      // jobs that finished days ago. Opening a project is not the moment to be
      // told about them, so the first pass only records where things stand.
      if (!this.#primed) {
        for (const job of jobs) this.#seen.set(job.id, job.status);
        this.#primed = jobs.length > 0 || this.#jobs.loaded();
        return;
      }
      for (const job of jobs) {
        if (this.#seen.get(job.id) === job.status) continue;
        this.#seen.set(job.id, job.status);
        const toast = toastForJob(job, this.#nextId);
        if (toast !== null) {
          this.#nextId += 1;
          this.#push(toast);
        }
      }
    });
  }

  /** Say something, for a while. */
  show(toast: Omit<Toast, 'id'>): void {
    this.#push({ ...toast, id: this.#nextId++ });
  }

  dismiss(id: number): void {
    this.#toasts.update((list) => list.filter((t) => t.id !== id));
  }

  #push(toast: Toast): void {
    this.#toasts.update((list) => [...list, toast]);
    setTimeout(() => this.dismiss(toast.id), TOAST_MS);
  }
}
