// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, computed, input, output } from '@angular/core';
import type { CsvImportRow, SegmentDto } from '@lexi/shared';

import { LxRadioCard, LxRadioCardGroup } from '../../ui/radio-card.js';
import { diffSegments, type DiffPart } from '../review/diff-segments.js';
import { LxImportDiff } from './import-diff.js';
import { changedBy, type ImportChip } from './import-model.js';
import { LxImportStatusChip } from './import-status-chip.js';

type Check = { readonly ok: boolean; readonly text: string };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * A version's length as the reader sees it: the text, and each placeholder
 * as the label its chip shows. Counting the CSV's `{1:…}` token syntax would
 * make an untouched placeholder look like a length change.
 */
function charCount(segments: readonly SegmentDto[]): number {
  return segments.reduce(
    (n, s) =>
      n +
      (s.k === 't'
        ? s.v.length
        : s.k === 'p'
          ? (s.equivText ?? s.id).length
          : charCount(s.children)),
    0,
  );
}

/** Every token as `same`, so a single version draws with the diff's chips and spacing. */
const plain = (segments: readonly SegmentDto[]): readonly DiffPart[] =>
  diffSegments(segments, segments, { groups: true });

/**
 * S16's right column: the selected row in full, laid out by what can be done
 * with it (README "Right column").
 *
 * - A change reads C → V across two cards, then the checks the server ran and
 *   the include toggle.
 * - A conflict shows the export E above two radio cards, each version diffed
 *   against E, because the question is which edit since the export to keep.
 * - A row that cannot be imported says why and shows the cell as written.
 *
 * Like the row, it only draws: the page owns the include set and the
 * resolutions, and decides whether a click still counts once the import is
 * applied. `readOnly` just stops it asking.
 */
