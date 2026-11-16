// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, ElementRef, booleanAttribute, inject, input } from '@angular/core';

export type ChipSize = 'grid' | 'panel';

/**
 * S12's three extra looks: the chip a finding is about (`danger`), the chip a
 * suggested fix puts in (`accepted`), and a placeholder the target should have
 * but does not, drawn dashed where the source implies it (`absent`).
 */
export type ChipTone = 'danger' | 'accepted' | 'absent';

/**
 * An Angular `<x/>` element, as an atomic non-editable token (FR-PH-1).
 *
 * `styles` is EMPTY on purpose, and must stay empty. All styling lives in
 * base/globals.css as `.lx-chip`, because in M5 the grid renders chips as raw
 * `<span class="lx-chip">` markup rather than one component instance per chip —
 * twelve columns by forty-five visible rows would otherwise be hundreds of
 * instances churning on every scroll frame. An encapsulated style would carry
 * an _ngcontent attribute and those raw spans would render unstyled.
 *
 * The kitchen sink asserts the two are computed-style identical, so this is a
 * failing test rather than a comment nobody reads.
 */
@Component({
  selector: 'span[lx-chip]',
  host: {
    class: 'lx-chip',
    '[attr.data-size]': 'size()',
    '[attr.data-variant]': 'missing() ? "missing" : null',
    '[attr.data-tone]': 'tone()',
    '[attr.title]': 'label()',
    '[attr.role]': 'missing() ? "button" : null',
    '[attr.tabindex]': 'missing() ? "0" : null',
    '(keydown.space)': 'pressSpace($event)',
  },
  styles: [],
  template: `{{ label() }}`,
})
export class LxPlaceholderChip {
  /** The `equiv-text` value, falling back to the placeholder id. */
  readonly label = input.required<string>();
  readonly size = input<ChipSize>('grid');
  /** Present in the source but absent from the target — the insert slot (FR-3.8). */
  readonly missing = input(false, { transform: booleanAttribute });
  readonly tone = input<ChipTone | null>(null);

  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /**
   * A missing chip is `role="button"`, and a button answers Space as well as
   * Enter. Consumers bind `(click)`, so Space re-dispatches one — and stops the
   * page scrolling, which is what Space on a span would otherwise do.
   */
  protected pressSpace(event: Event): void {
    if (!this.missing()) return;
    event.preventDefault();
    this.#host.click();
  }
}
