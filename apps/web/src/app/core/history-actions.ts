// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject } from '@angular/core';

import { isTypingTarget } from './is-typing-target.js';
import { DraftStore } from './stores/draft-store.js';
import { EditSessionStore } from './stores/edit-session-store.js';
import { ProjectStore } from './stores/project-store.js';
import { ToastStore } from './stores/toast-store.js';
import { LxModalService } from '../ui/modal.js';
import { LxDiscardAllConfirm, type DiscardAllConfirmData } from '../ui/discard-all-confirm.js';

/**
 * Which history chord a keydown is: ⌘Z / Ctrl+Z undo, ⌘⇧Z / Ctrl+⇧Z / Ctrl+Y
 * redo. Null for anything else — and for any of them typed into a text field,
 * where they are the field's own text undo, which is the one meant there.
 */
export function historyChord(event: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || isTypingTarget(event.target))
    return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

/**
 * Undo, redo and "Discard all" — the global ⌘Z / ⌘⇧Z, the grid toolbar and the
 * command palette are three doors onto these, so they share one body: what to
 * refuse, what to throw away first, and what to say afterwards.
 */
@Injectable({ providedIn: 'root' })
export class HistoryActions {
  readonly #drafts = inject(DraftStore);
  readonly #session = inject(EditSessionStore);
  readonly #project = inject(ProjectStore);
  readonly #toasts = inject(ToastStore);
  readonly #modal = inject(LxModalService);

  readonly #ready = computed(() => this.#project.isOpen() && !this.#drafts.saving());
  readonly canUndo = computed(() => this.#ready() && this.#drafts.canUndo());
  readonly canRedo = computed(() => this.#ready() && this.#drafts.canRedo());
  readonly canDiscard = computed(() => this.#ready() && this.#drafts.isDirty());

  async undo(): Promise<void> {
    if (!this.canUndo()) return;
    // Keystrokes not yet committed belong to the state being left; committing
    // them on the next blur would land them on top of the restored one.
    this.#session.clearBuffer();
    this.#report('Undone', await this.#drafts.undo());
  }

  async redo(): Promise<void> {
    if (!this.canRedo()) return;
    this.#session.clearBuffer();
    this.#report('Redone', await this.#drafts.redo());
  }

  async discardAll(): Promise<void> {
    if (!this.canDiscard()) return;
    const data: DiscardAllConfirmData = { unsavedCount: this.#drafts.count() };
    const ref = this.#modal.open<LxDiscardAllConfirm, boolean>(LxDiscardAllConfirm, { data });
    const confirmed = await new Promise<boolean | undefined>((resolve) => {
      ref.closed.subscribe((value) => resolve(value));
    });
    if (confirmed !== true) return;

    this.#session.clearBuffer();
    if (await this.#drafts.discardAll()) {
      this.#toasts.show({
        tone: 'accent',
        title: 'Discarded all unsaved changes',
        detail: '⌘Z brings them back.',
      });
    } else {
      this.#toasts.show({
        tone: 'danger',
        title: 'Nothing was discarded',
        detail: this.#drafts.error() ?? '',
      });
    }
  }

  #report(verb: string, label: string | null): void {
    if (label !== null) this.#toasts.show({ tone: 'accent', title: `${verb}: ${label}` });
    else
      this.#toasts.show({
        tone: 'danger',
        title: `Nothing was ${verb.toLowerCase()}`,
        detail: this.#drafts.error() ?? '',
      });
  }
}
