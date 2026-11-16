// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { count } from '../../core/format-time.js';
import { ProjectActions } from '../../core/project-actions.js';
import { PhraseCheckoutStore } from '../../core/stores/phrase-checkout-store.js';
import { LxButton } from '../../ui/index.js';
import { LxCheckoutRail } from './checkout-rail.js';
import { LxStepAccount } from './step-account.js';
import { LxStepDestination } from './step-destination.js';
import { LxStepRun } from './step-run.js';
import { LxStepTag } from './step-tag.js';

const TITLES = [
  'Choose account and project',
  'What should be checked out?',
  'Where should the project live?',
  'Check out',
] as const;

const SUBTITLES = [
  'Tokens come from Settings › Phrase. Projects are the ones the token can read.',
  'Every key of the project, or the keys carrying one or more tags.',
  'Lexi creates a regular XLIFF project here. Afterwards it behaves like any other project.',
  'Nothing is written until you start. Only the base locale is fetched; target files start empty.',
] as const;

/**
 * S18 — check out a Phrase project, or some of its tags, as a local XLIFF project.
 *
 * The page is layout and the footer's buttons; state, reset rules and the run
 * live in `PhraseCheckoutStore`, which the step components read directly.
 * "Open project" goes through `ProjectActions.openPath`, like every other open.
 */
@Component({
  selector: 'lx-checkout-page',
  imports: [LxButton, LxCheckoutRail, LxStepAccount, LxStepDestination, LxStepRun, LxStepTag],
  templateUrl: './checkout-page.html',
  styleUrl: './checkout-page.css',
})
export class CheckoutPage {
  protected readonly store = inject(PhraseCheckoutStore);
  readonly #actions = inject(ProjectActions);
  readonly #router = inject(Router);

  protected readonly title = computed(() => TITLES[this.store.step() - 1]);
  protected readonly subtitle = computed(() => SUBTITLES[this.store.step() - 1]);
  protected readonly startLabel = computed(() => {
    const { keys, exact } = this.store.scopeCount();
    if (keys === null) return 'Check out all keys';
    return `Check out ${exact ? '' : 'up to '}${count(keys)} keys`;
  });
  protected readonly opening = computed(() => this.#actions.busy() === 'open');

  constructor() {
    this.store.reset();
    void this.store.load();
  }

  protected cancel(): void {
    void this.#router.navigateByUrl('/start');
  }

  protected openProject(): void {
    const result = this.store.result();
    if (result !== null) void this.#actions.openPath(result.path);
  }
}
