// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';

import { LxButton } from './button.js';
import { LxModalShell } from './modal.js';

export interface DiscardAllConfirmData {
  /** Unsaved changes, target and note edits together. Never zero — at zero nothing is asked. */
  readonly unsavedCount: number;
}

/**
 * "Discard all unsaved changes". Asked even though ⌘Z can bring it all back,
 * because it is the one action that empties the whole buffer at a stroke, and
 * the undo only lasts until the next save or reload. Built like
 * `LxDeleteUnitConfirm`: `LxModalShell` plus `DialogRef`, resolving a boolean.
 */
@Component({
  selector: 'lx-discard-all-confirm',
  imports: [LxButton, LxModalShell],
  template: `
    <lx-modal-shell title="Discard all unsaved changes">
      <p class="body">
        {{ data.unsavedCount }} unsaved {{ data.unsavedCount === 1 ? 'change goes' : 'changes go' }}
        back to what is in the files. Nothing on disk is touched.
      </p>
      <p class="body">
        You can bring {{ data.unsavedCount === 1 ? 'it' : 'them' }} back with ⌘Z until you save.
      </p>

      <button type="button" modal-footer lx-button size="field" (click)="ref.close(false)">
        Cancel
      </button>
      <button
        type="button"
        modal-footer
        lx-button
        variant="danger-soft"
        size="field"
        (click)="ref.close(true)"
      >
        Discard {{ data.unsavedCount }}
      </button>
    </lx-modal-shell>
  `,
  styles: `
    .body {
      margin: 0 0 var(--lx-sp-10);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
    }
  `,
})
export class LxDiscardAllConfirm {
  protected readonly ref = inject<DialogRef<boolean, LxDiscardAllConfirm>>(DialogRef);
  protected readonly data = inject<DiscardAllConfirmData>(DIALOG_DATA);
}
