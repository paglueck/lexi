// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, input } from '@angular/core';
import type { Job, JobLocale } from '@lexi/shared';

import { isActiveJob, flaggedOf } from '../../core/job-math.js';
import { localeName } from '../../core/locale-name.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { LxStackedBar, type BarSegment } from '../../ui/index.js';
import { LxJobStatusChip } from './job-status-chip.js';

/**
 * One locale inside a job card (S14): what it is, how far it got, and the one
 * thing that can be done to it.
 *
 * While the job runs, that is Skip (a queued locale) or Undo (a skipped one) —
 * nothing else, because a locale that has started can only stop with its job.
 * Reviewing what a finished job wrote is the card header's "Review" button.
 */
@Component({
  selector: 'lx-job-locale-row',
  imports: [LxJobStatusChip, LxStackedBar],
  host: { '[attr.data-status]': 'loc().status' },
  template: `
    <div class="name">
      <span class="code">{{ loc().locale }}</span>
      <span class="label">{{ name() }}</span>
      @if (rtl()) {
        <span class="lx-mono rtl">RTL</span>
      }
    </div>
    <lx-stacked-bar class="bar" [segments]="segments()" [total]="loc().total" size="sm" />
    <span class="lx-mono lx-num counts">{{ loc().currentIndex }} / {{ loc().total }}</span>
    <span class="flagged">{{ flagged() > 0 ? flagged() + ' flagged' : '' }}</span>
    <span><lx-job-status-chip [status]="loc().status" /></span>
    <span class="action">
      @if (canToggle()) {
        <button type="button" class="link" (click)="toggle($event)">
          {{ loc().status === 'skipped' ? 'Undo' : 'Skip' }}
        </button>
      }
    </span>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr) 110px 84px 84px 56px;
      gap: var(--lx-sp-12);
      align-items: center;
      min-height: 36px;
      border-bottom: 1px solid var(--lx-border-row);
    }

    .name {
      display: flex;
      align-items: baseline;
      gap: var(--lx-sp-8);
      min-width: 0;
    }

    .code {
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-600);
      color: var(--lx-text-primary);
    }

    .label {
      overflow: hidden;
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-faint);
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .rtl {
      padding: 0 4px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-3);
      font-size: var(--lx-fs-9-5);
      color: var(--lx-text-subtle);
    }

    .counts {
      font-size: var(--lx-fs-11-5);
      text-align: right;
      color: var(--lx-text-mono);
    }

    .flagged {
      font-size: var(--lx-fs-11-5);
      color: var(--lx-danger-on-tint);
    }

    .action {
      text-align: right;
      white-space: nowrap;
    }

    .link {
      padding: 0;
      background: none;
      font-size: var(--lx-fs-11-5);
      color: var(--lx-accent-on-tint);
      text-decoration: none;
    }

    .link:hover {
      color: var(--lx-text-primary);
    }

    :host([data-status='skipped']) .bar,
    :host([data-status='cancelled']) .bar {
      opacity: 0.35;
    }

    :host([data-status='skipped']) .counts,
    :host([data-status='cancelled']) .counts {
      color: var(--lx-text-faint-2);
    }
  `,
})
export class LxJobLocaleRow {
  readonly job = input.required<Job>();
  readonly loc = input.required<JobLocale>();
  readonly rtl = input(false);

  readonly #jobs = inject(JobsStore);

  protected readonly name = computed(() => localeName(this.loc().locale));
  protected readonly flagged = computed(() => flaggedOf(this.loc()));
  protected readonly running = computed(() => isActiveJob(this.job()));

  protected readonly segments = computed<readonly BarSegment[]>(() => {
    const loc = this.loc();
    return [
      { value: Math.max(0, loc.currentIndex - this.flagged()), tone: 'accent', label: 'accepted' },
      { value: this.flagged(), tone: 'danger', label: 'flagged' },
    ];
  });

  /** Skip and Undo, only while the job can still give this locale a turn. */
  protected readonly canToggle = computed(() => {
    const status = this.loc().status;
    return this.running() && (status === 'queued' || status === 'skipped');
  });

  protected toggle(event: Event): void {
    event.stopPropagation();
    const { id } = this.job();
    const { locale, status } = this.loc();
    void (status === 'skipped'
      ? this.#jobs.unskipLocale(id, locale)
      : this.#jobs.skipLocale(id, locale));
  }
}
