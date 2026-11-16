// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input } from '@angular/core';
import type { JobLocaleStatus, JobStatus } from '@lexi/shared';

/**
 * S14's status chip, for a job and for each of its locales — one colour table
 * for both (README "Status chip colors"), keyed on `[attr.data-status]` like
 * every state-driven component in this kit.
 */
@Component({
  selector: 'lx-job-status-chip',
  host: { class: 'lx-mono', '[attr.data-status]': 'status()' },
  template: `{{ status() }}`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      border-radius: var(--lx-r-3);
      border: 1px solid var(--lx-neutral-tint-border);
      background: transparent;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-9-5);
      line-height: 1.4;
      white-space: nowrap;
    }

    :host([data-status='running']) {
      color: var(--lx-accent);
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
    }

    :host([data-status='done']) {
      color: var(--lx-accent-on-tint);
      border-color: var(--lx-accent-tint-border);
    }

    :host([data-status='paused']) {
      color: var(--lx-warn);
      border-color: var(--lx-warn-tint-border);
      background: var(--lx-warn-tint-bg);
    }

    :host([data-status='skipped']) {
      color: var(--lx-text-faint);
      border-color: var(--lx-border-strong);
    }

    :host([data-status='cancelled']) {
      color: var(--lx-danger-on-tint);
      border-color: var(--lx-danger-border-soft);
    }

    :host([data-status='failed']) {
      color: var(--lx-danger-on-tint);
      border-color: var(--lx-danger-tint-border);
      background: var(--lx-danger-tint-bg);
    }
  `,
})
export class LxJobStatusChip {
  readonly status = input.required<JobStatus | JobLocaleStatus>();
}
