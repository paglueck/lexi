// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type { SegmentDto, UnitDetail, UnitRow } from '@lexi/shared';

import { UnitsApi } from '../../core/api/units-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import type { SelectedCell } from '../../core/stores/grid-selection-store.js';
import { ToastStore } from '../../core/stores/toast-store.js';
import { TranslateStore } from '../../core/stores/translate-store.js';
import { UnitDetailStore } from '../../core/stores/unit-detail-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { LxMenu } from '../../ui/menu.js';
import { LxModalService } from '../../ui/modal.js';
import { LxDeleteUnitConfirm, type DeleteUnitConfirmData } from './delete-unit-confirm.js';
import {
  SelectionActions,
  approvable,
  clearable,
  revertable,
  translatable,
  unitsOf,
  type BulkCell,
} from './selection-actions.js';

/**
 * The grid's right-click menu, for a target cell, the source cell or the unit id.
 *
 * Opened by `LxGridTable` through ONE delegated `contextmenu` listener per row —
 * the same reason click and double-click are delegated: cells are deliberately
 * not components (`LxGridRow`, rule 1), so nothing here adds per-cell work to
 * the scroll path. The menu exists only while it is open.
 *
 * It asks the server for the unit's detail across EVERY locale on open. The
 * grid's row body is not enough: it is clipped, and it only carries the visible
 * columns, while "translate the missing languages" and "delete from these
 * files" are questions about all of them.
 *
 * Every cell action lands in the unsaved overlay, exactly as the detail panel's
 * buttons do. "Delete key" is the one exception — it writes to disk at once,
 * which is why it is the one behind a modal.
 *
 * Right-clicked inside a multi-cell selection it is the SELECTION's menu
 * instead: the same actions, applied to every marked cell (`SelectionActions`).
 * That one reads the marked rows' bodies rather than one unit's detail — the
 * row body carries each cell's state, which is all a bulk action asks about,
 * and a range can span thousands of units.
 */

export type CellMenuKind = 'target' | 'source' | 'id' | 'selection';

export interface CellMenuAnchor {
  readonly kind: CellMenuKind;
  readonly rowId: string;
  /** The target cell's locale; null for the id and source cells. */
  readonly locale: string | null;
  /** Viewport coordinates the menu opens at. */
  readonly x: number;
  readonly y: number;
  /** The marked cells, for the `selection` kind — a snapshot taken when it opened. */
  readonly cells?: readonly SelectedCell[];
}

export type CellMenuAction =
  | 'edit'
  | 'translate'
  | 'copy-source'
  | 'approve'
  | 'revert'
  | 'copy-text'
  | 'clear'
  | 'copy-source-text'
  | 'copy-id'
  | 'translate-missing'
  | 'revert-all'
  | 'clear-all'
  | 'remove-notes'
  | 'delete'
  | 'translate-cells'
  | 'approve-cells'
  | 'revert-cells'
  | 'clear-cells'
  | 'remove-notes-cells'
  | 'delete-cells';

export interface CellMenuItem {
  readonly action: CellMenuAction;
  readonly label: string;
  readonly disabled: boolean;
  /** Why it is disabled, or what it will do — the `title`. */
  readonly hint?: string;
  readonly danger?: boolean;
  /** A hairline before this item, between groups. */
  readonly divider?: boolean;
}

export interface CellMenuContext {
  readonly kind: CellMenuKind;
  readonly locale: string | null;
  readonly detail: UnitDetail;
  /** The locale the panel is editing, for the source cell's "copy into". */
  readonly editLocale: string | null;
  /** Locales of this row with an unsaved edit. */
  readonly dirty: ReadonlySet<string>;
  readonly configured: boolean;
  readonly running: boolean;
}

const NO_MODEL = 'No local model is configured yet — see Settings.';
const NO_FILE = 'This locale has no file in this group yet — create it from the panel.';

/**
 * What the menu offers, for one cell. A pure function of the state so the spec
 * can pin every enable/disable rule without a DOM.
 */
