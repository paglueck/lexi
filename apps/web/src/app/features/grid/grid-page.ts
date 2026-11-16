// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { ElementRef, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import type { UnitCreateResponse } from '@lexi/shared';
import { splitRowId } from '@lexi/shared/constants';

import { LxBadge } from '../../ui/badge.js';
import { LxButton } from '../../ui/button.js';
import { LxIcon } from '../../ui/icon.js';
import { LxMenu } from '../../ui/menu.js';
import { LxModalService } from '../../ui/modal.js';
import { messageOf } from '../../core/api/server-message.js';
import { LxToolbar } from '../../ui/chrome/toolbar.js';
import { ChromeStore, DEFAULT_SHORTCUTS } from '../../core/stores/chrome-store.js';
import { GridSelectionStore } from '../../core/stores/grid-selection-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { CsvImportStore } from '../../core/stores/csv-import-store.js';
import { ToastStore } from '../../core/stores/toast-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { LxGridRail } from './grid-rail.js';
import { LxGridTable } from './grid-table.js';
import { LxUnitDetail } from './unit-detail.js';
import { LxDraftJobsModal } from './draft-jobs-modal.js';
import { LxCreateUnitModal, type CreateUnitModalData } from './create-unit-modal.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { HistoryActions } from '../../core/history-actions.js';
import { EditSessionStore } from '../../core/stores/edit-session-store.js';

/** The segment editor's contenteditable, or its text-mode textarea. */
function isEditingSurface(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA')
  );
}

/**
 * S4, the grid — the home screen after setup, and editable from M6.
 *
 * Layout is the mock's `244px 1fr 330px`, with the toolbar INSIDE the centre
 * column rather than as a shell slot (LxToolbar's own note explains why). The
 * status bar is the one piece of chrome that is a shell slot, so the counts go
 * there through ChromeStore.
 */
