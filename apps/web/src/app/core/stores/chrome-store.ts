// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, signal } from '@angular/core';

export interface StatusItem {
  readonly text: string;
  /** Rendered as a monospace keycap ahead of the text (⌘↩, esc, ⌘K). */
  readonly key?: string;
}

export const DEFAULT_SHORTCUTS: readonly StatusItem[] = [
  { key: '⌘↩', text: 'save & next row' },
  { key: 'esc', text: 'revert' },
  { key: '⌘Z', text: 'undo' },
  { key: '⌘K', text: 'commands' },
];

/**
 * The status bar is the one piece of chrome that is a shell slot (deviation 1
 * makes it full-bleed), so features need a way to publish into it. Ten lines,
 * no state library.
 *
 * The 42px toolbar is deliberately NOT here: it lives inside the flexing centre
 * column, and a "toolbar outlet" would be indirection with one and a half
 * consumers.
 */
@Injectable({ providedIn: 'root' })
export class ChromeStore {
  readonly #left = signal<readonly StatusItem[]>([]);
  readonly #right = signal<readonly StatusItem[]>(DEFAULT_SHORTCUTS);

  readonly left = this.#left.asReadonly();
  readonly right = this.#right.asReadonly();

  setLeft(items: readonly StatusItem[]): void {
    this.#left.set(items);
  }

  setRight(items: readonly StatusItem[]): void {
    this.#right.set(items);
  }

  reset(): void {
    this.#left.set([]);
    this.#right.set(DEFAULT_SHORTCUTS);
  }
}