export function cellMenuItems(ctx: CellMenuContext): CellMenuItem[] {
  const { detail } = ctx;
  // A selection's items come from `selectionMenuItems`; it has no one unit.
  if (ctx.kind === 'selection') return [];
  const translateBlocked = !ctx.configured
    ? NO_MODEL
    : ctx.running
      ? 'A draft is already running.'
      : null;

  if (ctx.kind === 'target') {
    const t = detail.targets.find((x) => x.locale === ctx.locale);
    if (t === undefined) return [];
    const noFile = t.noFile ? NO_FILE : null;
    const hasText = t.segments.length > 0;
    const reviewable = t.state === 'draftMachine' || t.state === 'needsReview';
    return [
      { action: 'edit', label: 'Edit in place', disabled: t.noFile, hint: noFile ?? 'Enter' },
      {
        action: 'translate',
        label: hasText ? 'Re-translate cell' : 'Translate cell',
        disabled: t.noFile || translateBlocked !== null,
        hint: noFile ?? translateBlocked ?? `Draft this string into ${t.locale}`,
      },
      {
        action: 'copy-source',
        label: 'Copy source → target',
        disabled: t.noFile,
        hint: noFile ?? 'For a string that is the same in both languages',
      },
      {
        action: 'approve',
        label: 'Approve',
        disabled: !reviewable,
        hint: reviewable
          ? 'Mark as reviewed, unchanged'
          : 'Only a machine draft or a needs-review string',
        divider: true,
      },
      {
        action: 'revert',
        label: 'Revert unsaved edit',
        disabled: !ctx.dirty.has(t.locale),
        hint: ctx.dirty.has(t.locale) ? 'Back to what is in the file' : 'Nothing unsaved here',
      },
      { action: 'copy-text', label: 'Copy translation', disabled: !hasText, divider: true },
      {
        action: 'clear',
        label: 'Clear translation',
        disabled: !hasText || t.noFile,
        hint: 'Empties the target — unsaved until Save',
        danger: true,
        divider: true,
      },
      removeNotesItem(detail),
      deleteItem(detail),
    ];
  }

  if (ctx.kind === 'source') {
    const into =
      ctx.editLocale === null ? undefined : detail.targets.find((x) => x.locale === ctx.editLocale);
    const items: CellMenuItem[] = [
      { action: 'copy-source-text', label: 'Copy source text', disabled: false },
    ];
    if (into !== undefined) {
      items.push({
        action: 'copy-source',
        label: `Copy source → ${into.locale}`,
        disabled: into.noFile,
        ...(into.noFile ? { hint: NO_FILE } : {}),
      });
    }
    items.push(removeNotesItem(detail, true), deleteItem(detail));
    return items;
  }

  const missing = missingLocales(detail);
  const withText = detail.targets.filter((t) => t.segments.length > 0 && !t.noFile);
  return [
    { action: 'copy-id', label: 'Copy unit id', disabled: false },
    {
      action: 'translate-missing',
      label:
        missing.length === 0
          ? 'Translate missing languages'
          : `Translate ${missing.length} missing ${missing.length === 1 ? 'language' : 'languages'}`,
      disabled: missing.length === 0 || !ctx.configured,
      hint: !ctx.configured
        ? NO_MODEL
        : missing.length === 0
          ? 'Every locale with a file already has a translation'
          : `Queues a job for ${missing.join(', ')}`,
      divider: true,
    },
    {
      action: 'revert-all',
      label: 'Revert unsaved edits',
      disabled: ctx.dirty.size === 0,
      hint: ctx.dirty.size === 0 ? 'Nothing unsaved in this unit' : [...ctx.dirty].join(', '),
    },
    {
      action: 'clear-all',
      label: 'Clear all translations',
      disabled: withText.length === 0,
      hint: 'Empties every target — unsaved until Save',
      danger: true,
      divider: true,
    },
    removeNotesItem(detail),
    deleteItem(detail),
  ];
}

/**
 * "Remove notes" — every note of the unit, staged like any edit. Notes live in
 * the source file, so a unit without one (an orphan) has none to remove.
 */
function removeNotesItem(detail: UnitDetail, divider = false): CellMenuItem {
  const count = detail.notes.length;
  return {
    action: 'remove-notes',
    label: count > 1 ? `Remove ${count} notes` : 'Remove note',
    disabled: count === 0 || detail.notesFile === null,
    hint:
      detail.notesFile === null
        ? 'This unit is not in the source file, where notes are kept'
        : count === 0
          ? 'This unit has no notes'
          : 'Removes every note of this unit — unsaved until Save',
    danger: true,
    ...(divider ? { divider: true } : {}),
  };
}

export interface SelectionMenuContext {
  readonly cells: readonly BulkCell[];
  readonly configured: boolean;
}

/**
 * What the menu offers for a multi-cell selection. Every item names how many
 * cells (or units) it will touch, and is disabled at none — the same
 * predicates `SelectionActions` filters by, so the number is the truth.
 */
