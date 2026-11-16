// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Directive, ElementRef, afterNextRender, inject, output } from '@angular/core';
import type { OnDestroy } from '@angular/core';

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/**
 * The keyboard half of every popup menu (WAI-ARIA menu pattern): focus moves to
 * the first item when the menu opens, ↑/↓ wrap between items, Home/End jump,
 * Escape and Tab close it, and focus goes back to whatever opened it.
 *
 * Put it on the element that is rendered only while the menu is open — the
 * `@if` is what opens and closes it, so creation and destruction are the two
 * moments that matter. The element that had focus at creation is taken as the
 * trigger: menus here open from a click or a key on their button, so that is
 * always it.
 *
 * DOM queries rather than CDK's `FocusKeyManager`, because the items are plain
 * `<button>`s in four different templates and the key manager wants a
 * `QueryList` of components implementing `FocusableOption`. Handled keys stop
 * propagating: the grid page binds ↑/↓ on its host to move the row selection,
 * and a menu inside it must not also scroll the table.
 */
@Directive({
  selector: '[lxMenu]',
  host: {
    role: 'menu',
    '(keydown)': 'onKeydown($event)',
  },
})
export class LxMenu implements OnDestroy {
  /** Escape or Tab — the host sets its own `open` signal to false. */
  readonly lxMenuClose = output<void>();

  readonly #el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly #trigger =
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

  constructor() {
    afterNextRender(() => this.#items()[0]?.focus());
  }

  ngOnDestroy(): void {
    // Only hand focus back if it was still inside the menu (or dropped to the
    // body when the focused item was removed). A click elsewhere that closed the
    // menu put focus where the user wanted it.
    const active = document.activeElement;
    if (this.#trigger?.isConnected && (active === document.body || this.#el.contains(active))) {
      this.#trigger.focus();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const items = this.#items();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.lxMenuClose.emit();
        return;
      case 'Tab':
        this.lxMenuClose.emit();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (items.length > 0) items[next]?.focus();
  }

  #items(): HTMLElement[] {
    return [...this.#el.querySelectorAll<HTMLElement>(ITEM)].filter(
      (el) => !(el as HTMLButtonElement).disabled,
    );
  }
}
