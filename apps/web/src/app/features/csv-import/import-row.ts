// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, computed, input, output } from '@angular/core';
import type { CsvImportRow } from '@lexi/shared';

import { diffSegments } from '../review/diff-segments.js';
import { LxImportDiff } from './import-diff.js';
import { changedBy, type ImportChip } from './import-model.js';
import { LxImportStatusChip } from './import-status-chip.js';

type NoteTone = 'warn' | 'danger' | 'muted';

/**
 * One row of S16's list: include box, locale, unit id, the change from Lexi to
 * the CSV, and the status chip.
 *
 * The host is the list's option; the page owns selection, so this component
 * only draws it (`aria-selected`) and reports a click on the box. A row with a
 * box carries `aria-checked` on the option itself, so a screen reader hears
 * whether the row is included as it lands on it. The box and
 * the dimming both read off the chip, which already says whether the row will
 * be written: a change is ticked unless excluded, a conflict is ticked once it
 * is resolved to the CSV, and only a change's box answers a click.
 *
 * The column template comes from the page (`--import-cols`), so the header
 * and the rows can never disagree about where a column starts.
 */
@Component({
  selector: '[lx-import-row]',
  imports: [LxImportDiff, LxImportStatusChip],
  host: {
    '[class.dim]': 'dim()',
    '[attr.aria-checked]': 'hasBox() ? checked() : null',
  },
  template: `
    <span class="box-cell">
      @if (hasBox()) {
        <!-- The list is the one focus stop and answers Space for the selected row,
           so the box is deliberately not focusable on its own. Its state is
           announced on the option (aria-checked on the host); the box itself
           is only the picture of it. -->
        <span
          class="box"
          aria-hidden="true"
          [class.box--on]="checked()"
          [class.box--fixed]="row().category !== 'changed'"
          (click)="onBox($event)"
        >
          @if (checked()) {
            <span class="tick" aria-hidden="true">✓</span>
          }
        </span>
      }
    </span>
    <span class="loc-cell"
      ><span class="loc lx-mono" [class.loc--invalid]="invalidLocale()">{{
        row().locale
      }}</span></span
    >
    <span class="unit lx-mono" [title]="row().unitId">{{ row().unitId }}</span>
    <div class="change">
      @if (diffable()) {
        @if (view() === 'split') {
          <div class="split">
            <lx-import-diff [parts]="parts()" view="split-old" />
            <lx-import-diff class="split__new" [parts]="parts()" view="split-new" />
          </div>
        } @else {
          <lx-import-diff [parts]="parts()" />
        }
      } @else if (row().csvText.trim() === '') {
        <div class="plain plain--empty">empty cell</div>
      } @else {
        <div class="plain">{{ row().csvText }}</div>
      }
      @if (note(); as n) {
        <div class="note" [attr.data-tone]="n.tone">{{ n.text }}</div>
      }
    </div>
    <span class="status"><lx-import-status-chip [chip]="chip()" /></span>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: var(--import-cols);
      gap: var(--lx-sp-12);
      align-items: start;
      padding: var(--lx-sp-10) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-row);
      cursor: pointer;
    }
    :host([aria-selected='true']) {
      background: var(--lx-bg-selected);
      box-shadow: var(--lx-ring-selected);
    }
    :host(.dim) {
      opacity: 0.55;
    }
    .box-cell {
      padding-top: var(--lx-sp-2);
    }
    .box {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-4);
      color: var(--lx-accent-on);
    }
    .box--fixed {
      cursor: default;
    }
    .box--on {
      border-color: var(--lx-accent);
      background: var(--lx-accent);
    }
    .tick {
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
      line-height: 1;
    }
    .loc {
      padding: 1px 5px;
      border-radius: var(--lx-r-3);
      background: var(--lx-bg-raised);
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-10-5);
    }
    .loc--invalid {
      color: var(--lx-danger-on-tint);
    }
    .unit {
      padding-top: var(--lx-sp-2);
      overflow: hidden;
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .change {
      min-width: 0;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-13);
      line-height: var(--lx-lh-loose);
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--lx-sp-14);
    }
    .split__new {
      padding-left: var(--lx-sp-14);
      border-left: 1px solid var(--lx-border-section);
    }
    .plain {
      color: var(--lx-text-muted);
      overflow-wrap: anywhere;
    }
    .plain--empty {
      color: var(--lx-text-faint);
      font-style: italic;
    }
    .note {
      margin-top: var(--lx-sp-2);
      font-size: var(--lx-fs-11-5);
    }
    .note[data-tone='warn'] {
      color: var(--lx-warn-body-text);
    }
    .note[data-tone='danger'] {
      color: var(--lx-danger-on-tint);
    }
    .note[data-tone='muted'] {
      color: var(--lx-text-subtle);
    }
  `,
})
export class LxImportRow {
  readonly row = input.required<CsvImportRow>();
  readonly chip = input.required<ImportChip>();
  readonly view = input<'inline' | 'split'>('inline');
  /** A locale the project does not have (`tr-TR`), drawn in the error colour. */
  readonly invalidLocale = input(false, { transform: booleanAttribute });
  /** The box was clicked on a change; the page decides whether that still counts. */
  readonly includeToggle = output<void>();

  protected readonly hasBox = computed(
    () => this.row().category === 'changed' || this.row().category === 'conflict',
  );
  protected readonly checked = computed(() => {
    const chip = this.chip();
    return chip !== 'excluded' && chip !== 'decide' && chip !== 'keepCurrent';
  });
  protected readonly dim = computed(
    () => this.chip() === 'excluded' || this.chip() === 'keepCurrent',
  );

  /**
   * A diff needs both sides. Changes and conflicts always have them (C may be
   * empty: a cell translated for the first time reads as all added); a blocked
   * row has them only when the unit exists and its CSV text parsed. Everything
   * else shows the CSV text as written.
   */
  protected readonly diffable = computed(() => {
    const row = this.row();
    if (row.category === 'changed' || row.category === 'conflict') return true;
    return row.category === 'blocked' && row.current !== null && row.csv !== null;
  });

  /** Changes and conflicts read C → V, in the list as in the inline column. */
  protected readonly parts = computed(() =>
    diffSegments(this.row().current ?? [], this.row().csv ?? [], { groups: true, tidy: true }),
  );

  /**
   * The line under the text. Warnings only on rows that will be written:
   * the server's checks are not run on a row that never reached a cell, so
   * on any other row they would claim something nobody checked.
   */
  protected readonly note = computed<{ text: string; tone: NoteTone } | null>(() => {
    const row = this.row();
    switch (row.category) {
      case 'changed':
        return row.warnings.length > 0 ? { text: row.warnings.join(' · '), tone: 'warn' } : null;
      case 'conflict':
        return {
          // Without a known author the line ends at the fact; "edited in
          // Lexi" would only repeat it.
          text: [
            ...row.warnings,
            row.currentChangedBy === null
              ? 'Changed in Lexi after export'
              : `Changed in Lexi after export, ${changedBy(row)}`,
          ].join(' · '),
          tone: 'warn',
        };
      case 'blocked':
        return row.reason === null ? null : { text: row.reason, tone: 'danger' };
      case 'skipped':
        return row.reason === null ? null : { text: row.reason, tone: 'muted' };
      default:
        return null;
    }
  });

  protected onBox(event: Event): void {
    // A click on the box is not a click on the row: it must not move the selection.
    event.stopPropagation();
    if (this.row().category === 'changed') this.includeToggle.emit();
  }
}
