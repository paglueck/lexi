// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input } from '@angular/core';

/** The setup wizard's three-step header (S2). */
@Component({
  selector: 'lx-step-indicator',
  host: { role: 'list' },
  template: `
    @for (step of steps(); track step; let i = $index) {
      <span class="step" role="listitem" [attr.aria-current]="i === current() ? 'step' : null">
        <span class="dot" [class.dot--done]="i <= current()">{{ i + 1 }}</span>
        <span class="label" [class.label--current]="i === current()">{{ step }}</span>
      </span>
    }
  `,
  styles: `
    :host {
      display: flex;
      gap: var(--lx-sp-18);
    }
    .step {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
      font-size: var(--lx-fs-12);
      color: var(--lx-text-faint);
    }
    .label--current {
      color: var(--lx-text-primary);
      font-weight: var(--lx-fw-600);
    }
    .dot {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-full);
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
      color: var(--lx-text-faint);
    }
    .dot--done {
      border-color: transparent;
      background: var(--lx-accent);
      color: var(--lx-accent-on);
    }
  `,
})
export class LxStepIndicator {
  readonly steps = input.required<readonly string[]>();
  readonly current = input.required<number>();
}
