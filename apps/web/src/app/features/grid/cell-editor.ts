// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  output,
  viewChild,
} from '@angular/core';

import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { LxSegmentEditor } from '../../ui/segment-editor.js';

/**
 * The grid's inline editor: the one `LxSegmentEditor`, drawn over the cell
 * being edited instead of in the detail panel.
 *
 * Positioned by `LxGridTable` (it knows where the cell is); this component only
 * holds the editor and the spreadsheet keys:
 *
 * - Enter / ⌘↩ commits and moves down a row, STAYING open on the same locale,
 *   so a column can be worked through without touching the mouse (FR-3.6).
 * - Esc throws this opening's typing away and closes.
 * - A pointer press anywhere outside commits what was typed and closes — the
 *   spreadsheet reading of "clicked away", and the one that loses nothing.
 *
 * It does not open for a locale with no file (the panel's "Create file" offer
 * is the way forward there), and while it is open the panel shows that target
 * read-only, so there is still exactly one editor instance (deviation 3).
 */
@Component({
  selector: 'lx-cell-editor',
  imports: [LxSegmentEditor],
  host: {
    role: 'dialog',
    'aria-label': 'Edit translation',
    '(document:pointerdown)': 'onDocumentPointer($event)',
  },
  template: `
    @let t = session.target();
    @if (t && !t.noFile) {
      <lx-segment-editor
        [value]="t.segments"
        [dir]="t.isRtl ? 'rtl' : 'ltr'"
        [available]="session.availableIds()"
        [mode]="settings.editorMode()"
        (valueChange)="session.onEdit($event)"
        (commit)="commit()"
        (revert)="revert()"
      />
      <p class="hint">
        <kbd>↩</kbd> save &amp; next row · <kbd>esc</kbd> cancel · <kbd>⇧↩</kbd> line break
      </p>
    } @else if (t?.noFile) {
      <p class="hint">No {{ t?.locale }} file for this group yet — create it from the panel.</p>
    } @else {
      <p class="hint">Loading…</p>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: var(--lx-sp-6);
      border: 1px solid var(--lx-accent);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-panel);
      box-shadow: var(--lx-shadow-modal);
    }
    .hint {
      margin: var(--lx-sp-4) var(--lx-sp-2) 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-10-5);
    }
    kbd {
      font-family: var(--lx-font-mono);
    }
  `,
})
export class LxCellEditor {
  protected readonly session = inject(EditSessionStore);
  protected readonly settings = inject(SettingsStore);
  readonly #units = inject(UnitsStore);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly #injector = inject(Injector);

  /** Closed by the keyboard: the grid takes focus back. */
  readonly closed = output<void>();

  private readonly editor = viewChild(LxSegmentEditor);

  constructor() {
    // Focus the editor whenever it (re)appears — on open, and after ⌘↩ moved to
    // the next row and that row's detail arrived.
    effect(() => {
      const editor = this.editor();
      this.#units.selectedRowId();
      if (editor === undefined) return;
      afterNextRender(() => editor.focus(), { injector: this.#injector });
    });
  }

  protected async commit(): Promise<void> {
    await this.session.commitAndAdvance();
  }

  /**
   * Esc cancels what was typed in THIS opening, as a spreadsheet does — it
   * does not also throw away a draft committed earlier (the panel's Esc does
   * that; its editor is where a pending draft is reviewed and reverted).
   */
  protected revert(): void {
    this.session.clearBuffer();
    this.session.closeInline();
    this.closed.emit();
  }

  protected onDocumentPointer(event: PointerEvent): void {
    if (this.#host.contains(event.target as Node)) return;
    void this.session.commit();
    this.session.closeInline();
  }
}
