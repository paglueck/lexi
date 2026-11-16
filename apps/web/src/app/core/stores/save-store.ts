// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, signal } from '@angular/core';

/**
 * The save indicator in the title bar, and S3's last-save footer.
 *
 * M6 fed `unsavedCount` from the dirty buffer and `lastSaveAt` from the
 * save-complete SSE event. M7 adds the other half of that event: how many files
 * were actually REWRITTEN, which is not the same as how many were saved. A file
 * whose text composed back to what was already there is never rewritten
 * (FR-1.6), and the footer says so out loud — it is the visible proof of the
 * promise that unchanged files are left alone.
 */
@Injectable({ providedIn: 'root' })
export class SaveStore {
  readonly #unsavedCount = signal(0);
  readonly #lastSaveAt = signal<string | null>(null);
  readonly #lastSaveWritten = signal<number | null>(null);

  readonly unsavedCount = this.#unsavedCount.asReadonly();
  readonly lastSaveAt = this.#lastSaveAt.asReadonly();
  readonly lastSaveWritten = this.#lastSaveWritten.asReadonly();
  readonly status = computed<'saved' | 'unsaved'>(() =>
    this.#unsavedCount() > 0 ? 'unsaved' : 'saved',
  );

  setUnsaved(count: number): void {
    this.#unsavedCount.set(count);
  }

  markSaved(at: string): void {
    this.#unsavedCount.set(0);
    this.#lastSaveAt.set(at);
  }

  /** Files whose bytes changed in the last save. Null until one has happened. */
  setWritten(count: number): void {
    this.#lastSaveWritten.set(count);
  }
}
