// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, Injectable, inject, input } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { Dialog, DialogRef, type CdkDialogContainer, type DialogConfig } from '@angular/cdk/dialog';

import { LxButton } from './button.js';
import { LxIcon } from './icon.js';

let nextTitleId = 0;
import type { ComponentType } from '@angular/cdk/portal';

/**
 * The 900px modal shell (S5's composed-prompt preview is the first consumer).
 *
 * Opened through CDK's `Dialog`, which brings the focus trap, Escape handling,
 * aria-modal and focus restoration — all of which are tedious and easy to get
 * subtly wrong by hand. The backdrop is styled by the global `.lx-scrim` class,
 * because CDK renders it outside every component view.
 *
 * Content goes in three slots: `[modal-header]`, the default body, and
 * `[modal-footer]`.
 *
 * M13: the dialog is named by its own title — the shell registers the `<h2>`'s
 * id with the CDK container, the same hook Material's `mat-dialog-title` uses,
 * so every modal is announced as "Composed prompt, dialog" rather than
 * "dialog" with no feature having to pass `ariaLabelledBy`. And the header has
 * a close button: Escape was the only way out, which nobody can see.
 */
@Component({
  selector: 'lx-modal-shell',
  imports: [LxButton, LxIcon],
  host: {
    '[attr.data-size]': 'size()',
    // `title="…"` is this component's input, but Angular also leaves a static
    // attribute on the element, which the browser shows as a tooltip over the
    // whole dialog. The heading already says it; the attribute goes.
    '[attr.title]': 'null',
  },
  template: `
    <header class="head">
      <div class="titles">
        <h2 class="title" [id]="titleId">{{ title() }}</h2>
        @if (subtitle()) {
          <p class="subtitle lx-mono">{{ subtitle() }}</p>
        }
      </div>
      <ng-content select="[modal-header]" />
    </header>
    <div class="body">
      <ng-content />
    </div>
    <footer class="foot">
      <ng-content select="[modal-footer]" />
    </footer>
    <!-- LAST in the DOM, drawn in the header's corner: CDK focuses the first
         tabbable element on open, and that has to stay the dialog's own first
         field (Add term's Term input), not the way out. -->
    @if (dialogRef && closable()) {
      <button
        type="button"
        lx-button
        variant="ghost"
        size="xs"
        iconOnly
        class="close"
        aria-label="Close"
        title="Close (Esc)"
        (click)="dialogRef.close()"
      >
        <lx-icon name="x" [size]="15" />
      </button>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      width: var(--lx-w-modal);
      max-width: 100%;
      /* A percentage would resolve against the CDK pane, which has no height of
         its own — so the cap is the viewport, minus a margin around the dialog. */
      max-height: calc(100dvh - 2 * var(--lx-sp-32));
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-12);
      background: var(--lx-bg-modal);
      box-shadow: var(--lx-shadow-modal);
      overflow: hidden;
    }
    :host([data-size='sm']) {
      width: var(--lx-w-modal-sm);
    }
    .close {
      position: absolute;
      top: var(--lx-sp-12);
      right: var(--lx-sp-12);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-16);
      /* Room on the right for the close button, which sits over this corner. */
      padding: var(--lx-sp-16) calc(var(--lx-sp-20) + 26px) var(--lx-sp-16) var(--lx-sp-20);
      border-bottom: 1px solid var(--lx-border-table);
    }
    .titles {
      flex: 1;
      min-width: 0;
    }
    .title {
      font-size: var(--lx-fs-15);
      font-weight: var(--lx-fw-600);
    }
    .subtitle {
      margin-top: var(--lx-sp-2);
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint);
    }
    /* S15's header type: a sentence of a subtitle, not a caption. */
    :host([data-size='sm']) .title {
      font-size: 16px;
    }
    :host([data-size='sm']) .subtitle {
      font-family: var(--lx-font-ui);
      font-size: var(--lx-fs-12-5);
      color: var(--lx-text-subtle);
    }
    .body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: var(--lx-sp-18) var(--lx-sp-20);
    }
    .foot {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-14) var(--lx-sp-20);
      border-top: 1px solid var(--lx-border-table);
      background: var(--lx-bg-modal-footer);
    }
    /* A dialog with nothing to answer yet (an update check) has no footer. */
    .foot:empty {
      display: none;
    }
  `,
})
export class LxModalShell implements OnDestroy {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
  /** `sm` is S15's 640px dialog; everything else is the 900px default. */
  readonly size = input<'md' | 'sm'>('md');
  /**
   * False hides the close button, for a dialog that must not be left halfway
   * (an update downloading). Escape and the backdrop are the opener's
   * business: it passes `disableClose`.
   */
  readonly closable = input(true);

  protected readonly titleId = `lx-modal-title-${nextTitleId++}`;
  /** Absent when the shell is rendered outside a dialog, as the kitchen sink does. */
  protected readonly dialogRef = inject(DialogRef, { optional: true });
  // The content component's injector is not a child of the container's, so the
  // container is reached through the ref rather than injected.
  readonly #container = this.dialogRef?.containerInstance as CdkDialogContainer | undefined;

  constructor() {
    this.#container?._addAriaLabelledBy(this.titleId);
  }

  ngOnDestroy(): void {
    this.#container?._removeAriaLabelledBy(this.titleId);
  }
}

/**
 * Opens modals with the settings every Lexi modal should have, so no feature
 * has to remember them: our scrim class, `aria-modal`, and Escape-to-close.
 *
 * CDK's own default leaves aria-modal unset, which tells a screen reader the
 * content behind the dialog is still reachable when it is not.
 *
 * A service rather than a free function because `inject()` only works inside an
 * injection context, and modals are opened from click handlers.
 */
@Injectable({ providedIn: 'root' })
export class LxModalService {
  readonly #dialog = inject(Dialog);

  open<T, R = unknown>(
    component: ComponentType<T>,
    config: Omit<DialogConfig<unknown, DialogRef<R, T>>, 'backdropClass' | 'ariaModal'> = {},
  ): DialogRef<R, T> {
    return this.#dialog.open<R, unknown, T>(component, {
      ...config,
      backdropClass: 'lx-scrim',
      hasBackdrop: true,
      ariaModal: true,
    });
  }
}
