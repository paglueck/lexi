// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';

import { ChromeStore } from '../../core/stores/chrome-store.js';

/**
 * The 32px status bar, full-bleed as a shell row (deviation 1).
 *
 * In the mock it sits inside the centre column, so the rails run to the window
 * bottom. Full-bleed is simpler and the content is app-global — but it is a
 * visible difference from S4/S9 and goes on the designer-review list.
 */
@Component({
  selector: 'lx-status-bar',
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.css',
})
export class LxStatusBar {
  protected readonly chrome = inject(ChromeStore);
}
