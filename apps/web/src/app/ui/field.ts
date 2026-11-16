// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, Directive, booleanAttribute, input, model } from '@angular/core';

/**
 * Inputs and textareas. The visual recipe lives in base/globals.css as
 * `.lx-input`, so a raw <input class="lx-input"> renders identically.
 */
@Directive({
  selector: 'input[lxInput], textarea[lxInput]',
  host: { class: 'lx-input', '[attr.data-size]': 'size()' },
})
export class LxInput {
  readonly size = input<'md' | 'sm'>('md');
}

/** Label above, control projected, optional hint below. */
@Component({
  selector: 'lx-field',
  template: `
    <!-- eslint-disable-next-line @angular-eslint/template/label-has-associated-control --
         the control is projected into this label, so the association is implicit
         and correct, but not statically visible to the rule -->
    <label class="field">
      <span class="label">
        {{ label() }}
        @if (optional()) {
          <span class="optional">optional</span>
        }
      </span>
      <ng-content />
    </label>
    @if (hint()) {
      <span class="hint">{{ hint() }}</span>
    }
  `,
  styles: `
    :host,
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
    }
    .label {
      display: flex;
      gap: var(--lx-sp-6);
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-muted);
    }
    .optional {
      color: var(--lx-text-faint-2);
    }
    .hint {
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint-2);
    }
  `,
})
export class LxField {
  readonly label = input.required<string>();
  readonly hint = input<string>('');
  readonly optional = input(false, { transform: booleanAttribute });
}

/** The grid rail's search box (FR-3.5), with its right-aligned shortcut hint. */
@Component({
  selector: 'lx-search-field',
  template: `
    <span class="icon" aria-hidden="true"></span>
    <input
      class="input"
      type="search"
      [attr.placeholder]="placeholder()"
      [value]="value()"
      (input)="value.set($any($event.target).value)"
      [attr.aria-label]="placeholder()"
    />
    <kbd class="shortcut lx-mono">{{ shortcut() }}</kbd>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
      height: 30px;
      padding: 0 var(--lx-sp-10);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-field);
    }
    /* A CSS shape, not an SVG: the handoff ships no artwork at all. */
    .icon {
      width: 11px;
      height: 11px;
      flex: none;
      border: 1.5px solid var(--lx-text-faint);
      border-radius: var(--lx-r-full);
    }
    .input {
      flex: 1;
      min-width: 0;
      border: none;
      background: none;
      outline: none;
      font-size: var(--lx-fs-12-5);
      color: var(--lx-text-secondary);
    }
    .input::placeholder {
      color: var(--lx-text-faint);
    }
    .shortcut {
      font-size: var(--lx-fs-10);
      color: var(--lx-text-faint-3);
    }
  `,
})
export class LxSearchField {
  readonly value = model<string>('');
  readonly placeholder = input('Search keys, text, notes');
  readonly shortcut = input('⌘F');
}
