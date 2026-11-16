// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ScrollingModule, type CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { isRtlLocale } from '@lexi/shared/constants';

import {
  GridColumnsStore,
  trackList,
  type ColumnKey,
} from '../../core/stores/grid-columns-store.js';
import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { GridSelectionStore, type ClickModifiers } from '../../core/stores/grid-selection-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { LxCellEditor } from './cell-editor.js';
import { LxCellMenu, type CellMenuAnchor, type CellMenuKind } from './cell-menu.js';
import { LxGridRow } from './grid-row.js';
import { dragColumn } from '../../ui/column-drag.js';

/**
 * The virtualized table (FR-3.1): 20,000 rows by up to 10 locale columns, at
 * 60 fps. This shape was benchmarked before it was written; the result is in
 * docs/architecture.md (grid performance).
 *
 * Three decisions that are easy to undo by accident:
 *
 * - COLUMN WIDTHS ARE ONE CUSTOM PROPERTY. `--lx-grid-cols` is built by a
 *   computed and set once on the container; the header and every row read the
 *   same variable, so they cannot drift apart. Two declarations would drift the
 *   first time somebody added a column. The widths are fixed pixels the user
 *   drags on the header borders (`GridColumnsStore`), so many locales make the
 *   viewport scroll sideways instead of squeezing every column.
 * - THE HEADER SITS OUTSIDE THE VIEWPORT. A CDK viewport moves its content with
 *   a transform, which `position: sticky` loses to.
 * - AND IT IS SYNCED IMPERATIVELY, in a `{passive:true}` listener. Through a
 *   signal this would cost an application change-detection pass per scroll
 *   frame, which is the exact thing zoneless was chosen to avoid.
 */
const NO_MODS: ClickModifiers = { shift: false, meta: false };

@Component({
  selector: 'lx-grid-table',
  imports: [ScrollingModule, NgTemplateOutlet, LxGridRow, LxCellEditor, LxCellMenu],
  host: {
    role: 'grid',
    'aria-label': 'Translation units',
    // The grid is ONE tab stop and the selection moves inside it (↑/↓ are bound
    // on the page). Rows are not focusable — see onRowClick — so the focused
    // grid names the selected row through aria-activedescendant instead.
    tabindex: '0',
    '[attr.aria-rowcount]': 'units.total() + 1',
    '[attr.aria-activedescendant]': 'activeDescendant()',
    // The ContextMenu key fires this on the focused grid itself, not on a row.
    '(contextmenu)': 'onHostContextMenu($event)',
  },
  template: `
    <div class="headerclip">
      <div class="header" #header role="row">
        <div class="h" role="columnheader">
          unit id
          <ng-container *ngTemplateOutlet="resizer; context: { $implicit: 'id' }" />
        </div>
        <div class="h" role="columnheader">
          source · {{ sourceLocale() }}
          <ng-container *ngTemplateOutlet="resizer; context: { $implicit: 'source' }" />
        </div>
        @for (col of columns(); track col.locale) {
          <div class="h h-locale" role="columnheader">
            <span>{{ col.locale }}</span>
            <span class="pct lx-num">{{ col.coverage }}%</span>
            <ng-container *ngTemplateOutlet="resizer; context: { $implicit: col.locale }" />
          </div>
        }
      </div>
    </div>

    <!-- The grab zone on a header's right border, as in a spreadsheet. Pointer
         only: it is aria-hidden, and the column headers keep their roles. -->
    <ng-template #resizer let-key>
      <span
        class="resizer"
        aria-hidden="true"
        title="Drag to resize · double-click to reset"
        [attr.data-active]="resizing() === key ? 'true' : null"
        (pointerdown)="startResize($event, key)"
        (dblclick)="widths.reset(key)"
      ></span>
    </ng-template>

    <cdk-virtual-scroll-viewport [itemSize]="rowHeight" class="viewport" #viewport>
      <lx-grid-row
        *cdkVirtualFor="let rowId of units.ids(); let i = index; templateCacheSize: 0"
        [row]="units.rows().get(rowId)"
        [locales]="locales()"
        [rtl]="rtlLocales()"
        [selected]="i === units.selectedIndex()"
        [editLocale]="i === units.selectedIndex() ? session.editLocale() : null"
        [picked]="selection.localesAt(i)"
        [index]="i"
        (mousedown)="onRowMouseDown($event)"
        (click)="onRowClick($event, i)"
        (dblclick)="onRowDblClick($event, i)"
        (contextmenu)="onRowContextMenu($event, i)"
      />
    </cdk-virtual-scroll-viewport>

    @if (session.inline()) {
      @if (inlineBox(); as box) {
        <lx-cell-editor
          class="inline"
          [style.top.px]="box.top"
          [style.bottom.px]="box.bottom"
          [style.left.px]="box.left"
          [style.width.px]="box.width"
          (closed)="focusGrid()"
        />
      }
    }

    @if (menu(); as anchor) {
      <lx-cell-menu [anchor]="anchor" (closed)="menu.set(null)" />
    }

    @if (units.total() === 0 && !units.isLoading()) {
      <p class="empty">
        @if (grid.hasActiveFilters()) {
          Nothing matches the current filters.
        } @else {
          This project has no translation units.
        }
      </p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      position: relative;
      outline: none;
    }
    /* Keyboard focus is shown on the row it acts on, not as a ring round the
       whole table — the selected row is where the next keystroke lands. */
    :host(:focus-visible) {
      box-shadow: none;
    }
    :host(:focus-visible) lx-grid-row[data-selected='true'] {
      outline: 2px solid var(--lx-accent);
      outline-offset: -2px;
    }
    .headerclip {
      overflow: hidden;
      flex: none;
      background: var(--lx-bg-raised);
      border-bottom: 1px solid var(--lx-border-table);
    }
    .header {
      display: grid;
      grid-template-columns: var(--lx-grid-cols);
      will-change: transform;
    }
    .h {
      padding: var(--lx-sp-8) var(--lx-sp-12);
      border-right: 1px solid var(--lx-border-section);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-10);
      letter-spacing: var(--lx-track-cap);
      text-transform: uppercase;
      color: var(--lx-text-faint);
      white-space: nowrap;
      overflow: hidden;
      position: relative;
    }
    .resizer {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 7px;
      cursor: col-resize;
      touch-action: none;
      z-index: 1;
    }
    .resizer::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      right: 2px;
      width: 2px;
      background: transparent;
    }
    .resizer:hover::after,
    .resizer[data-active='true']::after {
      background: var(--lx-accent);
    }
    .h-locale {
      display: flex;
      justify-content: space-between;
      gap: var(--lx-sp-8);
    }
    .pct {
      color: var(--lx-text-faint-2);
    }
    .viewport {
      flex: 1;
      min-height: 0;
      overflow-x: auto;
    }
    /* Over the cell it edits, covering it; flipped to grow upward near the
       bottom of the table so it never runs off the screen. */
    .inline {
      position: absolute;
      z-index: 30;
    }
    .empty {
      position: absolute;
      inset: var(--lx-h-toolbar) 0 auto 0;
      margin: 0;
      padding: var(--lx-sp-28) var(--lx-sp-32);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-13);
      text-align: center;
    }
  `,
})
export class LxGridTable {
  protected readonly units = inject(UnitsStore);
  protected readonly grid = inject(GridStore);
  protected readonly session = inject(EditSessionStore);
  protected readonly selection = inject(GridSelectionStore);

