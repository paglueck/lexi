// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { ScrollingModule } from '@angular/cdk/scrolling';

import { ReviewStore } from '../../core/stores/review-store.js';
import { LxButton, LxStackedBar, LxStateBadge, type BarSegment } from '../../ui/index.js';
import { LxModalService } from '../../ui/modal.js';
import { LxBulkApproveConfirm, type BulkApproveConfirmData } from './bulk-approve-confirm.js';
import { ReviewRowsStore, type QueueRow } from './review-rows.js';

/** Roughly what fits in the rail at once; the fetch window is larger anyway. */
const VISIBLE_ROWS = 20;

/**
 * S11's left rail: the queue, its progress, and bulk accept.
 *
 * DECIDED ROWS STAY. They keep their badge, drop to half opacity and hold their
 * place, so "did I just reject the right one" is answerable by looking rather
 * than by remembering. That is why the counts here are over `ids` and `decided`
 * rather than over the rail's own length.
 */
@Component({
  selector: 'lx-review-queue',
  imports: [LxButton, LxStackedBar, LxStateBadge, ScrollingModule],
  template: `
    <div class="head">
      <div class="row">
        <span class="lx-caption">Review queue</span>
        <span class="lx-mono count">{{ review.doneCount() }} / {{ review.ids().length }} done</span>
      </div>
      <lx-stacked-bar [segments]="progress()" [total]="review.ids().length" size="sm" />
      <div class="chips">
        @if (review.locale(); as locale) {
          <span class="chip chip--scope">{{ locale }}</span>
        }
        @if (scopeLabel(); as label) {
          <span class="chip">{{ label }}</span>
        }
      </div>
      @if (review.fellBackToLocale()) {
        <p class="fellback">
          That job's run log is gone — the server restarted. Showing every open draft for this
          locale instead.
        </p>
      }
    </div>

    <cdk-virtual-scroll-viewport
      [itemSize]="ROW_HEIGHT"
      class="rows"
      (scrolledIndexChange)="onScrolled($event)"
    >
      <button
        *cdkVirtualFor="let row of rows.queue(); templateCacheSize: 0"
        type="button"
        class="qrow"
        [attr.aria-current]="row.rowId === review.selectedRowId() ? 'true' : null"
        [attr.data-decided]="row.decision ?? null"
        (click)="review.select(row.rowId)"
      >
        <lx-state-badge [state]="row.state" [error]="row.error" size="xs" />
        <span class="body">
          <span class="lx-mono id lx-truncate">{{ row.unitId }}</span>
          <span class="draft lx-truncate" dir="auto">{{ row.text || 'Empty' }}</span>
          <span class="status lx-truncate" [attr.data-tone]="row.tone">{{ row.status }}</span>
        </span>
      </button>
    </cdk-virtual-scroll-viewport>

    @if (rows.queue().length === 0) {
      <p class="empty">
        {{ review.isLoading() ? 'Loading…' : 'Nothing to review — the queue is empty.' }}
      </p>
    }

    @if (cleanIds().length > 0) {
      <div class="foot">
        <button type="button" lx-button [disabled]="review.busy()" (click)="bulkApprove()">
          Accept all clean drafts ({{ cleanIds().length }})
        </button>
        <p class="note">Bulk accept skips every draft with a warning or a validation error.</p>
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: none;
      flex-direction: column;
      width: 300px;
      min-height: 0;
      border-right: 1px solid var(--lx-border-section);
      background: var(--lx-bg-rail);
    }
    .head {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-8);
      padding: var(--lx-sp-12) var(--lx-sp-12) var(--lx-sp-10);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-8);
    }
    .count {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-10);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--lx-sp-6);
    }
    .chip {
      padding: var(--lx-sp-3) var(--lx-sp-8);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-6);
      background: var(--lx-bg-raised);
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11-5);
    }
    .chip--scope {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
      color: var(--lx-accent-on-tint);
    }
    .fellback {
      margin: 0;
      color: var(--lx-warn-body-text);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-body);
    }
    .rows {
      flex: 1;
      min-height: 0;
    }
    .qrow {
      display: flex;
      gap: var(--lx-sp-8);
      box-sizing: border-box;
      width: 100%;
      height: 68px;
      padding: var(--lx-sp-10) var(--lx-sp-12);
      border: 0;
      border-bottom: 1px solid var(--lx-border-row);
      background: none;
      text-align: left;
      cursor: pointer;
    }
    .qrow:hover {
      background: var(--lx-bg-panel);
    }
    .qrow[aria-current='true'] {
      background: var(--lx-bg-selected);
      box-shadow: inset 2px 0 0 var(--lx-accent);
    }
    .qrow[data-decided] {
      opacity: 0.5;
    }
    lx-state-badge {
      flex: none;
      margin-top: var(--lx-sp-2);
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-2);
      min-width: 0;
    }
    .id {
      /* An underscore sits on the baseline, so a tight line box clips it and
         checkout.pay_now reads as checkout.pay now. */
      line-height: 1.5;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-10-5);
    }
    .qrow[aria-current='true'] .id {
      color: var(--lx-accent-on-tint);
    }
    .draft {
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
    }
    .qrow[aria-current='true'] .draft {
      color: var(--lx-text-primary);
    }
    .status {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11);
    }
    .status[data-tone='warn'] {
      color: var(--lx-warn-body-text);
    }
    .status[data-tone='danger'] {
      color: var(--lx-danger);
    }
    .empty {
      padding: var(--lx-sp-16) var(--lx-sp-12);
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
    .foot {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      margin-top: auto;
      padding: var(--lx-sp-12);
      border-top: 1px solid var(--lx-border-row);
    }
    .foot button {
      width: 100%;
    }
    .note {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11);
      line-height: var(--lx-lh-body);
    }
  `,
})
export class LxReviewQueue {
  protected readonly review = inject(ReviewStore);
  protected readonly rows = inject(ReviewRowsStore);
  readonly #modal = inject(LxModalService);

