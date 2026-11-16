// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, input } from '@angular/core';

/** A row in the files/namespaces tree or the settings nav. */
@Component({
  selector: 'lx-nav-row',
  host: { '[class.row--active]': 'active()' },
  template: `
    <span class="label">{{ label() }}</span>
    @if (count() !== null) {
      <span class="count lx-mono lx-num">{{ count() }}</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
      padding: var(--lx-sp-6) var(--lx-sp-8);
      border-radius: var(--lx-r-6);
      font-size: var(--lx-fs-12-5);
      color: var(--lx-text-subtle);
      cursor: pointer;
    }
    .row--active {
      background: var(--lx-bg-nav-active);
      color: var(--lx-accent-on-tint);
      font-weight: var(--lx-fw-600);
    }
    .label {
      flex: 1;
    }
    .count {
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint-2);
    }
    .row--active .count {
      color: var(--lx-accent-on-tint-dim);
    }
  `,
})
export class LxNavRow {
  readonly label = input.required<string>();
  readonly active = input(false, { transform: booleanAttribute });
  readonly count = input<number | null>(null);
}
