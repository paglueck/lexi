// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, input } from '@angular/core';

import { LxPlaceholderChip } from '../../ui/placeholder-chip.js';
import type { DiffPart } from '../review/diff-segments.js';

export type ImportDiffView = 'inline' | 'split-old' | 'split-new';

/**
 * One side of the CSV re-import diff (S16): the inline view, or either column
 * of the split view.
 *
 * PURELY PRESENTATIONAL. The parent diffs once (`diffSegments` with `groups`
 * and `tidy`) and hands the same parts to as many of these as it shows, so the
 * two split columns can never disagree about what changed. "In Lexi" is the
 * same parts minus the additions, "In CSV" the same parts minus the removals.
 *
 * Text spans are `pre-wrap` so the single spaces the tidy pass bridges survive
 * rendering. Group boundaries draw as chips too: they are atomic in the diff
 * and must look it.
 */
@Component({
  selector: 'lx-import-diff',
  imports: [LxPlaceholderChip],
  template: `
    @for (part of visible(); track $index) {
      @switch (part.token.kind) {
        @case ('text') {
          <span [class]="part.op === 'removed' ? 'del' : part.op === 'added' ? 'ins' : 'same'">{{
            part.token.v
          }}</span>
        }
        @case ('chip') {
          <span
            lx-chip
            size="panel"
            [label]="part.token.label"
            [class.removed]="part.op === 'removed'"
            [class.added]="part.op === 'added'"
          ></span>
        }
        @default {
          <span
            lx-chip
            size="panel"
            [label]="boundary(part.token)"
            [class.removed]="part.op === 'removed'"
            [class.added]="part.op === 'added'"
          ></span>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-13);
      line-height: var(--lx-lh-loose);
      overflow-wrap: anywhere;
    }
    span:not([lx-chip]) {
      white-space: pre-wrap;
    }
    .del,
    .ins {
      padding: 1px 2px;
      border-radius: var(--lx-r-3);
    }
    .del {
      background: var(--lx-diff-del-bg);
      color: var(--lx-diff-del-fg);
      text-decoration: line-through;
    }
    .ins {
      background: var(--lx-diff-ins-bg);
      color: var(--lx-diff-ins-fg);
    }
    .lx-chip.removed {
      border-color: var(--lx-chip-removed-border);
    }
    .lx-chip.added {
      border-color: var(--lx-chip-added-border);
    }
  `,
})
export class LxImportDiff {
  readonly parts = input.required<readonly DiffPart[]>();
  readonly view = input<ImportDiffView>('inline');

  protected readonly visible = computed(() => {
    const view = this.view();
    return this.parts().filter(
      (p) =>
        view === 'inline' ||
        p.op === 'same' ||
        p.op === (view === 'split-old' ? 'removed' : 'added'),
    );
  });

  protected boundary(token: DiffPart['token']): string {
    return token.kind === 'open' ? `<${token.id}>` : token.kind === 'close' ? `</${token.id}>` : '';
  }
}