@Component({
  selector: 'lx-import-detail',
  imports: [LxImportDiff, LxImportStatusChip, LxRadioCard, LxRadioCardGroup],
  template: `
    <header class="head">
      <span class="loc lx-mono">{{ row().locale }}</span>
      <span class="unit lx-mono">{{ row().unitId }}</span>
      <lx-import-status-chip class="lx-spacer" [chip]="chip()" />
    </header>
    <div class="body">
      @if (row().source; as source) {
        <section class="block">
          <span class="lx-caption">Source · {{ sourceLocale() }}</span>
          <lx-import-diff class="source" [parts]="sourceParts()" />
        </section>
      }

      @switch (row().category) {
        @case ('changed') {
          <section class="card">
            <div class="card__head">
              <span class="lx-caption">In Lexi now</span>
              <span class="count">{{ lengths().current }} chars</span>
            </div>
            <lx-import-diff class="card__text" [parts]="changeParts()" view="split-old" />
          </section>
          <section class="card card--csv">
            <div class="card__head">
              <span class="lx-caption">From CSV</span>
              <span class="count">{{ lengths().csv }} chars</span>
            </div>
            <lx-import-diff class="card__text" [parts]="changeParts()" view="split-new" />
          </section>
          <p class="stat">{{ stat() }}</p>
          <section class="checks">
            <span class="lx-caption">Checks</span>
            @for (check of checks(); track $index) {
              <div class="check" [attr.data-ok]="check.ok">
                <span class="mark lx-mono">{{ check.ok ? '✓' : '!' }}</span>
                {{ check.text }}
              </div>
            }
          </section>
          <button
            type="button"
            class="include"
            role="checkbox"
            [attr.aria-checked]="included()"
            [attr.aria-disabled]="readOnly() || null"
            (click)="onToggle()"
          >
            <span class="box" [class.box--on]="included()" aria-hidden="true">
              @if (included()) {
                ✓
              }
            </span>
            <span>Include in import</span>
            <span class="kbd lx-mono lx-spacer" aria-hidden="true">space</span>
          </button>
        }
        @case ('conflict') {
          <p class="notice">
            This unit changed in Lexi after the export.
            @if (!readOnly()) {
              Choose which version to keep.
            }
          </p>
          <section class="card card--tight">
            <span class="lx-caption">{{ exportCaption() }}</span>
            <!-- A cell the export wrote empty is a baseline too; say so rather than draw nothing. -->
            @if (exportedParts().length === 0) {
              <p class="exported exported--empty">empty</p>
            } @else {
              <lx-import-diff class="exported" [parts]="exportedParts()" />
            }
          </section>
          <lx-radio-card-group class="versions" aria-label="Version to keep">
            <lx-radio-card
              title="Use CSV"
              meta="reviewer"
              [selected]="choice() === 'csv'"
              [disabled]="readOnly()"
              (click)="choose('csv')"
            >
              <lx-import-diff class="version" [parts]="csvParts()" view="split-new" />
            </lx-radio-card>
            <lx-radio-card
              title="Keep current"
              [meta]="changedBy()"
              [selected]="choice() === 'current'"
              [disabled]="readOnly()"
              (click)="choose('current')"
            >
              <lx-import-diff class="version" [parts]="currentParts()" view="split-new" />
            </lx-radio-card>
          </lx-radio-card-group>
          <p class="footnote">Highlights show each version against the export.</p>
        }
        @default {
          <p class="reason" [attr.data-tone]="row().category === 'skipped' ? 'skipped' : 'blocked'">
            {{ row().reason }}
          </p>
          <section class="card card--tight">
            <span class="lx-caption">In CSV</span>
            @if (row().csvText.trim() === '') {
              <p class="csv csv--empty">empty cell</p>
            } @else {
              <p class="csv">{{ row().csvText }}</p>
            }
          </section>
          <p class="footnote">
            This row is left out. Fix it in the CSV and choose the file again; the other rows are
            not affected.
          </p>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-14) var(--lx-sp-18);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .loc {
      padding: 1px 5px;
      border-radius: var(--lx-r-3);
      background: var(--lx-bg-raised);
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-10-5);
    }
    .unit {
      min-width: 0;
      overflow: hidden;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-11-5);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-12);
      padding: var(--lx-sp-16) var(--lx-sp-18);
      overflow-y: auto;
    }
    .block {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
    }
    .source {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-13-5);
      line-height: var(--lx-lh-body);
    }

    /* ---- version cards ---- */
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-8);
      padding: var(--lx-sp-12) var(--lx-sp-14);
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-9);
      background: var(--lx-bg-panel);
    }
    .card--tight {
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-10) var(--lx-sp-14);
    }
    .card--csv {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-import-csv-card-bg);
    }
    .card--csv .lx-caption {
      color: var(--lx-accent-on-tint);
    }
    .card__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .count {
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint-2);
    }
    .card--csv .count {
      color: var(--lx-import-csv-count);
    }
    .card__text {
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-14);
    }
    .card--csv .card__text {
      color: var(--lx-text-primary);
    }
    .exported,
    .csv {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-13-5);
      line-height: var(--lx-lh-body);
      overflow-wrap: anywhere;
    }
    .csv {
      color: var(--lx-text-mono);
    }
    .csv--empty,
    .exported--empty {
      color: var(--lx-text-faint);
      font-style: italic;
    }
    .stat,
    .footnote {
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-tight);
      color: var(--lx-text-faint);
    }

    /* ---- checks ---- */
    .checks {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-7);
      padding-top: var(--lx-sp-4);
    }
    .check {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
      font-size: var(--lx-fs-12-5);
      color: var(--lx-accent-on-tint);
    }
    .mark {
      padding: 1px 3px;
      border: 1px solid var(--lx-accent-tint-border);
      border-radius: var(--lx-r-3);
      background: var(--lx-accent-tint-bg);
      font-size: var(--lx-fs-9);
      line-height: 1.2;
    }
    .check[data-ok='false'] {
      color: var(--lx-danger-on-tint);
    }
    .check[data-ok='false'] .mark {
      border-color: var(--lx-danger-tint-border);
      background: var(--lx-danger-tint-bg);
    }

    /* ---- include toggle ---- */
    .include {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      height: 34px;
      margin-top: var(--lx-sp-4);
      padding: 0 var(--lx-sp-12);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-panel);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      text-align: left;
    }
    .include[aria-disabled='true'] {
      cursor: default;
    }
    .include:focus-visible {
      outline: none;
      box-shadow: var(--lx-ring-focus);
    }
    .box {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      flex: none;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-4);
      color: var(--lx-accent-on);
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
      line-height: 1;
    }
    .box--on {
      border-color: var(--lx-accent);
      background: var(--lx-accent);
    }
    .kbd {
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint);
    }

    /* ---- conflict ---- */
    .notice,
    .reason {
      padding: var(--lx-sp-10) var(--lx-sp-12);
      border: 1px solid var(--lx-warn-tint-border-deep);
      border-radius: var(--lx-r-7);
      background: var(--lx-warn-tint-bg);
      color: var(--lx-warn-on-tint);
      font-size: var(--lx-fs-12);
      line-height: var(--lx-lh-tight);
    }
    .versions {
      gap: var(--lx-sp-12);
    }
    .versions lx-radio-card {
      gap: var(--lx-sp-7);
      border-color: var(--lx-border-table);
      border-radius: var(--lx-r-9);
    }
    .versions lx-radio-card[aria-checked='true'] {
      border-color: var(--lx-accent);
    }
    .versions lx-radio-card[aria-disabled='true'] {
      cursor: default;
    }
    .version {
      font-size: var(--lx-fs-13-5);
    }

    /* ---- not importable ---- */
    .reason {
      font-size: var(--lx-fs-12-5);
    }
    .reason[data-tone='blocked'] {
      border-color: var(--lx-danger-tint-border);
      background: var(--lx-danger-tint-bg);
      color: var(--lx-danger-on-tint);
    }
    .reason[data-tone='skipped'] {
      border-color: var(--lx-border-strong);
      background: var(--lx-bg-panel);
      color: var(--lx-text-mono);
    }
  `,
})
export class LxImportDetail {
  readonly row = input.required<CsvImportRow>();
  readonly chip = input.required<ImportChip>();
  readonly sourceLocale = input('');
  /** The export snapshot's time, for the conflict's "At export" card; null without one. */
  readonly exportedAt = input<string | null>(null);
  /** After Apply: the panel still shows the decisions, but no longer takes new ones. */
  readonly readOnly = input(false, { transform: booleanAttribute });
  /** The include toggle was clicked on a change. */
  readonly includeToggle = output<void>();
  /** A conflict's version was picked. */
  readonly resolve = output<'csv' | 'current'>();

