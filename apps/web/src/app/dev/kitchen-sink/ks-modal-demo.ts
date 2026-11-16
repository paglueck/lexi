// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';

import { LxButton, LxModalShell, LxSegmentedControl } from '../../ui/index.js';

/** Stands in for S5's composed-prompt preview, so the shell has real content. */
@Component({
  selector: 'lx-ks-modal-demo',
  imports: [LxButton, LxModalShell, LxSegmentedControl],
  template: `
    <lx-modal-shell title="Composed prompt" subtitle="unit 8f2c1a09b3e7 · en-GB → de">
      <lx-segmented-control
        modal-header
        [options]="tabs"
        [value]="'system'"
        (valueChange)="noop()"
      />
      <p class="lx-caption">Role &amp; output contract</p>
      <p class="body lx-mono">
        You are a professional software localization specialist translating user interface strings
        from English (en-GB) to German (de). Return only a single JSON object…
      </p>
      <button
        type="button"
        modal-footer
        lx-button
        variant="secondary"
        size="field"
        (click)="ref.close()"
      >
        Close
      </button>
      <span class="lx-spacer"></span>
      <button type="button" modal-footer lx-button variant="primary" size="field">
        Run for this unit
      </button>
    </lx-modal-shell>
  `,
  styles: `
    .body {
      margin-top: var(--lx-sp-8);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-mono);
      color: var(--lx-text-mono);
    }
  `,
})
export class KsModalDemo {
  protected readonly ref = inject<DialogRef<void>>(DialogRef);
  protected readonly tabs = [
    { value: 'system', label: 'System' },
    { value: 'user', label: 'User' },
    { value: 'schema', label: 'Schema' },
  ];
  protected noop(): void {
    /* the demo modal does not switch tabs */
  }
}
