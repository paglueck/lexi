// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';

import { LxButton } from '../../ui/button.js';
import { LxModalShell } from '../../ui/modal.js';

export interface BulkApproveConfirmData {
  readonly count: number;
  readonly locale: string;
}

/**
 * FR-7.3's "behind a confirmation" — the one place Focus mode's bulk approve
 * asks before it acts. Built the same way `LxPromptPreview` is: `LxModalShell`
 * plus `DialogRef`, resolving a boolean.
 */
@Component({
  selector: 'lx-bulk-approve-confirm',
  imports: [LxButton, LxModalShell],
  template: `
    <lx-modal-shell title="Approve {{ data.count }} units" [subtitle]="data.locale">
      <p class="body">
        Every unit currently in the review queue for <span class="lx-mono">{{ data.locale }}</span>
        will be approved with its own current text, unchanged. This cannot be undone from here —
        review is still recorded per unit, but a bulk approval is one action.
      </p>
      <p class="body">Nothing is saved to disk yet; this only moves them to Reviewed.</p>

      <button type="button" modal-footer lx-button size="field" (click)="ref.close(false)">
        Cancel
      </button>
      <button
        type="button"
        modal-footer
        lx-button
        variant="primary"
        size="field"
        (click)="ref.close(true)"
      >
        Approve {{ data.count }}
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
export class LxBulkApproveConfirm {
  protected readonly ref = inject<DialogRef<boolean, LxBulkApproveConfirm>>(DialogRef);
  protected readonly data = inject<BulkApproveConfirmData>(DIALOG_DATA);
}