  /** Where the inline editor sits, relative to this host; null while its cell is not rendered. */
  protected readonly inlineBox = signal<{
    top: number | null;
    bottom: number | null;
    left: number;
    width: number;
  } | null>(null);

  focusGrid(): void {
    (this.#host.nativeElement as HTMLElement).focus();
  }

  /**
   * Measure the edit cell and place the inline editor over it. DOM reads only,
   * after render, and only while the editor is open — the benchmarked scroll
   * path pays nothing for this when it is closed.
   */
  #measure(): void {
    if (!this.session.inline()) {
      this.inlineBox.set(null);
      return;
    }
    const host = this.#host.nativeElement as HTMLElement;
    const index = this.units.selectedIndex();
    const locale = this.session.editLocale();
    const at = locale === null ? -1 : this.locales().indexOf(locale);
    const row = host.querySelector(`#lx-grid-row-${index}`);
    const cell = at < 0 ? undefined : (row?.children[2 + at] as HTMLElement | undefined);
    if (cell === undefined) {
      this.inlineBox.set(null);
      return;
    }
    const h = host.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const width = Math.min(Math.max(c.width, 320), h.width - 16);
    const left = Math.max(0, Math.min(c.left - h.left, h.width - width - 8));
    const nearBottom = c.top - h.top > h.height * 0.6;
    this.inlineBox.set({
      top: nearBottom ? null : c.top - h.top,
      bottom: nearBottom ? h.bottom - c.bottom : null,
      left,
      width,
    });
  }

  protected readonly activeDescendant = computed(() => {
    const index = this.units.selectedIndex();
    return index < 0 ? null : `lx-grid-row-${index}`;
  });

  /**
   * Select the row, and let a click on a TARGET cell also choose which locale
   * the detail panel's one editor edits (M6).
   *
   * Delegated from the row rather than bound per cell. `LxGridRow` is the
   * component benchmarked at 20k x 10 and its cells are deliberately not
   * components; hanging a handler and a tabindex on every one of them would add
   * per-cell DOM work to the one place the design keeps cheapest.
   */
  protected onRowClick(event: MouseEvent, index: number): void {
    this.units.select(index);
    const locale = this.#targetLocaleOf(event.target);
    if (locale !== undefined) this.grid.setEditLocale(locale);
    this.#mark(event, index, locale);
  }

