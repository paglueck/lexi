// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input, model } from '@angular/core';

export type CountTone = 'default' | 'danger' | 'accent';

/** A filter row in the grid's left rail (FR-3.4): label, checkbox, right-aligned count. */
@Component({
  selector: 'lx-checkbox-row',
  host: {
    role: 'checkbox',
    '[attr.aria-checked]': 'checked()',
    '[attr.tabindex]': '0',
    '[class.row--active]': 'checked()',
    '(click)': 'checked.set(!checked())',
    '(keydown.space)': 'checked.set(!checked()); $event.preventDefault()',
  },
  template: `
    <span class="box" [class.box--on]="checked()" aria-hidden="true">
      @if (checked()) {
        <span class="tick">✓</span>
      }
    </span>
    <span class="label">{{ label() }}</span>
    @if (count() !== null) {
      <span class="count lx-mono lx-num" [attr.data-tone]="countTone()">{{ count() }}</span>
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
    }
    .box {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 13px;
      height: 13px;
      flex: none;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-3);
    }
    .box--on {
      border-color: transparent;
      background: var(--lx-accent);
      color: var(--lx-accent-on);
    }
    .tick {
      font-size: var(--lx-fs-9);
      font-weight: var(--lx-fw-700);
      line-height: 1;
    }
    .label {
      flex: 1;
    }
    .count {
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint-2);
    }
    .count[data-tone='danger'] {
      color: var(--lx-danger);
    }
    .count[data-tone='accent'] {
      color: var(--lx-accent-on-tint-dim);
    }
  `,
})
export class LxCheckboxRow {
  readonly label = input.required<string>();
  readonly checked = model(false);
  readonly count = input<number | null>(null);
  readonly countTone = input<CountTone>('default');
}
