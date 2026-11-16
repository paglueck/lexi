// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { IssuesStore } from '../../core/stores/issues-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SaveStore } from '../../core/stores/save-store.js';
import { WizardStore } from '../../core/stores/wizard-store.js';
import { LxButton } from '../button.js';
import { LxIcon } from '../icon.js';
import { LxStepIndicator } from '../step-indicator.js';
import { LxProjectMenu } from './project-menu.js';

export type ChromeMode = 'full' | 'wizard' | 'minimal';

interface Tab {
  readonly path: string;
  readonly label: string;
}

/**
 * The 44px title bar.
 *
 * Deviation 1: no macOS traffic lights, radius or window shadow — those are
 * mock chrome. Everything INSIDE the bar matches the handoff exactly.
 */
@Component({
  selector: 'lx-title-bar',
  imports: [RouterLink, RouterLinkActive, LxButton, LxIcon, LxStepIndicator, LxProjectMenu],
  templateUrl: './title-bar.html',
  styleUrl: './title-bar.css',
})
export class LxTitleBar {
  readonly mode = input<ChromeMode>('full');
  /** The minimal bar's second word, from the route (`data.chromeLabel`). */
  readonly label = input('');

  protected readonly project = inject(ProjectStore);
  protected readonly save = inject(SaveStore);
  protected readonly wizard = inject(WizardStore);
  readonly #jobs = inject(JobsStore);
  protected readonly issues = inject(IssuesStore);

  /** S14's title-bar indicator. Reads `JobsStore`, which is fed by SSE, not a poll. */
  protected readonly runningCount = computed(() => this.#jobs.running().length);
  protected readonly queuedCount = computed(() => this.#jobs.queued().length);

  // S11's tab strip plus S12's Issues and S13's Term Base. The handoffs each
  // draw their own five or six tabs; the app has every screen, so it has every
  // tab, each where its own handoff puts it — Term Base after Style guides.
  protected readonly tabs: readonly Tab[] = [
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/grid', label: 'Grid' },
    { path: '/review', label: 'Review' },
    { path: '/styleguides', label: 'Style guides' },
    { path: '/termbase', label: 'Term Base' },
    { path: '/issues', label: 'Issues' },
    { path: '/jobs', label: 'Jobs' },
  ];

  /** S12's "Validated 14:09 · 4,812 units", shown only while Issues is open. */
  protected readonly validated = computed(() => {
    const s = this.issues.summary();
    if (!this.issues.active() || s === undefined) return null;
    const at =
      s.validatedAt > 0
        ? new Date(s.validatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—';
    return `Validated ${at} · ${s.units.toLocaleString()} units`;
  });

  /**
   * S11's amber "N machine drafts pending" pill.
   *
   * In the chrome rather than on the Review screen, although the mock draws it
   * there: on the Review screen the number is already the queue. Its job is to
   * be visible from the grid, where a batch that finished while somebody was
   * typing is otherwise invisible until they look at Jobs.
   */
  protected readonly pendingDrafts = computed(() =>
    this.project.locales().reduce((sum, l) => sum + l.draftMachine, 0),
  );
}
