// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ToastStore } from '../core/stores/toast-store.js';
import { LxButton } from './button.js';
import { LxIcon } from './icon.js';
import { GLYPH } from './glyphs.js';

/**
 * The toast stack (M14), mounted once in the shell.
 *
 * `aria-live="polite"` rather than `assertive`: a finished batch is worth
 * hearing about at the next pause, never worth interrupting a sentence
 * somebody is typing into a target. `role="status"` carries the same promise
 * to the screen readers that do not read `aria-live` off a container.
 *
 * The stack is `position: fixed` and sits above the status bar rather than
 * inside the shell's grid, because a fourth grid row would resize every screen
 * for something that is on screen for nine seconds.
 */
@Component({
  selector: 'lx-toast-host',
  imports: [LxButton, LxIcon, RouterLink],
  template: `
    <!-- The live region is always in the DOM, empty when there is nothing to
         say. Created together with its first message, most screen readers
         never announce that message: they only watch regions that already exist. -->
    <div class="stack" role="status" aria-live="polite">
      @for (toast of toasts.toasts(); track toast.id) {
        <div class="toast" [attr.data-tone]="toast.tone">
          <span class="lx-badge" [attr.data-tone]="toast.tone" aria-hidden="true">
            {{ toast.tone === 'accent' ? GLYPH.state.reviewed : GLYPH.error }}
          </span>
          <p class="text">
            <strong class="title">{{ toast.title }}</strong>
            @if (toast.detail) {
              <span class="detail">{{ toast.detail }}</span>
            }
          </p>
          @if (toast.action; as action) {
            <a
              lx-button
              variant="accent-soft"
              size="xs"
              [routerLink]="action.route"
              [queryParams]="action.queryParams ?? null"
              (click)="toasts.dismiss(toast.id)"
              >{{ action.label }}</a
            >
          }
          <button
            type="button"
            lx-button
            variant="ghost"
            size="xs"
            iconOnly
            class="close"
            title="Dismiss"
            [attr.aria-label]="'Dismiss: ' + toast.title"
            (click)="toasts.dismiss(toast.id)"
          >
            <lx-icon name="x" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .stack {
      position: fixed;
      right: var(--lx-sp-16);
      bottom: calc(var(--lx-h-statusbar) + var(--lx-sp-12));
      z-index: 40;
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-8);
      max-width: 420px;
    }
    .toast {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-10) var(--lx-sp-12);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-9);
      background: var(--lx-bg-panel);
      box-shadow: var(--lx-shadow-modal);
    }
    .toast[data-tone='accent'] {
      border-color: var(--lx-accent-tint-border);
    }
    .toast[data-tone='warn'] {
      border-color: var(--lx-warn-tint-border);
    }
    .toast[data-tone='danger'] {
      border-color: var(--lx-danger-tint-border);
    }
    .text {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-2);
      min-width: 0;
      margin: 0;
    }
    .title {
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-600);
    }
    .detail {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11-5);
    }
    a[lx-button] {
      flex: none;
      margin-left: auto;
      text-decoration: none;
    }
    .close {
      flex: none;
    }
    .stack:empty {
      display: none;
    }
  `,
})
export class LxToastHost {
  protected readonly toasts = inject(ToastStore);
  protected readonly GLYPH = GLYPH;
}
