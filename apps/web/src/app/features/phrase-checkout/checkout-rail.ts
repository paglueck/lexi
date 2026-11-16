// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';

import {
  PhraseCheckoutStore,
  type CheckoutStepNo,
} from '../../core/stores/phrase-checkout-store.js';

const LABELS = ['Account & project', 'Keys', 'Destination', 'Check out'] as const;

/**
 * S18's left rail: the four steps, each with a one-line summary. Completed
 * steps go back when clicked — unless a checkout is running or done.
 */
@Component({
  selector: 'lx-checkout-rail',
  template: `
    <ol class="steps" aria-label="Checkout steps">
      @for (row of rows(); track row.n) {
        <li>
          <button
            type="button"
            class="step"
            [class.step--current]="row.current"
            [class.step--done]="row.done"
            [disabled]="!row.clickable"
            [attr.aria-current]="row.current ? 'step' : null"
            (click)="store.goTo(row.n)"
          >
            <span class="dot" aria-hidden="true">{{ row.done ? '✓' : row.n }}</span>
            <span class="text">
              <span class="name">{{ row.label }}</span>
              <span class="sum">{{ row.sum }}</span>
            </span>
          </button>
        </li>
      }
    </ol>
    <p class="note">
      Lexi contacts the Phrase API only while this dialog fetches data. The token stays in
      <span class="mono">~/.lexi</span> on this machine and is never written into the project.
    </p>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-4);
      min-height: 0;
      padding: var(--lx-sp-22) var(--lx-sp-14);
      border-right: 1px solid var(--lx-border-section);
      background: var(--lx-bg-rail);
    }
    .steps {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-4);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .step {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: var(--lx-sp-10);
      width: 100%;
      padding: var(--lx-sp-10);
      border: 0;
      border-radius: var(--lx-r-8);
      background: transparent;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .step:disabled {
      cursor: default;
    }
    .step:hover:not(:disabled) {
      background: var(--lx-bg-titlebar);
    }
    .step:focus-visible {
      outline: none;
      box-shadow: var(--lx-ring-focus);
    }
    .step--current {
      background: var(--lx-bg-selected);
    }
    .dot {
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 20px;
      height: 20px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-full);
      color: var(--lx-text-faint);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-10);
    }
    .step--current .dot {
      border-color: var(--lx-accent);
      color: var(--lx-accent);
    }
    .step--done .dot {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
      color: var(--lx-accent);
    }
    .text {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-3);
      min-width: 0;
    }
    .name {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-500);
    }
    .step--current .name,
    .step--done .name {
      color: var(--lx-text-primary);
    }
    .step--current .name {
      font-weight: var(--lx-fw-600);
    }
    .sum {
      overflow: hidden;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .note {
      margin: auto 0 0;
      padding: var(--lx-sp-12) var(--lx-sp-10);
      color: var(--lx-text-faint-2);
      font-size: var(--lx-fs-11-5);
      line-height: 1.6;
    }
    .mono {
      font-family: var(--lx-font-mono);
    }
  `,
})
export class LxCheckoutRail {
  protected readonly store = inject(PhraseCheckoutStore);

  protected readonly rows = computed(() => {
    const step = this.store.step();
    const done = this.store.phase() === 'done';
    const locked = this.store.locked();
    const sums = this.store.railSummaries();
    return LABELS.map((label, i) => {
      const n = (i + 1) as CheckoutStepNo;
      return {
        n,
        label,
        sum: sums[i] ?? '',
        done: done || n < step,
        current: n === step && !done,
        clickable: !locked && n < step,
      };
    });
  });
}
