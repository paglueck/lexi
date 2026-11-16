// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component } from '@angular/core';

/**
 * The 42px toolbar.
 *
 * Deliberately NOT a shell slot: in S4 it lives inside the flexing centre
 * column, while S6's locale bar is full width. Each feature renders it where
 * its own layout puts it, and projects its controls in.
 */
@Component({
  selector: 'lx-toolbar',
  template: '<ng-content />',
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      height: var(--lx-h-toolbar);
      padding: 0 var(--lx-sp-14);
      background: var(--lx-bg-panel);
      border-bottom: 1px solid var(--lx-border-section);
      flex: none;
    }
  `,
})
export class LxToolbar {}
