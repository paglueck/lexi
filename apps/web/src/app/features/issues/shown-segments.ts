// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input } from '@angular/core';
import type { IssueFinding, SegmentDto } from '@lexi/shared';

import { LxPlaceholderChip, type ChipSize, type ChipTone } from '../../ui/index.js';

/**
 * A run of text or one chip, with the tone S12 draws it in.
 *
 * The Issues screen shows the same segments four ways (the table excerpt, the
 * target, the fix preview and the source), each marking different chips. So
 * the marking is worked out once, in pure functions the spec can call, and
 * `lx-issue-text` only draws the result.
 */
export interface ShownSegment {
  readonly k: 't' | 'p';
  /** The text, or the chip's label. */
  readonly v: string;
  readonly tone: ChipTone | null;
}

export interface ShowOptions {
  /** Placeholder ids the finding is about. */
  readonly danger?: ReadonlySet<string>;
  /** Top-level indices to draw in `changedTone`: what a fix put in. */
  readonly changed?: ReadonlySet<number>;
  readonly changedTone?: ChipTone;
}

const labelOf = (s: { id: string; equivText?: string | undefined }): string => s.equivText || s.id;

export function shown(segments: readonly SegmentDto[], options: ShowOptions = {}): ShownSegment[] {
  const out: ShownSegment[] = [];
  const walk = (list: readonly SegmentDto[], top: boolean): void => {
    list.forEach((s, i) => {
      if (s.k === 't') {
        out.push({ k: 't', v: s.v, tone: null });
      } else if (s.k === 'p') {
        const changed = top && options.changed?.has(i) === true;
        const tone: ChipTone | null = changed
          ? (options.changedTone ?? 'accepted')
          : options.danger?.has(s.id) === true
            ? 'danger'
            : null;
        out.push({ k: 'p', v: tone === 'absent' ? `${s.id} ?` : labelOf(s), tone });
      } else {
        walk(s.children, false);
      }
    });
  };
  walk(segments, true);
  return out;
}

/**
 * The target as the detail panel draws it: the chips the finding is about in
 * red, and a placeholder the target lacks as a dashed "ID ?" chip.
 *
 * Where a fix knows the position (an insert at the edge), the dashed chip sits
 * there. Otherwise it goes at the end, which is honest about not knowing.
 */
export function targetWithAbsent(
  target: readonly SegmentDto[],
  finding: IssueFinding,
): ShownSegment[] {
  const danger = new Set(finding.placeholders?.unexpected ?? []);
  const fix = finding.fix;
  if (fix?.kind === 'insert-edge') {
    return shown(fix.segments, { danger, changed: new Set(fix.changed), changedTone: 'absent' });
  }
  const out = shown(target, { danger });
  if (fix?.kind !== 'rename') {
    for (const id of finding.placeholders?.missing ?? [])
      out.push({ k: 'p', v: `${id} ?`, tone: 'absent' });
  }
  return out;
}

/** Draws `ShownSegment`s: text as text, chips as `lx-chip`. */
@Component({
  selector: 'lx-issue-text',
  imports: [LxPlaceholderChip],
  template: `
    @for (s of segments(); track $index) {
      @if (s.k === 'p') {
        <span lx-chip [size]="size()" [tone]="s.tone" [label]="s.v"></span>
      } @else {
        {{ s.v }}
      }
    } @empty {
      <span class="empty">{{ empty() }}</span>
    }
  `,
  styles: `
    .empty {
      color: var(--lx-text-faint);
    }
  `,
})
export class LxIssueText {
  readonly segments = input.required<readonly ShownSegment[]>();
  readonly size = input<ChipSize>('panel');
  readonly empty = input('Empty.');
}
