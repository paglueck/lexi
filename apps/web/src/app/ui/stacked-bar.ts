// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, input } from '@angular/core';

export type BarTone = 'accent' | 'warn' | 'danger' | 'accent-muted' | 'warn-muted';
export type BarSize = 'lg' | 'md' | 'sm';

export interface BarSegment {
  readonly value: number;
  readonly tone: BarTone;
  readonly label: string;
}

/**
 * The per-locale coverage bar (FR-2.3) and the job / token meters.
 *
 * The track is the untranslated remainder — there is no separate segment for
 * it. role="img" plus a generated aria-label, because a stack of coloured divs
 * is otherwise completely silent to a screen reader.
 */
@Component({
  selector: 'lx-stacked-bar',
  host: {
    role: 'img',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.data-size]': 'size()',
  },
  template: `
    @for (seg of segments(); track seg.label) {
      <span class="seg" [attr.data-tone]="seg.tone" [style.width.%]="percent(seg.value)"></span>
    }
  `,
  styles: `
    :host {
      display: flex;
      height: var(--bar-h, 8px);
      border-radius: var(--bar-r, 3px);
      overflow: hidden;
      background: var(--lx-neutral-track);
    }
    :host([data-size='md']) {
      --bar-h: 6px;
      background: var(--lx-neutral-track-soft);
    }
    :host([data-size='sm']) {
      --bar-h: 4px;
      --bar-r: 2px;
      background: var(--lx-neutral-track-soft);
    }
    .seg[data-tone='accent'] {
      background: var(--lx-accent-bar);
    }
    .seg[data-tone='warn'] {
      background: var(--lx-warn-bar);
    }
    .seg[data-tone='danger'] {
      background: var(--lx-danger-bar);
    }
    .seg[data-tone='accent-muted'] {
      background: var(--lx-accent-bar-muted);
    }
    .seg[data-tone='warn-muted'] {
      background: var(--lx-warn-bar-muted);
    }
  `,
})
export class LxStackedBar {
  readonly segments = input.required<readonly BarSegment[]>();
  readonly total = input.required<number>();
  readonly size = input<BarSize>('lg');

  protected readonly ariaLabel = computed(() =>
    this.segments()
      .map((s) => `${this.percent(s.value).toFixed(0)}% ${s.label}`)
      .join(', '),
  );

  protected percent(value: number): number {
    const total = this.total();
    return total <= 0 ? 0 : (value / total) * 100;
  }
}