export function selectionMenuItems(ctx: SelectionMenuContext): CellMenuItem[] {
  const { cells } = ctx;
  const translate = cells.filter(translatable).length;
  const approve = cells.filter(approvable).length;
  const revert = cells.filter(revertable).length;
  const clear = cells.filter(clearable).length;
  const units = unitsOf(cells).length;
  const n = (count: number, one: string, many = `${one}s`): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

  return [
    {
      action: 'translate-cells',
      label: `Translate ${n(translate, 'cell')}`,
      disabled: translate === 0 || !ctx.configured,
      hint: !ctx.configured
        ? NO_MODEL
        : 'Queues one job per locale; a human translation is left alone',
    },
    {
      action: 'approve-cells',
      label: `Approve ${n(approve, 'cell')}`,
      disabled: approve === 0,
      hint:
        approve === 0
          ? 'Only machine drafts and needs-review strings'
          : 'Mark as reviewed, unchanged',
      divider: true,
    },
    {
      action: 'revert-cells',
      label: `Revert ${n(revert, 'unsaved edit')}`,
      disabled: revert === 0,
      hint: revert === 0 ? 'Nothing unsaved here' : 'Back to what is in the file',
    },
    {
      action: 'clear-cells',
      label: `Clear ${n(clear, 'translation')}`,
      disabled: clear === 0,
      hint: 'Empties the targets — unsaved until Save',
      danger: true,
      divider: true,
    },
    {
      action: 'remove-notes-cells',
      label: `Remove notes of ${n(units, 'unit')}`,
      disabled: units === 0,
      hint: 'Removes every note of these units — unsaved until Save',
      danger: true,
    },
    {
      action: 'delete-cells',
      label: `Delete ${n(units, 'key')}`,
      disabled: units === 0,
      hint: 'Removes the units from the source and every locale file, immediately',
      danger: true,
      divider: true,
    },
  ];
}

/**
 * "Delete key…" — on every cell of the row, not just the id, because the id
 * column is the narrowest target and the last place anyone looks.
 */
function deleteItem(detail: UnitDetail, divider = false): CellMenuItem {
  return {
    action: 'delete',
    label: 'Delete key',
    disabled: unitFiles(detail).length === 0,
    hint: 'Removes the unit from the source and every locale file, immediately',
    danger: true,
    ...(divider ? { divider: true } : {}),
  };
}

/** Locales with a file but no translation — what "translate missing" drafts. */
export function missingLocales(detail: UnitDetail): string[] {
  return detail.targets.filter((t) => !t.noFile && t.state === 'untranslated').map((t) => t.locale);
}

/** Every file the unit is in: the source file, then each locale's. */
export function unitFiles(detail: UnitDetail): string[] {
  const files = new Set<string>();
  if (detail.notesFile !== null) files.add(detail.notesFile);
  for (const target of detail.targets) {
    const file = detail.files[target.locale];
    if (file !== undefined && !target.missing && !target.noFile) files.add(file);
  }
  return [...files];
}

/** Segments as a person would paste them: placeholders as their display text. */
export function plainText(segments: readonly SegmentDto[]): string {
  return segments
    .map((s) => (s.k === 't' ? s.v : s.k === 'p' ? s.equivText || s.id : plainText(s.children)))
    .join('');
}

@Component({
  selector: 'lx-cell-menu',
  imports: [LxMenu],
  host: {
    '[style.left.px]': 'pos().left',
    '[style.top.px]': 'pos().top',
    '(contextmenu)': '$event.preventDefault()',
  },
  template: `
    @if (items(); as list) {
      <div class="menu" lxMenu [attr.aria-label]="label()" (lxMenuClose)="closed.emit()">
        @for (item of list; track item.action) {
          @if (item.divider) {
            <span class="divider" role="separator"></span>
          }
          <button
            type="button"
            role="menuitem"
            class="menuitem"
            [disabled]="item.disabled"
            [attr.data-danger]="item.danger ? 'true' : null"
            [title]="item.hint ?? ''"
            (click)="run(item.action)"
          >
            {{ item.label }}
          </button>
        } @empty {
          <span class="menuempty">Nothing to do here.</span>
        }
      </div>
    } @else {
      <div class="menu">
        <span class="menuempty">{{
          failed() ? 'This unit could not be loaded.' : 'Loading…'
        }}</span>
      </div>
    }
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 40;
    }
    .menu {
      display: flex;
      flex-direction: column;
      min-width: 220px;
      padding: var(--lx-sp-4);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
    }
    .menuitem {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-4) var(--lx-sp-8);
      border: 0;
      border-radius: var(--lx-r-5);
      background: transparent;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      text-align: left;
      white-space: nowrap;
      cursor: pointer;
    }
    .menuitem:hover:not(:disabled),
    .menuitem:focus-visible {
      background: var(--lx-bg-selected);
      outline: none;
    }
    .menuitem[data-danger='true']:not(:disabled) {
      color: var(--lx-danger);
    }
    .menuitem:disabled {
      color: var(--lx-text-faint);
      cursor: default;
    }
    .divider {
      height: 1px;
      margin: var(--lx-sp-4) 0;
      background: var(--lx-border-row);
    }
    .menuempty {
      padding: var(--lx-sp-6) var(--lx-sp-8);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
  `,
})
export class LxCellMenu implements OnDestroy {
  readonly anchor = input.required<CellMenuAnchor>();
  readonly closed = output<void>();