  /**
   * The multi-selection half of a click, spreadsheet-style: Shift spans a
   * range from the anchor, Cmd/Ctrl takes one cell in or out, and the unit id
   * does the same for whole rows. A plain click leaves one cell marked — the
   * anchor the next Shift+click starts from.
   */
  #mark(event: MouseEvent, index: number, locale: string | undefined): void {
    const mods: ClickModifiers = { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey };
    if (locale !== undefined) {
      this.selection.click(index, this.grid.visibleLocales().indexOf(locale), mods);
    } else if ((event.target as HTMLElement | null)?.closest?.('.c-id')) {
      this.selection.clickRow(index, mods);
    } else {
      this.selection.clear();
    }
  }

  /**
   * Shift+click would otherwise drag a text selection across the rows it spans.
   * Cancelling the mousedown also cancels the focus it would have given the
   * grid, so that is done by hand.
   */
  protected onRowMouseDown(event: MouseEvent): void {
    if (!event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    this.focusGrid();
  }

  /** The locale of the target cell an event landed in; undefined off a target cell. */
  #targetLocaleOf(target: EventTarget | null): string | undefined {
    const cell = (target as HTMLElement | null)?.closest?.('.c-tgt') ?? null;
    if (cell === null) return undefined;
    // Columns are: unit id, source, then one per visible locale.
    const at = [...(cell.parentElement?.children ?? [])].indexOf(cell) - 2;
    return this.grid.visibleLocales()[at];
  }

  /**
   * Double-click a target cell: edit it in place (the overlay editor). The two
   * clicks before it have already selected the row and chosen the locale, so
   * this only has to open the overlay — and only on a TARGET cell; the id and
   * source columns have nothing to edit.
   */
  protected onRowDblClick(event: MouseEvent, index: number): void {
    const locale = this.#targetLocaleOf(event.target);
    if (locale === undefined) return;
    this.units.select(index);
    this.session.openInline(locale);
  }

  /** The open context menu, if any. */
  protected readonly menu = signal<CellMenuAnchor | null>(null);

  /**
   * Right-click: select what was clicked, as a left click would, and open the
   * cell menu there. Delegated for the same reason click is. A row still in
   * flight (a skeleton) has nothing to act on, so it keeps the native menu.
   */
  protected onRowContextMenu(event: MouseEvent, index: number): void {
    const rowId = this.units.ids()[index];
    if (rowId === undefined || this.units.rows().get(rowId) === undefined) return;
    const el = event.target as HTMLElement | null;
    const kind: CellMenuKind | null = el?.closest?.('.c-tgt')
      ? 'target'
      : el?.closest?.('.c-src')
        ? 'source'
        : el?.closest?.('.c-id')
          ? 'id'
          : null;
    if (kind === null) return;
    event.preventDefault();

    const locale = kind === 'target' ? (this.#targetLocaleOf(el) ?? null) : null;
    // Inside a multi-selection the menu acts on all of it, and the selection
    // stays as it is — a right-click must not collapse what it is about to use.
    if (locale !== null && this.selection.isMulti() && this.selection.has(index, locale)) {
      this.#openSelectionMenu(rowId, locale, event.clientX, event.clientY);
      return;
    }

    this.units.select(index);
    if (locale !== null) this.grid.setEditLocale(locale);
    if (locale !== null)
      this.selection.click(index, this.grid.visibleLocales().indexOf(locale), NO_MODS);
    else this.selection.clear();
    this.menu.set({ kind, rowId, locale, x: event.clientX, y: event.clientY });
  }

  #openSelectionMenu(rowId: string, locale: string | null, x: number, y: number): void {
    this.menu.set({ kind: 'selection', rowId, locale, x, y, cells: this.selection.cells() });
  }

  protected onHostContextMenu(event: MouseEvent): void {
    if (event.target !== this.#host.nativeElement) return;
    event.preventDefault();
    this.openMenuForSelection();
  }

  /**
   * Shift+F10 / the ContextMenu key: the same menu for the selected row, under
   * the cell being edited — or under the unit id when no column is. With
   * several cells marked it is the menu for all of them.
   */
  openMenuForSelection(): void {
    const index = this.units.selectedIndex();
    const rowId = this.units.selectedRowId();
    if (index < 0 || rowId === null) return;
    const host = this.#host.nativeElement as HTMLElement;
    const row = host.querySelector(`#lx-grid-row-${index}`);
    const locale = this.session.editLocale();
    const at = locale === null ? -1 : this.locales().indexOf(locale);
    const cell = row?.children[at < 0 ? 0 : 2 + at] as HTMLElement | undefined;
    if (cell === undefined) return;
    const rect = cell.getBoundingClientRect();
    if (this.selection.isMulti()) {
      this.#openSelectionMenu(rowId, locale, rect.left + 8, rect.bottom);
      return;
    }
    this.menu.set({
      kind: at < 0 ? 'id' : 'target',
      rowId,
      locale: at < 0 ? null : locale,
      x: rect.left + 8,
      y: rect.bottom,
    });
  }
  readonly #project = inject(ProjectStore);
  readonly #host = inject(ElementRef<HTMLElement>);

  protected readonly rowHeight = 34;

  private readonly viewport = viewChild.required<CdkVirtualScrollViewport>('viewport');
  private readonly header = viewChild.required<ElementRef<HTMLDivElement>>('header');

  protected readonly locales = computed(() => this.grid.visibleLocales());
  protected readonly rtlLocales = computed(() => this.locales().filter((l) => isRtlLocale(l)));
  protected readonly sourceLocale = computed(() => this.#project.sourceLocale() ?? '—');

  /** Locale headers carry their coverage percentage, as in the mock. */
  protected readonly columns = computed(() =>
    this.locales().map((locale) => {
      const summary = this.#project.locales().find((l) => l.locale === locale);
      const total = summary?.unitCount ?? 0;
      return {
        locale,
        coverage: total === 0 ? 0 : Math.round(((summary?.translated ?? 0) / total) * 100),
      };
    }),
  );

  protected readonly widths = inject(GridColumnsStore);

  /** The single source of truth for column geometry. */
  protected readonly cols = computed(() => trackList(this.widths.widths(), this.locales()));

  /** The column being dragged, which keeps its border lit while the pointer wanders off it. */
  protected readonly resizing = signal<ColumnKey | null>(null);

  /**
   * Drag a header border to resize its column (`dragColumn`). Each move is one
   * `setWidth`, which is one `setProperty` on the host. That runs only while
   * dragging, never while scrolling, so the benchmarked scroll path is
   * untouched.
   */
  protected startResize(event: PointerEvent, key: ColumnKey): void {
    if (event.button !== 0) return;
    event.preventDefault(); // no text selection while dragging
    event.stopPropagation();
    this.resizing.set(key);
    dragColumn(
      event,
      this.widths.width(key),
      (px) => this.widths.setWidth(key, px),
      () => this.resizing.set(null),
    );
  }

  constructor() {
    /**
     * The ONE declaration of column geometry, set on the host so the header and
     * every row inherit the same value and cannot drift apart.
     *
     * `setProperty` rather than a `[style.--lx-grid-cols]` binding: Angular's
     * style binding does not apply custom properties here — it silently sets
     * nothing, which renders every row as a single 855px column and looks like
     * a CSS bug rather than a binding one. Found by reading the computed style
     * in a real browser; no test would have caught it.
     */
    effect(() => {
      (this.#host.nativeElement as HTMLElement).style.setProperty('--lx-grid-cols', this.cols());
    });

    effect((onCleanup) => {
      const el = this.viewport().elementRef.nativeElement;
      const header = this.header().nativeElement;
      const sync = (): void => {
        header.style.transform = `translateX(${-el.scrollLeft}px)`;
        // A context menu belongs to a cell that has just moved; close it, as a
        // native one would. Checked before set so a scroll frame with no menu
        // open costs one signal read.
        if (this.menu() !== null) this.menu.set(null);
        // The inline editor follows its cell; a row scrolled out of the
        // rendered range hides it until it is back.
        if (this.session.inline()) this.#measure();
      };
      el.addEventListener('scroll', sync, { passive: true });
      onCleanup(() => el.removeEventListener('scroll', sync));
    });

    // Fetch the bodies for whatever is on screen, plus a window either side.
    effect((onCleanup) => {
      const sub = this.viewport().renderedRangeStream.subscribe((range) => {
        this.units.ensureRange(range.start, range.end);
      });
      onCleanup(() => sub.unsubscribe());
    });

    // Place the inline editor whenever what it depends on moves.
    afterRenderEffect(() => {
      this.session.inline();
      this.units.selectedIndex();
      this.session.editLocale();
      this.cols();
      untracked(() => this.#measure());
    });

    // Keep the selected row in view when it moves by keyboard rather than click.
    effect(() => {
      const index = this.units.selectedIndex();
      if (index < 0) return;
      const viewport = this.viewport();
      const range = viewport.getRenderedRange();
      if (index < range.start || index >= range.end - 1) {
        viewport.scrollToIndex(Math.max(0, index - 3));
      }
    });
  }
}
