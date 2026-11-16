// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';

import { LxModalService } from '../../ui/modal.js';

/**
 * The two Phrase entries of the project menu and the command palette, in one
 * place so both open the same dialogs the same way.
 *
 * The dialogs are imported on demand: the menu and the palette are in the
 * initial bundle, and Phrase is optional — most sessions never open either.
 */
@Injectable({ providedIn: 'root' })
export class PhraseActions {
  readonly #modal = inject(LxModalService);

  async push(): Promise<void> {
    const { LxPhrasePushDialog } = await import('./push-dialog.js');
    this.#modal.open(LxPhrasePushDialog);
  }

  async connect(): Promise<void> {
    const { LxPhraseConnectModal } = await import('./push-dialog.js');
    this.#modal.open(LxPhraseConnectModal);
  }
}
