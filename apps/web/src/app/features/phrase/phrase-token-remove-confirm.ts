// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';

import { LxButton } from '../../ui/button.js';
import { LxModalShell } from '../../ui/modal.js';

export interface PhraseTokenRemoveData {
  readonly note: string;
}

/** S19's "Remove token" question. Resolves true to remove. */
@Component({
  selector: 'lx-phrase-token-remove-confirm',
  imports: [LxButton, LxModalShell],
  template: `
    <lx-modal-shell title="Remove this token?" [subtitle]="data.note" size="sm">
      <p class="body">
        Lexi forgets the token on this machine. It stays valid in Phrase until you revoke it there.
        Projects checked out with it keep working; pushing from them uses another saved token.
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
        class="confirm"
        (click)="ref.close(true)"
      >
        Remove token
      </button>
    </lx-modal-shell>
  `,
  styles: `
    .body {
      margin: 0;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
    }
    .confirm {
      margin-left: auto;
    }
  `,
})
export class LxPhraseTokenRemoveConfirm {
  readonly ref = inject<DialogRef<boolean, LxPhraseTokenRemoveConfirm>>(DialogRef);
  protected readonly data = inject<PhraseTokenRemoveData>(DIALOG_DATA);
}
