// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, input } from '@angular/core';
import type { PreviousTarget, SegmentDto } from '@lexi/shared';

import { LxBadge } from '../../ui/badge.js';
import { LxPlaceholderChip } from '../../ui/placeholder-chip.js';
import { STATE_LABEL } from '../../ui/glyphs.js';
import { diffSegments, isUnchanged } from './diff-segments.js';

/**
 * S11's "against previous target" card (M14).
 *
 * The card is ABSENT, not empty, when the draft filled a cell that had nothing
 * in it — which is the common case for a first pass over an untranslated
 * locale. A diff against nothing is every word marked as added, which says
 * less than the draft card directly above it already does.
 */
@Component({
  selector: 'lx-review-diff',
  imports: [LxBadge, LxPlaceholderChip],
  template: `
    @if (previous(); as prev) {
      <div class="head">
        <span class="lx-caption">Against previous target</span>
        <lx-badge tone="neutral" size="xs" outline>{{ provenance(prev) }}</lx-badge>
      </div>
      @if (unchanged()) {
        <p class="identical">The draft is word for word what was already there.</p>
      } @else {
        <p class="diff" [attr.dir]="dir()">
          @for (part of parts(); track $index) {
            @if (part.token.kind === 'chip') {
              <span lx-chip size="panel" [label]="part.token.label" [attr.data-op]="part.op"></span>
            } @else if (part.token.kind === 'text') {
              <span [attr.data-op]="part.op">{{ part.token.v }}</span>
            }
          }
        </p>
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    :host:has(.head) {
      padding: var(--lx-sp-14);
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-9);
      background: var(--lx-bg-rail);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-8);
      margin-bottom: var(--lx-sp-10);
    }
    .diff,
    .identical {
      margin: 0;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-13-5);
      line-height: var(--lx-lh-loose);
      overflow-wrap: anywhere;
    }
    .identical {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
    [data-op='removed'] {
      padding: 1px 3px;
      border-radius: var(--lx-r-3);
      background: var(--lx-danger-tint-bg-deep);
      color: var(--lx-danger-on-tint);
      text-decoration: line-through;
    }
    [data-op='added'] {
      padding: 1px 3px;
      border-radius: var(--lx-r-3);
      background: var(--lx-accent-tint-bg-deep);
      color: var(--lx-accent-on-tint);
    }
  `,
})
export class LxReviewDiff {
  /** The target locale's direction — the diff is target text, so `ar` reads right to left. */
  readonly dir = input<'rtl' | null>(null);
  readonly previous = input.required<PreviousTarget | null>();
  readonly draft = input.required<readonly SegmentDto[]>();

  protected readonly parts = computed(() =>
    diffSegments(this.previous()?.segments ?? [], this.draft()),
  );
  protected readonly unchanged = computed(() => isUnchanged(this.parts()));

  /** "Reviewed · hand-written" — what the text the draft replaced actually was. */
  protected provenance(previous: PreviousTarget): string {
    return `${STATE_LABEL[previous.state]} · hand-written`;
  }
}
