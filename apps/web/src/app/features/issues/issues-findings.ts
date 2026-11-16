// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { IssueFinding } from '@lexi/shared';
import { ISSUE_GROUPINGS, isRtlLocale, type IssueGrouping } from '@lexi/shared/constants';

import { RULE_DESCRIPTION, RULE_NAME } from '../../core/rule-titles.js';
import { IssuesColumnsStore, type IssueColumn } from '../../core/stores/issues-columns-store.js';
import { dragColumn } from '../../ui/column-drag.js';
import { IssuesStore, findingKey, findingSummary } from '../../core/stores/issues-store.js';
import { LxBadge, LxButton, LxIcon, STATE_LABEL } from '../../ui/index.js';
import { LxMenu } from '../../ui/menu.js';
import { LxIssueText, shown, type ShownSegment } from './shown-segments.js';

const GROUPING_LABEL: Readonly<Record<IssueGrouping, string>> = {
  file: 'file',
  locale: 'locale',
  none: 'none',
};

/**
 * S12's centre column: the selected rule's header, its findings grouped by
 * file, and FR-8.4's notice. The list is one focus stop naming the selected
 * finding through `aria-activedescendant`, like the grid.
 */
@Component({
  selector: 'lx-issues-findings',
  imports: [LxBadge, LxButton, LxIcon, LxMenu, LxIssueText],
  template: `
    @let rule = issues.rule();
    @let summary = issues.ruleSummary();
    @if (rule !== null && summary) {
      <header class="head">
        <div class="head__row">
          <h2 class="head__name">{{ ruleName() }}</h2>
          <lx-badge [tone]="summary.severity === 'error' ? 'danger' : 'warn'" size="xs">{{
            summary.severity
          }}</lx-badge>
          <span class="head__count">
            {{ issues.findings().length }}
            {{ issues.findings().length === 1 ? 'finding' : 'findings' }} ·
            {{ issues.localeCount() }} {{ issues.localeCount() === 1 ? 'locale' : 'locales' }}
          </span>
          <span class="lx-spacer"></span>
          <div class="group">
            <button
              type="button"
              lx-button
              size="xs"
              aria-haspopup="menu"
              [attr.aria-expanded]="groupOpen()"
              (click)="groupOpen.set(!groupOpen())"
            >
              Group by <span class="group__value">{{ groupLabel() }}</span>
              <lx-icon name="chevron-down" [size]="12" />
            </button>
            @if (groupOpen()) {
              <div
                class="menu"
                lxMenu
                aria-label="Group findings by"
                (lxMenuClose)="groupOpen.set(false)"
              >
                @for (g of groupings; track g) {
                  <button
                    type="button"
                    role="menuitemradio"
                    class="menuitem"
                    [attr.aria-checked]="issues.grouping() === g"
                    (click)="setGrouping(g)"
                  >
                    {{ g }}
                  </button>
                }
              </div>
            }
          </div>
          @if (issues.fixableCount() > 0) {
            <button
              type="button"
              lx-button
              size="xs"
              [disabled]="issues.busy()"
              (click)="issues.applyAll()"
            >
              Apply {{ issues.fixableCount() }} suggested
              {{ issues.fixableCount() === 1 ? 'fix' : 'fixes' }}
            </button>
          }
        </div>
        <p class="head__desc">
          {{ description() }}
          @if (summary.severity === 'error') {
            Units with this error cannot reach Final.
          }
        </p>
      </header>

      <div class="table">
        <!-- Pointer-only grab zones on each header's right border, as in the grid. -->
        <div class="cols" aria-hidden="true">
          <span></span>
          @for (col of columns; track col.label) {
            <span class="h">
              {{ col.label }}
              @if (col.key !== null) {
                <span
                  class="resizer"
                  title="Drag to resize · double-click to reset"
                  [attr.data-active]="resizing() === col.key ? 'true' : null"
                  (pointerdown)="startResize($event, col.key)"
                  (dblclick)="widths.reset(col.key)"
                ></span>
              }
            </span>
          }
        </div>

        <div
          #list
          class="list"
          role="listbox"
          tabindex="0"
          [attr.aria-label]="ruleName() + ' findings'"
          [attr.aria-activedescendant]="activeId()"
        >
          @for (group of issues.groups(); track group.label) {
            @if (group.label !== '') {
              <div class="grouphead" role="presentation">
                {{ group.label }} <span class="grouphead__n">· {{ group.findings.length }}</span>
              </div>
            }
            @for (f of group.findings; track key(f)) {
              @let i = indexOf(f);
              <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus --
                 aria-activedescendant: the listbox is the one focus stop and the
                 page answers its keys, so an option is deliberately not focusable. -->
              <div
                class="row"
                role="option"
                [id]="optionId(i)"
                [attr.aria-selected]="i === issues.selectedIndex()"
                [attr.data-machine]="f.state === 'draftMachine' ? 'true' : null"
                (click)="issues.select(i)"
                (dblclick)="open.emit(f)"
              >
                <lx-badge
                  [tone]="f.severity === 'error' ? 'danger' : 'warn'"
                  size="xs"
                  aria-hidden="true"
                  >!</lx-badge
                >
                <span class="unit lx-mono" [title]="f.unitId">{{ f.unitId }}</span>
                <span class="excerpt" [attr.dir]="rtl(f) ? 'rtl' : null"
                  ><lx-issue-text [segments]="excerpt(f)" size="panel"
                /></span>
                <span class="finding">{{ summaryOf(f) }}</span>
                <span class="state">{{ stateLabel(f) }}</span>
              </div>
            }
          } @empty {
            <p class="empty">No open findings for this rule.</p>
          }
        </div>
      </div>
    } @else if (issues.isLoading()) {
      <p class="empty" aria-busy="true">Loading…</p>
    } @else {
      <p class="empty">No open findings. Last validated {{ validatedText() }}.</p>
    }

    @if (errorCount() > 0) {
      <div class="notice">
        <lx-badge tone="danger" size="xs" aria-hidden="true">!</lx-badge>
        <span>
          Saving is allowed with {{ errorCount() }}
          {{ errorCount() === 1 ? 'error' : 'errors' }} open. The affected units stay out of Final
          until the error is fixed.
        </span>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .head {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-14) var(--lx-sp-18) var(--lx-sp-12);
      border-bottom: 1px solid var(--lx-border-section);
      background: var(--lx-bg-panel);
    }
    .head__row {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
    }
    .head__name {
      margin: 0;
      font-size: var(--lx-fs-15);
      font-weight: var(--lx-fw-600);
    }
    .head__count {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .head__desc {
      margin: 0;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12);
      line-height: 1.5;
    }
    .group {
      position: relative;
    }
    .group__value {
      color: var(--lx-text-secondary);
    }
    .menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      min-width: 120px;
      padding: var(--lx-sp-4);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
    }
    .menuitem {
      padding: var(--lx-sp-4) var(--lx-sp-8);
      border-radius: var(--lx-r-5);
      background: transparent;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      text-align: left;
    }
    .menuitem:hover,
    .menuitem[aria-checked='true'] {
      background: var(--lx-bg-selected);
    }
    /* Header and list scroll together, both ways; the header sticks. */
    .table {
      flex: 1;
      min-height: 0;
      overflow: auto;
      /* Arrowing up must not park the selected row under the sticky header. */
      scroll-padding-top: 32px;
    }
    .cols,
    .row {
      display: grid;
      grid-template-columns: var(--lx-issues-cols);
      gap: var(--lx-sp-12);
      align-items: center;
      /* Never narrower than the columns need, so a narrow pane scrolls the
         table sideways rather than crushing the target below its minimum. */
      min-width: var(--lx-issues-min);
      box-sizing: border-box;
    }
    .cols {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 0 var(--lx-sp-18);
      border-bottom: 1px solid var(--lx-border-section);
      background: var(--lx-bg-app);
      color: var(--lx-text-faint);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-10);
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    /* The padding sits on the cell, not the row, so the grab zone below
       spans the header's full height without leaving the cell. */
    .h {
      position: relative;
      min-width: 0;
      padding: var(--lx-sp-8) 0;
      overflow: hidden;
      white-space: nowrap;
    }
    /* The grab zone sits over the column gap, as the grid's does over its border. */
    .resizer {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 7px;
      cursor: col-resize;
      touch-action: none;
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
    .list {
      outline: none;
    }
    .grouphead {
      position: sticky;
      left: 0;
      width: fit-content;
    }
    .row > lx-badge {
      justify-self: start;
    }
    .list:focus-visible .row[aria-selected='true'] {
      outline: 1px solid var(--lx-accent);
      outline-offset: -1px;
    }
    .grouphead {
      padding: var(--lx-sp-14) var(--lx-sp-18) var(--lx-sp-6);
      color: var(--lx-text-subtle);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-10-5);
    }
    .grouphead__n {
      color: var(--lx-text-faint-2);
    }
    .row {
      padding: var(--lx-sp-10) var(--lx-sp-18);
      border-bottom: 1px solid var(--lx-border-row);
      cursor: default;
    }
    .row:hover {
      background: var(--lx-bg-field);
    }
    .row[aria-selected='true'] {
      background: var(--lx-bg-selected);
      box-shadow: var(--lx-ring-selected);
    }
    .unit {
      overflow: hidden;
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row[aria-selected='true'] .unit {
      color: var(--lx-accent-on-tint);
    }
    .excerpt {
      overflow: hidden;
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-12-5);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row[data-machine='true'] .excerpt,
    .row[data-machine='true'] .state {
      color: var(--lx-warn-body-text);
    }
    .finding {
      overflow: hidden;
      color: var(--lx-danger-on-tint);
      font-size: var(--lx-fs-12);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11-5);
    }
    .empty {
      margin: 0;
      padding: var(--lx-sp-28) var(--lx-sp-18);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
    .notice {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-10) var(--lx-sp-18);
      border-top: 1px solid var(--lx-border-section);
      background: var(--lx-bg-panel);
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-12);
    }
  `,
})
export class LxIssuesFindings {
  protected readonly issues = inject(IssuesStore);
  protected readonly widths = inject(IssuesColumnsStore);
  protected readonly groupings = ISSUE_GROUPINGS;
  /** `key: null` is the target, which flexes rather than being dragged. */
  protected readonly columns: readonly { key: IssueColumn | null; label: string }[] = [
    { key: 'unit', label: 'Unit' },
    { key: null, label: 'Target' },
    { key: 'finding', label: 'Finding' },
    { key: 'state', label: 'State' },
  ];
  /** The column being dragged, which keeps its border lit while the pointer wanders off it. */
  protected readonly resizing = signal<IssueColumn | null>(null);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly groupOpen = signal(false);

