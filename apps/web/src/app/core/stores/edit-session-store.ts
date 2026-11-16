// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { SegmentDto, UnitTarget } from '@lexi/shared';

import { segmentsPlaceholderIds } from '../../ui/segment-dom.js';
import { DraftStore } from './draft-store.js';
import { GridStore } from './grid-store.js';
import { UnitDetailStore } from './unit-detail-store.js';
import { UnitsStore } from './units-store.js';

/**
 * The one target being edited, and the keystrokes not yet committed to it.
 *
 * Lifted out of the detail panel when the grid gained an inline editor: there
 * are now TWO places the editor can appear — the panel and an overlay over the
 * grid cell — but still exactly one `LxSegmentEditor` mounted at a time (IME
 * cannot survive two). Whichever surface shows it reads
 * and writes this store, so a commit from either lands the same way.
 *
 * `inline` says which surface is showing it. While it is set, the panel draws
 * the same target read-only with "Editing in the grid" rather than mounting a
 * second editor.
 */
@Injectable({ providedIn: 'root' })
export class EditSessionStore {
  readonly #detail = inject(UnitDetailStore);
  readonly #drafts = inject(DraftStore);
  readonly #grid = inject(GridStore);
  readonly #units = inject(UnitsStore);

  /** The buffer the user is typing into, before it is committed. */
  readonly #buffer = signal<readonly SegmentDto[] | null>(null);

  readonly #inline = signal(false);
  /** The grid's overlay editor is open over the selected row's edit cell. */
  readonly inline = this.#inline.asReadonly();

  /**
   * Targets, with any pending edit substituted in.
   *
   * The detail resource is an `httpResource` keyed on the selection, so it does
   * not re-fetch when a draft changes. Reading the draft here is what keeps the
   * panel, the grid cell and the server's overlay saying the same thing.
   */
  readonly targets = computed<readonly UnitTarget[]>(() => {
    const detail = this.#detail.detail();
    if (detail === undefined) return [];
    const rowId = detail.rowId;
    return detail.targets.map((t) => this.#drafts.draftFor(rowId, t.locale)?.target ?? t);
  });

  /**
   * The one editable locale: whichever target cell the user clicked, else the
   * first visible column THAT CAN BE EDITED.
   *
   * "First visible column" alone is wrong, and visibly so: on the fixture the
   * leftmost column is `pl`, which only exists in the checkout file group, so
   * for every other unit the editor simply did not appear and nothing said why.
   * The grid reads this too, to outline the cell the panel is editing.
   */
  readonly editLocale = computed<string | null>(() => {
    const chosen = this.#grid.editLocale();
    if (chosen !== null) return chosen;
    const targets = this.targets();
    const editable = this.#grid
      .visibleLocales()
      .find((locale) => targets.some((t) => t.locale === locale && !t.noFile));
    return editable ?? null;
  });

  /** The target the editor shows, wherever it is shown. */
  readonly target = computed<UnitTarget | undefined>(() => {
    const locale = this.editLocale();
    return this.targets().find((t) => t.locale === locale);
  });

  /** Placeholder ids the source offers — what Shift+Enter and insert may use. */
  readonly availableIds = computed<readonly string[]>(() =>
    segmentsPlaceholderIds(this.#detail.detail()?.source ?? []),
  );

  constructor() {
    // Keystrokes belong to the cell they were typed into. Without this, typing
    // in one row, clicking another and pressing ⌘↩ committed the FIRST row's
    // text into the second — the buffer outlived the selection it was for.
    effect(() => {
      this.#units.selectedRowId();
      this.editLocale();
      this.#buffer.set(null);
    });
  }

  onEdit(segments: readonly SegmentDto[]): void {
    this.#buffer.set(segments);
  }

  hasBuffer(): boolean {
    return this.#buffer() !== null;
  }

  clearBuffer(): void {
    this.#buffer.set(null);
  }

  async commit(): Promise<void> {
    const rowId = this.#detail.detail()?.rowId;
    const locale = this.editLocale();
    const buffer = this.#buffer();
    if (rowId === undefined || locale === null || buffer === null) return;
    this.#buffer.set(null);
    await this.#drafts.commit(rowId, locale, buffer);
  }

  /** `Cmd+Enter`: commit, then move to the next filtered row (FR-3.6). */
  async commitAndAdvance(): Promise<void> {
    await this.commit();
    this.#units.moveSelection(1);
  }

  /** `Esc`: throw away the pending edit and show what is in the file again. */
  async revert(): Promise<void> {
    const rowId = this.#detail.detail()?.rowId;
    const locale = this.editLocale();
    if (rowId === undefined || locale === null) return;
    this.#buffer.set(null);
    await this.#drafts.revert(rowId, locale);
  }

  /**
   * Open the grid's overlay editor on the selected row, in `locale` if given.
   * A locale with no file has nowhere to write, so it opens nothing — the
   * panel's "Create file" offer is the way forward there.
   */
  openInline(locale?: string): boolean {
    if (locale !== undefined) this.#grid.setEditLocale(locale);
    const target = this.targets().find((t) => t.locale === (locale ?? this.editLocale()));
    // While the detail is still loading there is nothing to check against yet;
    // the overlay shows "Loading…" until it arrives.
    if (target?.noFile) return false;
    this.#inline.set(true);
    return true;
  }

  closeInline(): void {
    this.#inline.set(false);
  }
}
