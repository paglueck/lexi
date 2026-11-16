// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, computed, input } from '@angular/core';
import type { UnitState } from '@lexi/shared';

import { GLYPH, STATE_LABEL } from './glyphs.js';

export type BadgeTone = 'neutral' | 'accent' | 'warn' | 'danger';
export type BadgeSize = 'xs' | 'sm' | 'md';

/**
 * A translation state, as badge + colour + accessible label.
 *
 * FR-3.7 ("never colour alone") is satisfied STRUCTURALLY here rather than by
 * discipline: the glyph is aria-hidden and the full state name always rides
 * along in an sr-only span. There is no way to render a state badge without it.
 *
 * All colour comes from the local ramp that [data-state] / [data-error] set in
 * tokens/ramps.css — the component binds attributes and nothing else.
 */
@Component({
  selector: 'lx-state-badge',
  host: {
    class: 'lx-badge',
    '[attr.data-state]': 'state()',
    '[attr.data-error]': 'error() ? "true" : null',
    '[attr.data-size]': 'size()',
  },
  template: `<span aria-hidden="true">{{ glyph() }}</span
    ><span class="sr-only">{{ label() }}</span>`,
})
export class LxStateBadge {
  readonly state = input.required<UnitState>();
  readonly error = input(false, { transform: booleanAttribute });
  readonly size = input<BadgeSize>('sm');

  protected readonly glyph = computed(() =>
    this.error() ? GLYPH.error : GLYPH.state[this.state()],
  );
  protected readonly label = computed(
    () => STATE_LABEL[this.state()] + (this.error() ? ', validation error' : ''),
  );
}

/**
 * The same visual recipe for everything that is not a translation state:
 * `hash id`, `custom id`, `ICU`, `RTL`, `queued` / `running` / `done`, the
 * glossary do-not-translate mark.
 *
 * Shares `.lx-badge` and the --r-* contract with LxStateBadge, so the two can
 * never drift apart.
 */
@Component({
  selector: 'lx-badge',
  host: {
    class: 'lx-badge',
    '[attr.data-tone]': 'tone()',
    '[attr.data-size]': 'size()',
    '[attr.data-fill]': 'outline() ? "outline" : null',
  },
  template: `<ng-content />`,
})
export class LxBadge {
  readonly tone = input<BadgeTone>('neutral');
  readonly size = input<BadgeSize>('sm');
  readonly outline = input(false, { transform: booleanAttribute });
}
