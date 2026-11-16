// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, input } from '@angular/core';

export type ButtonVariant =
  'primary' | 'secondary' | 'neutral' | 'accent-soft' | 'warn-soft' | 'danger-soft' | 'ghost';
export type ButtonSize = 'hero' | 'md' | 'sm' | 'field' | 'xs';

/**
 * Six variants x five sizes, as 6 + 5 CSS rules rather than 30.
 *
 * The two axes are orthogonal: `data-variant` sets colour only, `data-size`
 * sets geometry only. The single place the mock breaks that orthogonality
 * (hero secondary is weight 500 where hero primary is 600) is one written-down
 * override at the bottom of the stylesheet, not a matrix.
 *
 * M13 added a seventh variant and a third, independent attribute. `ghost` is a
 * borderless, transparent button for the quiet actions that sit inside rows and
 * headers (delete a term, dismiss a toast) — the handoff draws those as a bare
 * `×`, and a bordered button in every glossary row would shout. `iconOnly`
 * makes the button square at its size's height, for a lone `<lx-icon>`; such a
 * button has no visible text, so it must carry an `aria-label`
 * (`icon-buttons.spec.ts` fails the build on one that does not).
 */
@Component({
  selector: 'button[lx-button], a[lx-button]',
  host: {
    class: 'lx-button',
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size()',
    '[attr.data-icon-only]': 'iconOnly() || null',
  },
  template: `<ng-content />`,
  styleUrl: './button.css',
})
export class LxButton {
  readonly variant = input<ButtonVariant>('secondary');
  readonly size = input<ButtonSize>('sm');
  readonly iconOnly = input(false, { transform: booleanAttribute });
}
