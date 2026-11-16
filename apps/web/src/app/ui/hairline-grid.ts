// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Directive, input } from '@angular/core';

/**
 * The dashboard stat strip and the terminology table.
 *
 * A 1px grid gap over a border-coloured background reads as hairlines, with no
 * per-cell borders to get wrong at the edges. CSS lives in base/globals.css as
 * `.lx-hairline-grid`, so raw markup can use the same recipe.
 */
@Directive({
  selector: '[lxHairlineGrid]',
  host: {
    class: 'lx-hairline-grid',
    '[style.grid-template-columns]': 'lxHairlineGrid()',
  },
})
export class LxHairlineGrid {
  /** Any grid-template-columns value, e.g. "repeat(5, 1fr)". */
  readonly lxHairlineGrid = input.required<string>();
}