@Component({
  selector: 'lx-grid-page',
  imports: [LxToolbar, LxGridRail, LxGridTable, LxUnitDetail, LxButton, LxBadge, LxIcon, LxMenu],
  host: {
    '(keydown)': 'onKey($event)',
    '(document:pointerdown)': 'closeColumnsOutside($event)',
  },
  template: `
    <div class="split">
      <lx-grid-rail />

      <div class="center">
        <lx-toolbar>
          <div class="cols" #cols>
            <button
              type="button"
              lx-button
              size="xs"
              aria-haspopup="menu"
              (click)="columnsOpen.set(!columnsOpen())"
              [attr.aria-expanded]="columnsOpen()"
            >
              Locale columns: {{ grid.visibleLocales().length }} of
              {{ grid.availableLocales().length }}
              <lx-icon name="chevron-down" [size]="12" />
            </button>
            @if (columnsOpen()) {
              <div
                class="menu"
                lxMenu
                aria-label="Locale columns"
                (lxMenuClose)="columnsOpen.set(false)"
              >
                @for (locale of grid.availableLocales(); track locale) {
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    class="menuitem"
                    [attr.aria-checked]="grid.visibleLocales().includes(locale)"
                    (click)="grid.toggleLocale(locale)"
                  >
                    <span class="tick">
                      @if (grid.visibleLocales().includes(locale)) {
                        <lx-icon name="check" [size]="12" />
                      }
                    </span>
                    {{ locale }}
                  </button>
                } @empty {
                  <span class="menuempty">No target locales in this project.</span>
                }
              </div>
            }
          </div>

          @for (chip of activeChips(); track chip.key) {
            <button
              type="button"
              class="chip"
              (click)="chip.clear()"
              [title]="'Remove filter: ' + chip.label"
            >
              {{ chip.label }} <lx-icon class="x" name="x" [size]="12" />
              <span class="sr-only">remove filter</span>
            </button>
          }

          <span class="lx-spacer"></span>

          @if (units.isLoading()) {
            <lx-badge tone="neutral" size="xs">loading…</lx-badge>
          }
          <button
            type="button"
            lx-button
            iconOnly
            [disabled]="!history.canUndo()"
            (click)="history.undo()"
            [attr.aria-label]="undoTitle()"
            [title]="undoTitle()"
          >
            <lx-icon name="undo" [size]="13" />
          </button>
          <button
            type="button"
            lx-button
            iconOnly
            [disabled]="!history.canRedo()"
            (click)="history.redo()"
            [attr.aria-label]="redoTitle()"
            [title]="redoTitle()"
          >
            <lx-icon name="redo" [size]="13" />
          </button>
          @if (drafts.isDirty()) {
            <button
              type="button"
              lx-button
              [disabled]="!history.canDiscard()"
              (click)="history.discardAll()"
              title="Throw away every unsaved change (⌘Z brings it back)"
            >
              Discard all
            </button>
            <button
              type="button"
              lx-button
              variant="primary"
              [disabled]="drafts.saving()"
              (click)="save()"
              title="Save every pending edit (⌘S)"
            >
              {{ drafts.saving() ? 'Saving…' : 'Save ' + drafts.count() }}
            </button>
          }
          <button
            type="button"
            lx-button
            [disabled]="newKeyTarget() === null"
            (click)="newKey()"
            title="Add a key to the source file"
          >
            <lx-icon name="plus" [size]="13" />
            New key
          </button>
          <button
            type="button"
            lx-button
            (click)="copySource()"
            title="Copy source → target (FR-3.12)"
          >
            <lx-icon name="copy" [size]="13" />
            Copy source → target
          </button>
          <button
            type="button"
            lx-button
            size="xs"
            title="Bring a reviewer's edited CSV back into the project"
            [disabled]="importBusy()"
            (click)="chooseImport()"
          >
            Import CSV…
          </button>
          <input
            #importFile
            type="file"
            class="sr-only"
            accept=".csv,text/csv"
            multiple
            tabindex="-1"
            aria-hidden="true"
            (change)="onImportFiles($event)"
          />
          <button
            type="button"
            lx-button
            variant="primary"
            size="xs"
            title="Queue one job that drafts the current filter into one or more locales"
            (click)="openDraft()"
          >
            Translate...
          </button>
        </lx-toolbar>

        @if (units.error()) {
          <p class="failed" role="alert">The grid could not be loaded. {{ errorText() }}</p>
        } @else {
          <lx-grid-table />
        }
      </div>

      <lx-unit-detail />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .split {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .center {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .cols {
      position: relative;
    }
    .menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      min-width: 160px;
      padding: var(--lx-sp-4);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
      /* A project with many locales scrolls inside the menu, not off the window. */
      max-height: min(360px, 60vh);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .menuitem {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-4) var(--lx-sp-8);
      border-radius: var(--lx-r-5);
      background: transparent;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      text-align: left;
    }
    .menuitem:hover {
      background: var(--lx-bg-selected);
    }
    .tick {
      display: inline-flex;
      width: 12px;
      color: var(--lx-accent);
    }
    .menuempty {
      padding: var(--lx-sp-6) var(--lx-sp-8);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--lx-sp-4);
      height: 26px;
      padding: 0 var(--lx-sp-8);
      border: 1px solid var(--lx-accent-tint-border);
      border-radius: var(--lx-r-6);
      background: var(--lx-accent-tint-bg);
      color: var(--lx-accent-on-tint);
      font-size: var(--lx-fs-11-5);
    }
    .x {
      color: var(--lx-accent-on-tint-dim);
    }
    .failed {
      padding: var(--lx-sp-28) var(--lx-sp-32);
      color: var(--lx-danger);
      font-size: var(--lx-fs-13);
    }
  `,
})
export class GridPage implements OnDestroy {
  protected readonly grid = inject(GridStore);
  protected readonly units = inject(UnitsStore);
  protected readonly drafts = inject(DraftStore);
  protected readonly history = inject(HistoryActions);
  readonly #session = inject(EditSessionStore);
  readonly #selection = inject(GridSelectionStore);
  readonly #project = inject(ProjectStore);
  readonly #chrome = inject(ChromeStore);
  readonly #modal = inject(LxModalService);
  readonly #toasts = inject(ToastStore);
  readonly #csvImport = inject(CsvImportStore);
  /** Off while a pick is being read and previewed: a second pick would only be ignored. */
  protected readonly importBusy = this.#csvImport.busy;
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  readonly #injector = inject(Injector);
  readonly #params = toSignal(this.#route.queryParamMap, { initialValue: null });

  /** The panel owns the editor, so the toolbar's actions are delegated to it. */
  private readonly detail = viewChild(LxUnitDetail);
  private readonly table = viewChild(LxGridTable);
  private readonly importInput = viewChild<ElementRef<HTMLInputElement>>('importFile');

