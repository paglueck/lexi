// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, input } from '@angular/core';

import type { ImportChip } from './import-model.js';

const LABEL: Record<ImportChip, string> = {
  changed: 'changed',
  warning: 'warning',
  excluded: 'excluded',
  decide: 'decide',
  useCsv: 'use CSV',
  keepCurrent: 'keep current',
  blocked: 'blocked',
  skipped: 'skipped',
  applied: 'applied',
};

/**
 * S16's status chip, for a row in the list and for the detail header. One
 * colour table (README "Status chips") keyed on `[attr.data-chip]`, the same
 * recipe as S14's job status chip.
 */
@Component({
  selector: 'lx-import-status-chip',
  host: { class: 'lx-mono', '[attr.data-chip]': 'chip()' },
  template: `{{ label() }}`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      border-radius: var(--lx-r-3);
      border: 1px solid var(--lx-neutral-tint-border);
      background: transparent;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-9-5);
      line-height: 1.4;
      white-space: nowrap;
    }

    :host([data-chip='changed']) {
      color: var(--lx-accent-on-tint);
      border-color: var(--lx-accent-tint-border);
    }

    :host([data-chip='warning']),
    :host([data-chip='decide']) {
      color: var(--lx-warn);
      border-color: var(--lx-warn-tint-border);
      background: var(--lx-warn-tint-bg);
    }

    :host([data-chip='excluded']) {
      color: var(--lx-text-faint);
    }

    :host([data-chip='useCsv']),
    :host([data-chip='applied']) {
      color: var(--lx-accent);
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
    }

    :host([data-chip='blocked']) {
      color: var(--lx-danger);
      border-color: var(--lx-danger-tint-border);
      background: var(--lx-danger-tint-bg);
    }
  `,
})
export class LxImportStatusChip {
  readonly chip = input.required<ImportChip>();
  protected readonly label = computed(() => LABEL[this.chip()]);
}