  protected readonly sourceParts = computed(() => plain(this.row().source ?? []));
  protected readonly exportedParts = computed(() => plain(this.row().exported ?? []));

  /** A change reads C → V, as in the list. */
  protected readonly changeParts = computed(() =>
    diffSegments(this.row().current ?? [], this.row().csv ?? [], { groups: true, tidy: true }),
  );
  /** A conflict's two versions, each against the export: E → V and E → C. */
  protected readonly csvParts = computed(() =>
    diffSegments(this.row().exported ?? [], this.row().csv ?? [], { groups: true, tidy: true }),
  );
  protected readonly currentParts = computed(() =>
    diffSegments(this.row().exported ?? [], this.row().current ?? [], {
      groups: true,
      tidy: true,
    }),
  );

  protected readonly lengths = computed(() => ({
    current: charCount(this.row().current ?? []),
    csv: charCount(this.row().csv ?? []),
  }));

  /**
   * Counted on the untidied diff: the tidy pass merges a changed phrase into
   * one block, which is the right picture but the wrong count. A word is any
   * changed token that is not bare whitespace; a placeholder counts as one.
   */
  protected readonly stat = computed(() => {
    const raw = diffSegments(this.row().current ?? [], this.row().csv ?? [], { groups: true });
    const words = raw.filter((p) => p.token.kind !== 'text' || /\S/.test(p.token.v));
    const removed = words.filter((p) => p.op === 'removed').length;
    const added = words.filter((p) => p.op === 'added').length;
    return `${plural(removed, 'word', 'words')} removed · ${plural(added, 'word', 'words')} added`;
  });

  /**
   * The placeholder check always passes here: a row whose tokens do not match
   * is blocked and never reaches this layout. The source check is left out when
   * there was no snapshot to compare with.
   */
  protected readonly checks = computed<readonly Check[]>(() => {
    const row = this.row();
    const unchanged = row.checks.sourceUnchanged;
    return [
      { ok: true, text: 'Placeholders and markup match source' },
      ...(unchanged === null
        ? []
        : [
            {
              ok: unchanged,
              text: unchanged ? 'Source unchanged since export' : 'Source changed since export',
            },
          ]),
      ...row.warnings.map((text) => ({ ok: false, text })),
    ];
  });

  protected readonly included = computed(() => this.chip() !== 'excluded');

  /** The conflict's decision, read off the chip the page already derived. */
  protected readonly choice = computed<'csv' | 'current' | null>(() => {
    const chip = this.chip();
    if (chip === 'useCsv' || chip === 'applied') return 'csv';
    return chip === 'keepCurrent' ? 'current' : null;
  });

  protected readonly changedBy = computed(() => changedBy(this.row()));

  /** `At export · 13:14`, the time spelled like the header's baseline line. */
  protected readonly exportCaption = computed(() => {
    const at = this.exportedAt();
    if (at === null) return 'At export';
    const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `At export · ${time}`;
  });

  protected onToggle(): void {
    if (!this.readOnly()) this.includeToggle.emit();
  }

  protected choose(choice: 'csv' | 'current'): void {
    if (!this.readOnly()) this.resolve.emit(choice);
  }
}
