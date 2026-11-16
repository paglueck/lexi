// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  booleanAttribute,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';

/**
 * An editable combobox: pick from a list, or type anything.
 *
 * S2's locale cell is the first consumer, and the "or type anything" half is
 * the requirement, not a nicety — FR-1.3 exists so a user can override a
 * detection Lexi got wrong, which means the value cannot be restricted to the
 * options we happened to suggest.
 *
 * A native `<datalist>` would be two lines and is the wrong answer: its popup
 * cannot be styled at all, and the design is specific about this cell. A `<select>`
 * is worse — it cannot take free text.
 *
 * Absolutely positioned rather than CDK-overlaid, because the list is small and
 * sits inside a scrolling table cell: an overlay would need scroll-repositioning
 * to stay attached, which is more machinery than a 200px menu deserves. M5's
 * locale-column chooser is the one that will want a real overlay.
 *
 * The one thing absolute positioning does cost us is the bottom edge: the
 * wizard's mapping table is a scrollport, so a menu opening downward from the
 * last row would be clipped into nothing. `#measureDrop` answers that by
 * flipping the menu above the input when the nearest clipping ancestor leaves
 * no room below — the cheap half of what an overlay would do.
 */
/** Instance counter, for the listbox ids `aria-controls` has to point at. */
let instances = 0;

/** Mirrors `.menu`'s `max-height` and `top` offset in combobox.css. */
const MENU_MAX_HEIGHT = 200;
const MENU_GAP = 2;

@Component({
  selector: 'lx-combobox',
  template: `
    <input
      #field
      class="lx-input"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      data-size="sm"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      [attr.aria-controls]="listId"
      [attr.aria-activedescendant]="open() ? listId + '-' + highlighted() : null"
      aria-autocomplete="list"
      [value]="value()"
      [attr.data-invalid]="invalid() ? 'true' : null"
      (input)="onInput($event)"
      (focus)="onFocus()"
      (blur)="onBlur()"
      (keydown)="onKeydown($event)"
    />

    @if (open() && matches().length > 0) {
      <ul class="menu" role="listbox" [class.menu--up]="dropUp()" [id]="listId">
        @for (option of matches(); track option; let i = $index) {
          <li
            class="option"
            role="option"
            [id]="listId + '-' + i"
            [attr.aria-selected]="i === highlighted()"
            [class.option--on]="i === highlighted()"
            (mousedown)="choose($event, option)"
          >
            {{ option }}
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './combobox.css',
})
export class LxCombobox {
  readonly options = input.required<readonly string[]>();
  readonly label = input<string>('');
  /** Drawn in the danger ramp — the value is free text, so it can be wrong. */
  readonly invalid = input(false, { transform: booleanAttribute });
  readonly value = model<string>('');

  protected readonly open = signal(false);
  protected readonly highlighted = signal(0);
  /** Set when the menu would be clipped below; see `#openMenu`. */
  protected readonly dropUp = signal(false);
  /**
   * Whether the user has typed since focusing.
   *
   * Filtering on the existing value would show a cell reading "de" a menu of
   * exactly one option — useless, since the reason to open it is to pick
   * something else. So the list filters only once there is a query.
   */
  protected readonly typed = signal(false);

  /** Unique per instance: the wizard renders one of these per table row. */
  protected readonly listId = `lx-combobox-${++instances}`;

  // `viewChild` cannot sit on an ES private field (NG1053), so this one breaks
  // the #private convention the rest of the codebase follows.
  protected readonly fieldRef = viewChild.required<ElementRef<HTMLInputElement>>('field');
  readonly #host = inject(ElementRef);

  protected readonly matches = computed(() => {
    const needle = this.value().toLowerCase();
    const all = this.options();
    if (!this.typed() || needle === '') return all;
    const hits = all.filter((o) => o.toLowerCase().includes(needle));
    // Showing nothing would imply the typed value is rejected; it is not.
    return hits.length > 0 ? hits : all;
  });

  constructor() {
    // Keep the highlight inside the list as it filters under the cursor.
    effect(() => {
      const size = this.matches().length;
      if (this.highlighted() >= size) this.highlighted.set(Math.max(0, size - 1));
    });
  }

  protected onFocus(): void {
    this.typed.set(false);
    this.#openMenu();
    // Start on the option that is already selected, so ArrowDown moves from
    // where the user is rather than from the top of the list.
    const at = this.options().indexOf(this.value());
    this.highlighted.set(at === -1 ? 0 : at);
  }

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
    this.typed.set(true);
    if (!this.open()) this.#openMenu();
    this.highlighted.set(0);
  }

  protected onBlur(): void {
    // `mousedown` on an option fires before blur, so the click is never lost.
    this.open.set(false);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const options = this.matches();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open()) this.#openMenu();
        this.highlighted.update((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.highlighted.update((i) => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        if (!this.open()) return;
        // Enter commits the highlighted option, but only while the menu is
        // open — otherwise it would overwrite a deliberately typed value.
        event.preventDefault();
        const picked = options[this.highlighted()];
        if (picked !== undefined) this.value.set(picked);
        this.open.set(false);
        break;
      }
      case 'Escape':
        this.open.set(false);
        break;
      default:
        break;
    }
  }

  /**
   * Open, choosing the side with room for the menu.
   *
   * The side is fixed for as long as the menu stays open: re-measuring as the
   * list filters would make it jump under the cursor, and the 200px cap means
   * a short list never needs the extra space anyway.
   */
  #openMenu(): void {
    const host = this.#host.nativeElement as HTMLElement;
    const bottom = host.getBoundingClientRect().bottom;

    // Every clipping ancestor bounds the menu, not just the first one, so the
    // tightest wins. `overflow: hidden` clips exactly as `auto` does here.
    let floor = window.innerHeight;
    for (let el = host.parentElement; el !== null; el = el.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(el);
      if (overflowY !== 'visible' || overflowX !== 'visible') {
        floor = Math.min(floor, el.getBoundingClientRect().bottom);
      }
    }

    this.dropUp.set(floor - bottom < MENU_MAX_HEIGHT + MENU_GAP);
    this.open.set(true);
  }

  protected choose(event: Event, option: string): void {
    event.preventDefault();
    this.value.set(option);
    this.open.set(false);
    this.fieldRef().nativeElement.focus();
  }

  /** So a host can tell whether focus is still somewhere inside. */
  contains(node: Node): boolean {
    return (this.#host.nativeElement as HTMLElement).contains(node);
  }
}