  protected readonly columnsOpen = signal(false);
  private readonly cols = viewChild<ElementRef<HTMLElement>>('cols');

  /**
   * A press anywhere outside the locale button and its menu closes the menu.
   * The wrapper holds both, so pressing the button still toggles it.
   */
  protected closeColumnsOutside(event: Event): void {
    if (!this.columnsOpen()) return;
    const cols = this.cols()?.nativeElement;
    if (cols !== undefined && !cols.contains(event.target as Node)) this.columnsOpen.set(false);
  }

  /**
   * Where "New key…" writes: the selected row's group, else the first one, and
   * that group's source file — by the rule the server's index uses. Null when
   * no group has one, which disables the button.
   */
  protected readonly newKeyTarget = computed<CreateUnitModalData | null>(() => {
    const project = this.#project.project();
    if (project === null) return null;
    const selected = this.units.selectedRowId();
    const groups = project.groups;
    const preferred = selected === null ? undefined : splitRowId(selected).group;
    const order =
      preferred !== undefined && groups.includes(preferred) ? [preferred, ...groups] : groups;
    for (const group of order) {
      const file = project.files.find(
        (f) =>
          f.group === group &&
          f.locale !== null &&
          (f.locale === project.sourceLocale || f.isTemplate),
      );
      if (file) return { group, sourceFile: file.relPath };
    }
    return null;
  });

  protected readonly undoTitle = computed(() => {
    const label = this.drafts.undoLabel();
    return label === null ? 'Nothing to undo' : `Undo ${label} (⌘Z)`;
  });
  protected readonly redoTitle = computed(() => {
    const label = this.drafts.redoLabel();
    return label === null ? 'Nothing to redo' : `Redo ${label} (⌘⇧Z)`;
  });

  protected readonly errorText = computed(() => {
    // An `httpResource` failure is an `HttpErrorResponse`, whose `message` is
    // Angular's "Http failure response for …"; the server's own sentence is in
    // the envelope, and says what is actually wrong.
    const err: unknown = this.units.error();
    return messageOf(err, err instanceof Error ? err.message : '');
  });

  /** The toolbar's removable filter chips — search, namespace, each checkbox. */
  protected readonly activeChips = computed(() => {
    const chips: Array<{ key: string; label: string; clear: () => void }> = [];
    for (const group of this.grid.groups()) {
      chips.push({
        key: `g:${group}`,
        label: `file: ${group}`,
        clear: () => this.grid.clearGroups(),
      });
    }
    for (const filter of this.grid.filters()) {
      chips.push({
        key: `f:${filter}`,
        label: filter,
        clear: () => this.grid.toggleFilter(filter),
      });
    }
    return chips;
  });