  /** Double-click, like ↵: open the unit in the grid. The page decides how. */
  readonly open = output<IssueFinding>();

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  protected readonly ruleName = computed(() => {
    const rule = this.issues.rule();
    return rule === null ? '' : RULE_NAME[rule];
  });
  protected readonly description = computed(() => {
    const rule = this.issues.rule();
    return rule === null ? '' : RULE_DESCRIPTION[rule];
  });
  protected readonly groupLabel = computed(() => GROUPING_LABEL[this.issues.grouping()]);
  protected readonly errorCount = computed(() => this.issues.summary()?.errors ?? 0);
  protected readonly activeId = computed(() => {
    const i = this.issues.selectedIndex();
    return i < 0 ? null : this.optionId(i);
  });
  protected readonly validatedText = computed(() =>
    timeOf(this.issues.summary()?.validatedAt ?? 0),
  );

  /** Index lookup by identity, built once per list rather than per row. */
  readonly #indexByKey = computed(
    () => new Map(this.issues.findings().map((f, i) => [findingKey(f), i])),
  );

  constructor() {
    // One declaration of the geometry, on the host, so the header and every row
    // read the same value. `setProperty` rather than a style binding, which does
    // not apply a custom property (the grid found this the hard way).
    effect(() => {
      const host = this.#host.nativeElement.style;
      host.setProperty('--lx-issues-cols', this.widths.tracks());
      host.setProperty('--lx-issues-min', `${this.widths.minWidth()}px`);
    });

    // Keep the selected row in view when the keyboard moves it.
    effect(() => {
      const id = this.activeId();
      const list = this.list()?.nativeElement;
      if (id === null || list === undefined) return;
      const row = list.querySelector<HTMLElement>(`#${id}`);
      row?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  protected startResize(event: PointerEvent, column: IssueColumn): void {
    if (event.button !== 0) return;
    event.preventDefault(); // no text selection while dragging
    event.stopPropagation();
    this.resizing.set(column);
    dragColumn(
      event,
      this.widths.width(column),
      (px) => this.widths.setWidth(column, px),
      () => this.resizing.set(null),
    );
  }

  focus(): void {
    this.list()?.nativeElement.focus();
  }

  protected key(f: IssueFinding): string {
    return findingKey(f);
  }

  protected indexOf(f: IssueFinding): number {
    return this.#indexByKey().get(findingKey(f)) ?? -1;
  }

  protected optionId(i: number): string {
    return `issue-finding-${i}`;
  }

  protected setGrouping(g: IssueGrouping): void {
    this.issues.grouping.set(g);
    this.groupOpen.set(false);
  }

  protected excerpt(f: IssueFinding): ShownSegment[] {
    return shown(f.excerpt, { danger: new Set(f.placeholders?.unexpected ?? []) });
  }

  protected summaryOf(f: IssueFinding): string {
    return findingSummary(f);
  }

  protected stateLabel(f: IssueFinding): string {
    return STATE_LABEL[f.state];
  }

  protected rtl(f: IssueFinding): boolean {
    return isRtlLocale(f.locale);
  }
}

/** "14:09", or "never" before the first build. */
export function timeOf(epochMs: number): string {
  if (epochMs <= 0) return 'never';
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
