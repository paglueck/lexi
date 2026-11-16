// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, signal } from '@angular/core';

/**
 * The setup wizard's position, published so the title bar can draw the step
 * indicator (S2 puts it in the chrome, not in the page body).
 *
 * The wizard itself is one route with three internal steps rather than three
 * routes: the scan result is the state all three share, and re-scanning on a
 * back-navigation would be both slow and surprising.
 */
export const WIZARD_STEPS = ['Scan', 'Map locales', 'Source locale', 'Phrase'] as const;
/** 3 — "Phrase" — is optional and only offered on a project's first open. */
export type WizardStep = 0 | 1 | 2 | 3;

@Injectable({ providedIn: 'root' })
export class WizardStore {
  readonly steps = WIZARD_STEPS;

  readonly #step = signal<WizardStep>(0);
  readonly #active = signal(false);

  readonly step = this.#step.asReadonly();
  /** False outside the wizard, so the title bar knows not to draw the steps. */
  readonly active = this.#active.asReadonly();
  readonly label = computed(() => WIZARD_STEPS[this.#step()]);

  enter(): void {
    this.#active.set(true);
    this.#step.set(0);
  }

  go(step: WizardStep): void {
    this.#step.set(step);
  }

  leave(): void {
    this.#active.set(false);
  }
}