  constructor() {
    // The status bar is a shell slot; this is the grid publishing into it.
    effect(() => {
      const total = this.units.total();
      const scope = this.units.scopeTotal();
      const index = this.units.selectedIndex();
      this.#chrome.setLeft([
        { text: `${total.toLocaleString()} of ${scope.toLocaleString()} rows` },
        { text: index < 0 ? 'No row selected' : `Row ${(index + 1).toLocaleString()} selected` },
        ...(this.#selection.isMulti()
          ? [{ text: `${this.#selection.count().toLocaleString()} cells marked` }]
          : []),
      ]);
    });

    // M5 overrode these because the save and revert keys would have been lying.
    // They are not lying any more, so the default set stands (FR-3.6).
    effect(() => {
      this.#project.isOpen();
      this.#chrome.reset();
    });

    this.#chrome.setRight(DEFAULT_SHORTCUTS);

    // `?row=&locale=`: another screen (S12's "Open in grid") asked for one
    // cell. Reveal it, hand the keyboard to the table, and drop the parameters
    // so a reload or a Back does not do it again.
    effect(() => {
      const params = this.#params();
      const row = params?.get('row') ?? null;
      const locale = params?.get('locale') ?? null;
      if (row === null || locale === null) return;
      untracked(() => {
        this.units.reveal(row, locale);
        void this.#router.navigate([], {
          relativeTo: this.#route,
          queryParams: {},
          replaceUrl: true,
        });
        afterNextRender(() => this.table()?.focusGrid(), { injector: this.#injector });
      });
    });
  }

  ngOnDestroy(): void {
    this.#chrome.reset();
  }

  protected async save(): Promise<void> {
    if (!this.drafts.isDirty()) return;
    await this.drafts.saveAll();
  }

  /** "New key…": the modal writes the unit; the grid then shows and selects it. */
  protected async newKey(): Promise<void> {
    const data = this.newKeyTarget();
    if (data === null) return;
    const ref = this.#modal.open<LxCreateUnitModal, UnitCreateResponse>(LxCreateUnitModal, {
      data,
    });
    const created = await new Promise<UnitCreateResponse | undefined>((resolve) => {
      ref.closed.subscribe((value) => resolve(value));
    });
    if (created === undefined) return;

    this.units.revealRow(created.rowId);
    this.units.reload();
    void this.#project.refresh();
    this.#toasts.show({
      tone: 'accent',
      title: `Created ${splitRowId(created.rowId).unitId}`,
      detail: `Added to ${created.written}.`,
    });
  }

  protected chooseImport(): void {
    const input = this.importInput()?.nativeElement;
    if (input === undefined) return;
    input.value = '';
    input.click();
  }

  /** A bad file is a toast here: the grid has no spot beside the button for a message. */
  protected async onImportFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.#csvImport.start(files, { grid: true });
    const error = this.#csvImport.error();
    if (error !== null) this.#toasts.show({ tone: 'danger', title: 'Import failed', detail: error });
  }

  protected copySource(): void {
    void this.detail()?.copySource();
  }

  /**
   * FR-6.6 — batch translate the current filter, into one locale or several
   * (S15). The modal counts each locale's own rows and queues ONE job for all
   * the locales picked; it stays open for a second job and links to Jobs.
   */
  protected openDraft(): void {
    this.#modal.open<LxDraftJobsModal>(LxDraftJobsModal);
  }

  /**
   * The keyboard spine (FR-3.6).
   *
   * `Cmd/Ctrl+Enter` and `Esc` are handled INSIDE the editor while it has focus,
   * and it stops propagation — so these are the bindings for when it does not,
   * and the columns-menu Escape branch below stays reachable.
   *
   * The single-letter review keys moved to the Review screen with M14. They
   * never belonged on a screen whose main surface is a table of text: `a` here
   * would be a letter somebody meant to type.
   */
  protected onKey(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key === 's') {
      event.preventDefault();
      void this.save();
      return;
    }
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      this.detail()?.focusEditor();
      return;
    }
    // Enter on the grid itself edits the selected cell in place — the binding
    // the keyboard model always promised. Only on the grid: Enter on a
    // toolbar button or a rail checkbox means that control.
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      (event.target as HTMLElement | null)?.tagName === 'LX-GRID-TABLE'
    ) {
      event.preventDefault();
      this.#session.openInline();
      return;
    }
    // The keyboard way into the right-click menu, for the selected row. Only on
    // the grid, like Enter: inside the editor these keys are the browser's.
    if (
      (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
      (event.target as HTMLElement | null)?.tagName === 'LX-GRID-TABLE'
    ) {
      event.preventDefault();
      this.table()?.openMenuForSelection();
      return;
    }
    // A multi-line editor owns ↑/↓ (the caret moves between lines); before
    // M13's second pass they ALSO moved the grid's selection under the text.
    if (isEditingSurface(event.target)) return;
    // Shift+↑/↓ marks a range of cells for a bulk action from the context
    // menu, as in a spreadsheet; the selected row travels with its far edge.
    if (event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const row = this.#selection.extend(event.key === 'ArrowDown' ? 1 : -1);
      if (row !== null) this.units.select(row);
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown') {
      this.#selection.clear();
      this.units.moveSelection(1);
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      this.#selection.clear();
      this.units.moveSelection(-1);
      event.preventDefault();
    } else if (event.key === 'PageDown') {
      this.#selection.clear();
      this.units.moveSelection(20);
      event.preventDefault();
    } else if (event.key === 'PageUp') {
      this.#selection.clear();
      this.units.moveSelection(-20);
      event.preventDefault();
    } else if (event.key === 'Escape' && this.columnsOpen()) {
      this.columnsOpen.set(false);
      event.preventDefault();
    } else if (event.key === 'Escape' && this.#selection.isMulti()) {
      this.#selection.clear();
      event.preventDefault();
    }
  }
}
