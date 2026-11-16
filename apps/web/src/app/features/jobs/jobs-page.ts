// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject, signal } from '@angular/core';

import { messageOf } from '../../core/api/server-message.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { LxButton } from '../../ui/button.js';
import { LxJobCard } from './job-card.js';
import { LxRunLogPanel } from './run-log-panel.js';

/**
 * S14 — the job queue (M11). It monitors and controls jobs; it never creates
 * them — that is the Grid's "Translate..." (S15).
 *
 * One column of cards, the newest job at the top — each rendered through the SAME `LxJobCard`, which reads its own
 * status off `[attr.data-status]` (the recipe every state-driven component in
 * this kit uses). The run log on the right always shows the SELECTED job,
 * which `JobsStore` keeps pointed at the running job by default.
 */
@Component({
  selector: 'lx-jobs-page',
  imports: [LxButton, LxJobCard, LxRunLogPanel],
  templateUrl: './jobs-page.html',
  styleUrl: './jobs-page.css',
})
export class JobsPage {
  protected readonly jobs = inject(JobsStore);
  protected readonly clearing = signal(false);
  protected readonly clearError = signal<string | null>(null);

  /** The header's "Clear finished": every done, cancelled or failed job off the list. */
  protected async clearFinished(): Promise<void> {
    this.clearing.set(true);
    this.clearError.set(null);
    try {
      await this.jobs.clearFinished();
    } catch (error) {
      this.clearError.set(messageOf(error, 'The finished jobs could not be cleared.'));
    } finally {
      this.clearing.set(false);
    }
  }

  constructor() {
    // Every entry, not only the first: `pendingReview` moves while the user is
    // on the REVIEW screen, and no job event reports it (reviewing is an
    // ordinary target PATCH). A project has a handful of jobs, not twenty
    // thousand rows, so re-asking is cheaper than being wrong.
    void this.jobs.refresh();
  }
}