  /**
   * Fixed-height rows and a CDK viewport, the same call the grid made and for
   * the same reason: a batch job can leave four figures of drafts behind, and
   * this rail is a way BACK to a unit rather than a reading surface — the draft
   * text is ellipsised to one line here and shown in full in the centre column.
   */
  protected readonly ROW_HEIGHT = 68;

  protected readonly progress = computed<readonly BarSegment[]>(() => [
    { value: this.review.acceptedCount(), tone: 'accent', label: 'accepted' },
    { value: this.review.rejectedCount(), tone: 'danger', label: 'rejected' },
  ]);

  /** "Batch #a1b2c3" for a job scope; nothing for a plain locale queue. */
  protected readonly scopeLabel = computed<string | null>(() => {
    const scope = this.review.scope();
    if (scope?.kind === 'job') return `Batch ${scope.jobId.slice(0, 8)}`;
    if (scope?.kind === 'unit') return 'One draft';
    return null;
  });

  /**
   * What bulk accept is allowed to touch: open rows with no finding at all.
   *
   * A warning is exactly what a reviewer is here to look at, so "accept
   * everything that is clean" must mean clean, not "clean enough".
   */
  protected readonly cleanIds = computed<readonly string[]>(() =>
    this.rows
      .queue()
      .filter((row: QueueRow) => row.decision === undefined && row.findingCount === 0)
      .map((row) => row.rowId),
  );

  /**
   * Bodies follow the rendered range, so scrolling a long queue fills it in
   * rather than leaving every row past the first window showing only its id.
   * `ensureRange` is window-aligned and de-duplicates, so firing it per scroll
   * step costs nothing.
   */
  protected onScrolled(first: number): void {
    this.rows.ensureRange(first, first + VISIBLE_ROWS);
  }

  protected bulkApprove(): void {
    const ids = this.cleanIds();
    if (ids.length === 0) return;
    const ref = this.#modal.open<LxBulkApproveConfirm, boolean>(LxBulkApproveConfirm, {
      data: {
        count: ids.length,
        locale: this.review.locale() ?? '',
      } satisfies BulkApproveConfirmData,
    });
    ref.closed.subscribe((confirmed) => {
      if (confirmed === true) void this.review.bulkApprove(ids);
    });
  }
}
