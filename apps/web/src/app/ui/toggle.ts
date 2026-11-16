// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, input, model } from '@angular/core';

/** The three settings switches in S7 (masking, state writing, few-shot). */
@Component({
  selector: 'lx-toggle',
  host: {
    role: 'switch',
    '[attr.aria-checked]': 'checked()',
    '[attr.aria-disabled]': 'disabled() ? "true" : null',
    '[attr.tabindex]': 'disabled() ? null : 0',
    '(click)': 'flip()',
    '(keydown.space)': 'flip(); $event.preventDefault()',
    '(keydown.enter)': 'flip()',
  },
  template: `<span class="track" [class.track--on]="checked()"><span class="knob"></span></span>`,
  styles: `
    :host {
      display: inline-flex;
      cursor: pointer;
    }
    :host([aria-disabled='true']) {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .track {
      display: flex;
      align-items: center;
      width: 30px;
      height: 17px;
      padding: 2px;
      box-sizing: border-box;
      border-radius: 9px;
      background: var(--lx-border-strong);
    }
    .track--on {
      justify-content: flex-end;
      background: var(--lx-accent);
    }
    .knob {
      width: 13px;
      height: 13px;
      border-radius: var(--lx-r-full);
      background: var(--lx-text-faint);
    }
    .track--on .knob {
      background: var(--lx-accent-on);
    }
  `,
})
export class LxToggle {
  readonly checked = model(false);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected flip(): void {
    if (!this.disabled()) this.checked.update((v) => !v);
  }
}