  readonly #api = inject(UnitsApi);
  readonly #drafts = inject(DraftStore);
  readonly #session = inject(EditSessionStore);
  readonly #grid = inject(GridStore);
  readonly #jobs = inject(JobsStore);
  readonly #project = inject(ProjectStore);
  readonly #settings = inject(SettingsStore);
  readonly #toasts = inject(ToastStore);
  readonly #translate = inject(TranslateStore);
  readonly #units = inject(UnitsStore);
  readonly #modal = inject(LxModalService);
  readonly #bulk = inject(SelectionActions);
  readonly #unitDetail = inject(UnitDetailStore);
  readonly #el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly detail = signal<UnitDetail | null>(null);
  /** The marked rows' bodies, for the `selection` kind. */
  protected readonly rows = signal<ReadonlyMap<string, UnitRow> | null>(null);
  protected readonly failed = signal(false);
  /** Where the menu sits: the anchor, pulled back inside the viewport once measured. */
  protected readonly pos = signal({ left: 0, top: 0 });

  protected readonly label = computed(() => {
    const a = this.anchor();
    if (a.kind === 'selection') {
      const cells = a.cells ?? [];
      const units = new Set(cells.map((c) => c.rowId)).size;
      return `${cells.length.toLocaleString()} cells in ${units.toLocaleString()} ${units === 1 ? 'unit' : 'units'}`;
    }
    return a.kind === 'target'
      ? `Actions for ${a.locale}`
      : a.kind === 'id'
        ? 'Unit actions'
        : 'Source actions';
  });

