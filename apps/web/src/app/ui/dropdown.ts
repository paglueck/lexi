// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input } from '@angular/core';

import { LxIcon } from './icon.js';

/**
 * The closed visual only. The overlay menu arrives with the first screen that
 * needs one (M5's locale-column chooser) — building it now would be guesswork
 * about a menu nobody has specified.
 */
@Component({
  selector: 'button[lx-dropdown]',
  imports: [LxIcon],
  host: { '[attr.data-size]': 'size()', type: 'button' },
  template: `<ng-content /><lx-icon class="caret" name="chevron-down" [size]="12" />`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--lx-sp-8);
      height: 30px;
      padding: 0 var(--lx-sp-10);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-field);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12);
    }
    :host([data-size='xs']) {
      height: 26px;
      border-radius: var(--lx-r-6);
      font-size: var(--lx-fs-11-5);
    }
    .caret {
      color: var(--lx-text-faint-2);
    }
  `,
})
export class LxDropdown {
  readonly size = input<'field' | 'xs'>('field');
}
