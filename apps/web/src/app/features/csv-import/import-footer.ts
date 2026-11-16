// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, computed, input, model, output } from '@angular/core';
import type { CsvImportApplyRequest } from '@lexi/shared';

import { LxStateBadge } from '../../ui/badge.js';
import { LxButton } from '../../ui/button.js';
import { LxSegmentedControl, type SegmentOption } from '../../ui/segmented-control.js';

type TargetState = CsvImportApplyRequest['state'];

/**
 * S16's footer bar: the state the imported units get, whether the unchanged
 * ones the reviewer confirmed become final, what Apply would write, and the
 * two ways out.
 *
 * Apply has three faces. Ready, it is the primary button. With conflicts
 * open it LOOKS disabled but still answers a click, because the click is how
 * the user is taken to the first open conflict (README "Footer"). Applied, or
 * with nothing to write, it is really disabled. The page decides what a click
 * means; this component only draws which face is showing.
 */
@Component({
  selector: 'lx-import-footer',
  imports: [LxButton, LxSegmentedControl, LxStateBadge],
  template: `
    <div class="state">
      <span id="import-state-label" class="state__label">Imported units get</span>
      <lx-segmented-control
        class="state__switch lx-mono"
        ariaLabelledby="import-state-label"
        [options]="stateOptions()"
        [(value)]="state"
      />
    </div>
    @if (finalizable() > 0) {
      <button
        type="button"
        role="checkbox"
        class="finalize"
        [attr.aria-checked]="finalizeUnchanged()"
        [attr.data-on]="finalizeUnchanged()"
        [disabled]="applied()"
        (click)="finalizeUnchanged.set(!finalizeUnchanged())"
      >
        <span class="box" aria-hidden="true">{{ finalizeUnchanged() ? '✓' : '' }}</span>
        Mark {{ finalizable() }} unchanged as
        <lx-state-badge state="final" size="xs" />
      </button>
    }
    <span class="summary">{{ summary() }}</span>
    <button type="button" lx-button class="cancel lx-spacer" (click)="leave.emit()">Cancel</button>
    <button
      type="button"
      lx-button
      class="apply"
      [variant]="ready() ? 'primary' : 'secondary'"
      [class.apply--idle]="!ready()"
      [disabled]="applied() || busy() || blocked() !== '' || (!ready() && !resolving())"
      [attr.title]="blocked() || null"
      (click)="apply.emit()"
    >
      {{ label() }}
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-16);
      padding: var(--lx-sp-12) var(--lx-sp-20);
      border-top: 1px solid var(--lx-border-section);
      background: var(--lx-bg-panel);
    }
    .state {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
    }
    .state__label {
      font-size: var(--lx-fs-12);
      color: var(--lx-text-subtle);
    }
    .state__switch {
      background: var(--lx-bg-track);
    }
    .finalize {
      display: inline-flex;
      align-items: center;
      gap: var(--lx-sp-6);
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      font-size: var(--lx-fs-12);
      color: var(--lx-text-subtle);
      cursor: pointer;
    }
    .finalize:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .box {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 15px;
      height: 15px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-4);
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
      color: var(--lx-accent-on);
    }
    .finalize[data-on='true'] .box {
      border-color: var(--lx-accent);
      background: var(--lx-accent);
    }
    .summary {
      font-size: var(--lx-fs-12-5);
      color: var(--lx-text-mono);
    }
    /* The design's footer buttons: sm geometry with a 14px/16px inset. */
    button.cancel {
      --b-px: var(--lx-sp-14);
      --b-fw: var(--lx-fw-400);
    }
    button.apply {
      --b-px: var(--lx-sp-16);
      --b-fw: var(--lx-fw-600);
    }
    /* Looks disabled, still clickable: see the class comment. */
    button.apply--idle {
      --b-bg: var(--lx-bg-raised);
      --b-bd: transparent;
      --b-fg: var(--lx-text-faint);
    }
    button.apply--idle:disabled {
      opacity: 1;
    }
  `,
})
export class LxImportFooter {
  readonly state = model.required<TargetState>();
  /** Mark the unchanged cells the reviewer confirmed as final too. */
  readonly finalizeUnchanged = model(true);
  /** How many cells that would mark; the box is only offered when there are some. */
  readonly finalizable = input(0);
  readonly summary = input.required<string>();
  /** The Apply label and whether there is something to write (`applyLabel`). */
  readonly label = input.required<string>();
  readonly ready = input(false, { transform: booleanAttribute });
  /** Conflicts are open: Apply is not on offer, but a click shows the first one. */
  readonly resolving = input(false, { transform: booleanAttribute });
  readonly applied = input(false, { transform: booleanAttribute });
  /** A request is in flight; a second click must not send a second import. */
  readonly busy = input(false, { transform: booleanAttribute });
  /** Why Apply is held back right now, shown as its title; empty when it is not. */
  readonly blocked = input('');

  readonly leave = output<void>();
  readonly apply = output<void>();

  /** The state is part of what was applied, so it is fixed once Apply has run. */
  protected readonly stateOptions = computed<readonly SegmentOption<TargetState>[]>(() =>
    (['needsReview', 'reviewed', 'final'] as const).map((value) => ({
      value,
      label: value,
      disabled: this.applied(),
    })),
  );
}