  /** The marked cells with their row bodies and dirty flags; null while loading. */
  readonly #bulkCells = computed<BulkCell[] | null>(() => {
    const rows = this.rows();
    if (rows === null) return null;
    return (this.anchor().cells ?? []).map(({ rowId, locale }) => ({
      rowId,
      locale,
      cell: rows.get(rowId)?.cells[locale],
      dirty: this.#drafts.draftFor(rowId, locale) !== undefined,
    }));
  });

  protected readonly items = computed<CellMenuItem[] | null>(() => {
    if (this.anchor().kind === 'selection') {
      const cells = this.#bulkCells();
      return cells === null
        ? null
        : selectionMenuItems({ cells, configured: this.#settings.configured() });
    }
    const detail = this.detail();
    if (detail === null) return null;
    const a = this.anchor();
    return cellMenuItems({
      kind: a.kind,
      locale: a.locale,
      detail,
      editLocale: this.#grid.editLocale(),
      dirty: this.#dirty(detail),
      configured: this.#settings.configured(),
      running: this.#translate.isRunning(),
    });
  });

  /** Anything outside the menu closes it — the native menu's behaviour. */
  readonly #outside = (event: Event): void => {
    if (!this.#el.contains(event.target as Node)) this.closed.emit();
  };
  readonly #dismiss = (): void => this.closed.emit();

  constructor() {
    document.addEventListener('pointerdown', this.#outside, true);
    window.addEventListener('blur', this.#dismiss);
    window.addEventListener('resize', this.#dismiss);

    // Load the whole unit, every locale — or every marked row — see the class
    // comment.
    effect(() => {
      const anchor = this.anchor();
      untracked(
        () =>
          void (anchor.kind === 'selection'
            ? this.#loadRows(anchor.cells ?? [])
            : this.#load(anchor.rowId)),
      );
    });

    // Keep the menu on screen: flip it left/up when it would run off an edge.
    afterRenderEffect(() => {
      this.items();
      const { x, y } = this.anchor();
      const rect = this.#el.getBoundingClientRect();
      const left = Math.max(4, x + rect.width > window.innerWidth - 4 ? x - rect.width : x);
      const top = Math.max(4, y + rect.height > window.innerHeight - 4 ? y - rect.height : y);
      const current = this.pos();
      if (current.left !== left || current.top !== top) this.pos.set({ left, top });
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener('pointerdown', this.#outside, true);
    window.removeEventListener('blur', this.#dismiss);
    window.removeEventListener('resize', this.#dismiss);
  }

  async #load(rowId: string): Promise<void> {
    if (this.detail()?.rowId === rowId) return;
    try {
      this.detail.set(await this.#api.detail(rowId, this.#grid.availableLocales()));
    } catch {
      this.failed.set(true);
    }
  }

  /** The rows endpoint takes 2000 ids a request; a range can be longer. */
  async #loadRows(cells: readonly SelectedCell[]): Promise<void> {
    const ids = [...new Set(cells.map((c) => c.rowId))];
    const locales = [...new Set(cells.map((c) => c.locale))];
    const rows = new Map<string, UnitRow>();
    try {
      for (let i = 0; i < ids.length; i += 2000) {
        const res = await this.#api.rows(ids.slice(i, i + 2000), locales);
        for (const row of res.rows) rows.set(row.rowId, row);
      }
      this.rows.set(rows);
    } catch {
      this.failed.set(true);
    }
  }

  #dirty(detail: UnitDetail): Set<string> {
    return new Set(
      detail.targets
        .filter((t) => this.#drafts.draftFor(detail.rowId, t.locale) !== undefined)
        .map((t) => t.locale),
    );
  }

  /** A buffered keystroke in the panel for this cell belongs to the old text. */
  #releaseBuffer(locale: string): void {
    if (this.#grid.editLocale() === locale) this.#session.clearBuffer();
  }

  protected async run(action: CellMenuAction): Promise<void> {
    if (this.anchor().kind === 'selection') return this.#runBulk(action);
    const detail = this.detail();
    if (detail === null) return;
    const { rowId } = detail;
    const locale = this.anchor().locale ?? this.#grid.editLocale();
    // Closed first, so the menu is gone before a modal or the inline editor
    // wants focus.
    this.closed.emit();

    switch (action) {
      case 'edit':
        if (locale !== null) this.#session.openInline(locale);
        return;
      case 'translate':
        if (locale === null) return;
        this.#releaseBuffer(locale);
        await this.#translate.translate(rowId, locale);
        return;
      case 'copy-source':
        if (locale === null) return;
        this.#releaseBuffer(locale);
        await this.#drafts.copySource(rowId, locale);
        return;
      case 'approve':
        if (locale !== null) await this.#drafts.approve(rowId, locale);
        return;
      case 'revert':
        if (locale === null) return;
        this.#releaseBuffer(locale);
        await this.#drafts.revert(rowId, locale);
        return;
      case 'copy-text': {
        const target = detail.targets.find((t) => t.locale === locale);
        await this.#copy(plainText(target?.segments ?? []), 'Translation copied');
        return;
      }
      case 'clear':
        if (locale === null) return;
        this.#releaseBuffer(locale);
        await this.#drafts.commit(rowId, locale, []);
        return;
      case 'copy-source-text':
        await this.#copy(plainText(detail.source), 'Source copied');
        return;
      case 'copy-id':
        await this.#copy(detail.unitId, 'Unit id copied');
        return;
      case 'translate-missing':
        await this.#translateMissing(detail);
        return;
      case 'revert-all': {
        const locales = [...this.#dirty(detail)];
        for (const l of locales) this.#releaseBuffer(l);
        await this.#drafts.revertMany(locales.map((locale) => ({ rowId, locale })));
        return;
      }
      case 'clear-all':
        for (const t of detail.targets) {
          if (t.segments.length === 0 || t.noFile) continue;
          this.#releaseBuffer(t.locale);
          await this.#drafts.commit(rowId, t.locale, []);
        }
        return;
      case 'remove-notes':
        await this.#removeNotes(rowId);
        return;
      case 'delete':
        await this.#delete(detail);
        return;
    }
  }

  async #runBulk(action: CellMenuAction): Promise<void> {
    const cells = this.#bulkCells();
    if (cells === null) return;
    this.closed.emit();
    switch (action) {
      case 'translate-cells':
        return this.#bulk.translate(cells);
      case 'approve-cells':
        return this.#bulk.approve(cells);
      case 'revert-cells':
        return this.#bulk.revert(cells);
      case 'clear-cells':
        return this.#bulk.clear(cells);
      case 'remove-notes-cells':
        return this.#bulk.removeNotes(unitsOf(cells));
      case 'delete-cells': {
        const rows = this.rows();
        return this.#bulk.deleteUnits(
          unitsOf(cells).map((rowId) => ({ rowId, unitId: rows?.get(rowId)?.unitId ?? rowId })),
        );
      }
    }
  }

  async #removeNotes(rowId: string): Promise<void> {
    const updated = await this.#drafts.putNotes(rowId, []);
    if (updated === null) {
      this.#toasts.show({
        tone: 'danger',
        title: 'The notes could not be removed.',
        detail: this.#drafts.error() ?? '',
      });
      return;
    }
    if (this.#units.selectedRowId() === rowId) this.#unitDetail.reload();
    this.#toasts.show({ tone: 'accent', title: 'Notes removed', detail: 'Unsaved until Save.' });
  }

  async #copy(text: string, title: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#toasts.show({ tone: 'accent', title });
    } catch {
      this.#toasts.show({ tone: 'warn', title: 'The clipboard is not available.' });
    }
  }

  /**
   * ONE job over every missing locale, the toolbar's shape (FR-6.6, S15) — the
   * locales run one after another, and each draft lands in its cell as it
   * finishes. A locale an active draft job already holds is left out, since
   * the server would refuse the whole job for it. The grid stays put; the
   * toast is the way to the run log.
   */
  async #translateMissing(detail: UnitDetail): Promise<void> {
    const locked = this.#jobs.locked('draft');
    const all = missingLocales(detail);
    const missing = all.filter((l) => !locked.has(l));
    const held = all.filter((l) => locked.has(l)).map((l) => `${l} is in #${locked.get(l)}`);
    if (missing.length === 0) {
      if (held.length > 0)
        this.#toasts.show({
          tone: 'warn',
          title: 'Already being drafted',
          detail: held.join(' · '),
        });
      return;
    }
    try {
      const job = await this.#jobs.create({
        task: 'draft',
        locales: missing.map((locale) => ({ locale, ids: [detail.rowId] })),
      });
      this.#toasts.show({
        tone: 'accent',
        title: `Drafting ${detail.unitId}`,
        detail: [`Job #${job.number}: ${missing.join(', ')}`, ...held].join(' · '),
        action: { label: 'View jobs', route: '/jobs' },
      });
    } catch (error) {
      this.#toasts.show({
        tone: 'danger',
        title: 'The job could not be queued.',
        detail: messageOf(error, ''),
      });
    }
  }

  async #delete(detail: UnitDetail): Promise<void> {
    const data: DeleteUnitConfirmData = {
      unitIds: [detail.unitId],
      files: unitFiles(detail),
      inSource: detail.notesFile !== null,
    };
    const ref = this.#modal.open<LxDeleteUnitConfirm, boolean>(LxDeleteUnitConfirm, { data });
    const confirmed = await new Promise<boolean>((resolve) => {
      ref.closed.subscribe((value) => resolve(value === true));
    });
    if (!confirmed) return;

    try {
      const res = await this.#api.deleteUnit(detail.rowId);
      if (this.#units.selectedRowId() === detail.rowId) {
        this.#session.clearBuffer();
        this.#session.closeInline();
      }
      this.#drafts.forgetRow(detail.rowId, res.unsavedCount);
      this.#units.reload();
      void this.#project.refresh();
      this.#toasts.show(
        res.skipped.length === 0
          ? {
              tone: 'accent',
              title: `Deleted ${detail.unitId}`,
              detail: `Removed from ${res.written.length} ${res.written.length === 1 ? 'file' : 'files'}.`,
            }
          : {
              tone: 'warn',
              title: `Deleted ${detail.unitId} from ${res.written.length} of ${res.written.length + res.skipped.length} files`,
              detail:
                'The others changed on disk since they were read. Reload them and delete again.',
            },
      );
    } catch (error) {
      this.#toasts.show({
        tone: 'danger',
        title: `${detail.unitId} could not be deleted.`,
        detail: messageOf(error, ''),
      });
    }
  }
}
