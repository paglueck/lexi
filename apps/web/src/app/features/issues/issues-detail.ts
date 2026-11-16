// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, output } from '@angular/core';
import type { IssueFinding } from '@lexi/shared';

import { IssuesStore } from '../../core/stores/issues-store.js';
import { TranslateStore } from '../../core/stores/translate-store.js';
import { LxBadge, LxButton, LxHairlineGrid, LxStateBadge } from '../../ui/index.js';
import { LxIssueText, shown, targetWithAbsent } from './shown-segments.js';

/**
 * S12's right column: the selected finding's unit, its placeholder inventory,
 * the suggested fix when there is exactly one right answer, and the other
 * findings on the same cell.
 */
@Component({
  selector: 'lx-issues-detail',
  imports: [LxBadge, LxButton, LxHairlineGrid, LxStateBadge, LxIssueText],
  template: `
    @let f = issues.selected();
    @let d = issues.detail();
    @let t = issues.target();
    @if (f && d && t) {
      <header class="head">
        <div class="head__row">
          <span class="lx-mono id">{{ f.unitId }}</span>
          <lx-state-badge [state]="t.state" [error]="hasError()" size="xs" />
          <span class="pair">{{ d.sourceLocale }} → {{ f.locale }}</span>
        </div>
        <div class="lx-mono where">
          {{ f.file }}
          @for (loc of d.locations; track $index) {
            <br />{{ loc.sourcefile }}{{ loc.linenumber === null ? '' : ':' + loc.linenumber }}
          }
        </div>
      </header>

      <div class="body">
        <section class="block">
          <span class="lx-caption">Source · {{ d.sourceLocale }}</span>
          <p class="text"><lx-issue-text [segments]="source()" /></p>
        </section>

        <section class="block">
          <span class="lx-caption" [class.cap-draft]="t.state === 'draftMachine'"
            >Target · {{ f.locale }}</span
          >
          <p
            class="text"
            [class.text--draft]="t.state === 'draftMachine'"
            [attr.dir]="t.isRtl ? 'rtl' : null"
          >
            <lx-issue-text [segments]="target()" />
          </p>
        </section>

        @if (issues.inventory().length > 0) {
          <section class="block">
            <span class="lx-caption">Placeholder inventory</span>
            <div
              class="inventory"
              lxHairlineGrid="1fr 64px 64px"
              role="table"
              aria-label="Placeholder inventory"
            >
              <div role="row" class="inv-row inv-row--head">
                <span role="columnheader">id</span><span role="columnheader">source</span
                ><span role="columnheader">target</span>
              </div>
              @for (row of issues.inventory(); track row.id) {
                <div
                  role="row"
                  class="inv-row"
                  [attr.data-mismatch]="row.source !== row.target ? 'true' : null"
                >
                  <span role="cell" class="inv-id">{{ row.id }}</span>
                  <span role="cell">{{ row.source }}</span>
                  <span role="cell" class="inv-target">{{ row.target }}</span>
                </div>
              }
            </div>
          </section>
        }

        @if (f.fix; as fix) {
          <section class="fix" aria-label="Suggested fix">
            <div class="fix__head">
              <span class="lx-caption fix__cap">Suggested fix</span>
              <span class="fix__origin">{{ fix.origin }}</span>
            </div>
            <p class="fix__why">{{ fix.explanation }}</p>
            <p class="fix__preview" [attr.dir]="t.isRtl ? 'rtl' : null">
              <lx-issue-text [segments]="preview()" />
            </p>
            <button
              type="button"
              lx-button
              variant="primary"
              class="fix__apply"
              [disabled]="issues.busy()"
              (click)="issues.applyFix()"
            >
              Apply fix <kbd>f</kbd>
            </button>
            <p class="fix__note">
              @if (t.state === 'draftMachine') {
                The unit stays a machine draft and moves to the review queue.
              } @else {
                The unit keeps its state. Nothing is written to disk until you save.
              }
            </p>
          </section>
        }

        <div class="actions">
          <button type="button" lx-button (click)="open.emit(f)">Open in grid</button>
          <button
            type="button"
            lx-button
            [disabled]="issues.busy() || translate.isRunning()"
            (click)="issues.redraft()"
          >
            {{ translate.runningFor(f.rowId, f.locale) ? 'Drafting…' : 'Re-draft' }}
          </button>
          <button
            type="button"
            lx-button
            class="ignore"
            [disabled]="issues.busy()"
            (click)="issues.ignore()"
          >
            Ignore
          </button>
        </div>

        @if (translate.confirm(); as ask) {
          <div class="confirm" role="alertdialog" aria-label="Overwrite the translation?">
            <p>This replaces a human translation with a machine draft.</p>
            <button type="button" lx-button variant="primary" size="xs" (click)="confirmRedraft()">
              Overwrite
            </button>
            <button type="button" lx-button size="xs" (click)="translate.dismissConfirm()">
              Cancel
            </button>
          </div>
        }
        @if (issues.error() ?? translate.error(); as message) {
          <p class="failed" role="alert">{{ message }}</p>
        }
      </div>

      @if (issues.others().length > 0) {
        <footer class="others">
          <span class="lx-caption">Also on this unit</span>
          @for (o of issues.others(); track $index) {
            <div class="other" [attr.data-tone]="o.severity === 'error' ? 'danger' : 'warn'">
              <lx-badge
                [tone]="o.severity === 'error' ? 'danger' : 'warn'"
                size="xs"
                aria-hidden="true"
                >!</lx-badge
              >
              <span>{{ o.message }}</span>
            </div>
          }
        </footer>
      }
    } @else if (f && issues.detailResource.isLoading()) {
      <p class="empty" aria-busy="true">Loading…</p>
    } @else if (f && issues.detailResource.error()) {
      <p class="empty" role="alert">This unit could not be loaded.</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: var(--lx-w-issues-panel);
      flex: none;
      min-height: 0;
      overflow-y: auto;
      border-left: 1px solid var(--lx-border-section);
      background: var(--lx-bg-rail);
    }
    .head {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-7);
      padding: var(--lx-sp-14) var(--lx-sp-18);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .head__row {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
    }
    .id {
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-11-5);
    }
    .pair {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .where {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-10-5);
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-16);
      padding: var(--lx-sp-16) var(--lx-sp-18);
    }
    .block {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-7);
    }
    .cap-draft {
      color: var(--lx-warn);
    }
    .text {
      margin: 0;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13-5);
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .text--draft {
      color: var(--lx-warn-on-tint-strong);
    }
    .inventory {
      border-radius: var(--lx-r-6);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-11);
    }
    .inv-row {
      display: contents;
    }
    .inv-row > span {
      padding: var(--lx-sp-6) var(--lx-sp-10);
      background: var(--lx-bg-modal-footer);
      color: var(--lx-text-muted);
    }
    .inv-row--head > span {
      background: var(--lx-bg-panel);
      color: var(--lx-text-faint);
    }
    .inv-id {
      color: var(--lx-text-secondary);
    }
    .inv-row .inv-target {
      color: var(--lx-accent-on-tint);
    }
    .inv-row[data-mismatch='true'] > span {
      background: var(--lx-danger-cell-bg);
    }
    .inv-row[data-mismatch='true'] .inv-target {
      color: var(--lx-danger);
    }
    .fix {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-14);
      border: 1px solid var(--lx-chip-border);
      border-radius: var(--lx-r-9);
      background: var(--lx-bg-panel);
    }
    .fix__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .fix__cap {
      color: var(--lx-accent-on-tint);
    }
    .fix__origin {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11);
    }
    .fix__why {
      margin: 0;
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-12-5);
      line-height: 1.5;
    }
    .fix__preview {
      margin: 0;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .fix__apply {
      justify-content: center;
      width: 100%;
    }
    .fix__apply kbd {
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-11);
      opacity: 0.7;
    }
    .fix__note {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11);
      line-height: 1.5;
    }
    .actions {
      display: flex;
      gap: var(--lx-sp-8);
    }
    .actions > button {
      flex: 1;
      justify-content: center;
    }
    .actions .ignore {
      color: var(--lx-text-subtle);
    }
    .confirm {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--lx-sp-8);
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-12);
    }
    .confirm p {
      flex-basis: 100%;
      margin: 0;
    }
    .failed {
      margin: 0;
      color: var(--lx-danger);
      font-size: var(--lx-fs-12);
    }
    .others {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-7);
      margin-top: auto;
      padding: var(--lx-sp-14) var(--lx-sp-18);
      border-top: 1px solid var(--lx-border-row);
    }
    .other {
      display: flex;
      align-items: baseline;
      gap: var(--lx-sp-8);
      font-size: var(--lx-fs-12);
      line-height: 1.5;
    }
    .other[data-tone='warn'] {
      color: var(--lx-warn-body-text);
    }
    .other[data-tone='danger'] {
      color: var(--lx-danger-on-tint);
    }
    .empty {
      margin: 0;
      padding: var(--lx-sp-28) var(--lx-sp-18);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
  `,
})
export class LxIssuesDetail {
  protected readonly issues = inject(IssuesStore);
  protected readonly translate = inject(TranslateStore);

  /** "Open in grid". The page owns navigation. */
  readonly open = output<IssueFinding>();

  protected readonly source = computed(() => shown(this.issues.detail()?.source ?? []));

  protected readonly target = computed(() => {
    const f = this.issues.selected();
    const t = this.issues.target();
    if (f === undefined || t === undefined) return [];
    // A pending draft may already differ from what the finding was computed
    // against; draw what the cell holds, and mark only what the finding names.
    return targetWithAbsent(t.segments, f);
  });

  protected readonly preview = computed(() => {
    const fix = this.issues.selected()?.fix;
    return fix
      ? shown(fix.segments, { changed: new Set(fix.changed), changedTone: 'accepted' })
      : [];
  });

  protected readonly hasError = computed(() =>
    (this.issues.target()?.findings ?? []).some((x) => x.severity === 'error'),
  );

  protected async confirmRedraft(): Promise<void> {
    await this.translate.confirmOverwrite();
    this.issues.reload();
  }
}
