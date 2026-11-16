// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';

import { LxButton } from '../../ui/button.js';
import { LxModalShell } from '../../ui/modal.js';

export interface DeleteUnitConfirmData {
  /** One id for the single-unit menu; several for a multi-cell selection. */
  readonly unitIds: readonly string[];
  /**
   * Every file the `<trans-unit>` will be removed from, relative to the project
   * root. Null for several units: the menu only has their row bodies, which do
   * not name files, and fetching every unit's detail just to list them in a
   * modal is the wrong trade.
   */
  readonly files: readonly string[] | null;
  /** The source file is one of them, so the next extraction may put the unit back. */
  readonly inSource: boolean;
}

/** How many ids the modal names before it says "and N more". */
const LISTED = 8;

/**
 * The grid's "Delete key…" — the one grid action that writes to disk at once
 * rather than into the unsaved overlay, so it is the one that asks first. Built
 * the same way `LxBulkApproveConfirm` is: `LxModalShell` plus `DialogRef`,
 * resolving a boolean.
 */
@Component({
  selector: 'lx-delete-unit-confirm',
  imports: [LxButton, LxModalShell],
  template: `
    <lx-modal-shell [title]="title" [subtitle]="subtitle">
      @if (data.files; as files) {
        <p class="body">
          The <span class="lx-mono">&lt;trans-unit&gt;</span> is removed from
          {{ files.length === 1 ? 'this file' : 'these ' + files.length + ' files' }}
          <strong>right away</strong> — this is not staged until Save, and cannot be undone from
          here:
        </p>
        <ul class="files">
          @for (file of files; track file) {
            <li class="lx-mono">{{ file }}</li>
          }
        </ul>
      } @else {
        <p class="body">
          Each <span class="lx-mono">&lt;trans-unit&gt;</span> is removed from the source file and
          every locale file it is in <strong>right away</strong> — this is not staged until Save,
          and cannot be undone from here:
        </p>
        <ul class="files">
          @for (id of listed; track id) {
            <li class="lx-mono">{{ id }}</li>
          }
          @if (more > 0) {
            <li>and {{ more }} more</li>
          }
        </ul>
      }
      @if (data.inSource) {
        <p class="body">
          If {{ several ? 'a key is' : 'the key is' }} still used in the Angular code, the next
          <span class="lx-mono">ng extract-i18n</span> puts it back into the source file.
        </p>
      }
      <p class="body">
        Any unsaved edits to {{ several ? 'these units' : 'this unit' }} are discarded with
        {{ several ? 'them' : 'it' }}.
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
        {{ confirmLabel }}
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
    .files {
      margin: 0 0 var(--lx-sp-10);
      padding-left: var(--lx-sp-16);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-body);
    }
  `,
})
export class LxDeleteUnitConfirm {
  protected readonly ref = inject<DialogRef<boolean, LxDeleteUnitConfirm>>(DialogRef);
  protected readonly data = inject<DeleteUnitConfirmData>(DIALOG_DATA);

  protected readonly several = this.data.unitIds.length > 1;
  protected readonly title = this.several
    ? `Delete ${this.data.unitIds.length} keys`
    : 'Delete key';
  protected readonly subtitle = this.several ? '' : (this.data.unitIds[0] ?? '');
  protected readonly listed = this.data.unitIds.slice(0, LISTED);
  protected readonly more = this.data.unitIds.length - this.listed.length;
  protected readonly confirmLabel =
    this.data.files === null
      ? `Delete ${this.data.unitIds.length} ${this.several ? 'keys' : 'key'}`
      : `Delete from ${this.data.files.length} ${this.data.files.length === 1 ? 'file' : 'files'}`;
}
