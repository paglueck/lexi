// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  type Signal,
  booleanAttribute,
  computed,
  contentChildren,
  inject,
  input,
  model,
} from '@angular/core';

/**
 * The adapter choice in S7: OpenAI-compatible vs Ollama native (FR-6.2).
 *
 * S16's conflict cards reuse it with two additions: `meta`, a quiet note at the
 * right of the title (who made a version), and projected content under the
 * head for the version itself, which is a diff rather than a line of hint text.
 */
@Component({
  selector: 'lx-radio-card',
  host: {
    role: 'radio',
    '[attr.aria-checked]': 'selected()',
    '[attr.aria-disabled]': 'disabled() || null',
    '[attr.tabindex]': 'tabbable() ? 0 : -1',
    '[class.card--selected]': 'selected()',
    '(keydown.space)': 'activate($event)',
    '(keydown.enter)': 'activate($event)',
  },
  template: `
    <span class="head">
      <span class="ring" [class.ring--on]="selected()" aria-hidden="true"></span>
      <span class="title">{{ title() }}</span>
      @if (meta()) {
        <span class="meta">{{ meta() }}</span>
      }
    </span>
    @if (hint()) {
      <span class="hint">{{ hint() }}</span>
    }
    <ng-content />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-4);
      padding: var(--lx-sp-12) var(--lx-sp-14);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-8);
      background: var(--lx-bg-panel);
      cursor: pointer;
    }
    .card--selected {
      border-color: var(--lx-accent);
      background: var(--lx-bg-nav-active);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
    }
    .ring {
      width: 12px;
      height: 12px;
      flex: none;
      border: 1.5px solid var(--lx-neutral-border-strong);
      border-radius: var(--lx-r-full);
      box-sizing: border-box;
    }
    .ring--on {
      border: 3px solid var(--lx-accent);
    }
    .title {
      font-size: var(--lx-fs-13);
      font-weight: var(--lx-fw-600);
    }
    .meta {
      margin-left: auto;
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint);
    }
    .hint {
      margin-left: 20px;
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-subtle);
    }
  `,
})
export class LxRadioCard {
  readonly title = input.required<string>();
  readonly hint = input<string>('');
  /** A note at the far end of the title line, e.g. who wrote this version. */
  readonly meta = input<string>('');
  readonly selected = input(false, { transform: booleanAttribute });
  /** Drawn but not choosable — S7's Ollama-native card. Skipped by the arrow keys. */
  readonly disabled = input(false, { transform: booleanAttribute });

  readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly #group = inject(LxRadioCardGroup, { optional: true });

  /**
   * The group's one tab stop: the checked card, or, while nothing is checked
   * yet, the first choosable one (WAI radio group). Without that fallback an
   * undecided group, S16's open conflict, could not be reached by Tab at all.
   */
  protected readonly tabbable: Signal<boolean> = computed<boolean>(
    () => this.selected() || this.#group?.fallbackStop() === this,
  );

  /**
   * Space and Enter do what a click does. Every consumer selects through
   * `(click)` on the card, so re-dispatching a click keeps one code path rather
   * than asking each screen to bind a second event.
   */
  protected activate(event: Event): void {
    event.preventDefault();
    if (!this.disabled()) this.host.click();
  }
}

/**
 * Groups radio cards so arrow keys and aria-checked behave as one control.
 *
 * The WAI radio-group pattern: one tab stop (the checked card, via the card's
 * roving tabindex), and ←/→/↑/↓ move to the neighbouring card AND select it.
 * The selection itself is still the card's click — see `LxRadioCard.activate`.
 */
@Component({
  selector: 'lx-radio-card-group',
  host: { role: 'radiogroup', '(keydown)': 'onKeydown($event)' },
  template: `<ng-content />`,
  styles: `
    :host {
      display: grid;
      gap: var(--lx-sp-10);
    }
  `,
})
export class LxRadioCardGroup {
  readonly cards: Signal<readonly LxRadioCard[]> = contentChildren(LxRadioCard);
  readonly value = model<string>('');

  /** The first choosable card while none is checked; null once one is. */
  readonly fallbackStop: Signal<LxRadioCard | null> = computed<LxRadioCard | null>(
    (): LxRadioCard | null => {
      const cards = this.cards();
      if (cards.some((c) => c.selected())) return null;
      return cards.find((c) => !c.disabled()) ?? null;
    },
  );

  protected onKeydown(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    const cards = this.cards().filter((c) => !c.disabled());
    if (cards.length === 0) return;
    const current = cards.findIndex((c) => c.host.contains(event.target as Node));
    const next = cards[(Math.max(current, 0) + step + cards.length) % cards.length]!;
    event.preventDefault();
    next.host.click();
    // After the click, so the card's tabindex has had a chance to become 0.
    queueMicrotask(() => next.host.focus());
  }
}
