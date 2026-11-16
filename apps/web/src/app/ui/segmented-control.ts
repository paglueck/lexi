// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input, model } from '@angular/core';

export interface SegmentOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  /** M12: the Focus option disables itself when more or fewer than one locale column is visible. */
  readonly disabled?: boolean;
  /** Shown as the button's `title` — the explanation for why it is disabled. */
  readonly title?: string;
}

/** The Grid / Focus switch (FR-3.3), and the System / User / Schema tabs in S5. */
@Component({
  selector: 'lx-segmented-control',
  host: {
    role: 'group',
    '[attr.aria-label]': 'ariaLabel() || null',
    '[attr.aria-labelledby]': 'ariaLabelledby() || null',
    '(keydown)': 'onKeydown($event)',
  },
  template: `
    @for (opt of options(); track opt.value) {
      <button
        type="button"
        class="seg"
        [class.seg--active]="opt.value === value()"
        [attr.aria-pressed]="opt.value === value()"
        [disabled]="opt.disabled ?? false"
        [title]="opt.title ?? ''"
        (click)="opt.disabled ? null : value.set(opt.value)"
      >
        {{ opt.label }}
      </button>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      gap: 0;
      padding: 2px;
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-rail);
    }
    .seg {
      padding: 3px 10px;
      border-radius: var(--lx-r-5);
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-subtle);
      background: transparent;
    }
    .seg--active {
      background: var(--lx-bg-segment-active);
      color: var(--lx-text-primary);
      font-weight: var(--lx-fw-600);
    }
    .seg:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `,
})
export class LxSegmentedControl<T extends string = string> {
  readonly options = input.required<readonly SegmentOption<T>[]>();
  readonly value = model.required<T>();
  /**
   * The group's accessible name. Without one a screen reader hears "Error,
   * pressed" eleven times on the Validation pane with nothing saying which rule
   * each belongs to.
   */
  readonly ariaLabel = input('');
  readonly ariaLabelledby = input('');

  /** ←/→ move to the neighbouring enabled option and choose it. */
  protected onKeydown(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    const enabled = this.options().filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((o) => o.value === this.value());
    const next = enabled[(Math.max(current, 0) + step + enabled.length) % enabled.length]!;
    event.preventDefault();
    this.value.set(next.value);
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.seg',
    );
    buttons[this.options().indexOf(next)]?.focus();
  }
}
