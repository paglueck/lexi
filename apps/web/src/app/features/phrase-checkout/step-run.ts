// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';

import { count, shortPath } from '../../core/format-time.js';
import {
  PhraseCheckoutStore,
  noteOf,
  type RunRowState,
} from '../../core/stores/phrase-checkout-store.js';

const MARK: Record<RunRowState, string> = {
  pending: '·',
  running: '›',
  waiting: '›',
  done: '✓',
  failed: '×',
};

/** S18 step 4: what will happen, then the six log rows while it happens. */
@Component({
  selector: 'lx-step-run',
  template: `
    <div class="panel">
      @for (row of summary(); track row.label) {
        <div class="sum">
          <span class="sum__label">{{ row.label }}</span>
          <span class="sum__value">
            <span class="sum__main" [class.sum__main--line]="row.oneLine" [attr.title]="row.title">
              {{ row.value }}
            </span>
            <span class="sum__meta">{{ row.meta }}</span>
          </span>
        </div>
      }
    </div>

    @if (store.phase() !== 'idle') {
      <ol class="log" aria-label="Checkout progress" aria-live="polite">
        @for (row of store.runRows(); track row.step) {
          @let failed = row.step === store.failedRow();
          @let state = failed ? 'failed' : row.state;
          <li class="log__row" [attr.data-state]="state">
            <span class="log__mark mono" aria-hidden="true">{{ MARK[state] }}</span>
            <span class="log__label">{{ row.label }}</span>
            <span class="log__detail mono">
              {{ failed && store.runError() ? store.runError() : row.detail }}
            </span>
          </li>
        }
      </ol>
    }

    @if (store.result(); as result) {
      <div class="done" role="status">
        <p class="done__text">
          {{ count(result.keys) }} keys from {{ from() }} are now a local project with
          {{ xliffCount() }} XLIFF files.
        </p>
        <p class="done__path mono">{{ short(result.path) }}</p>
      </div>
    }

    @if (store.phase() === 'failed') {
      <p class="error" role="alert">
        Nothing was left behind: the partly written folder was removed. Retry, or go back and change
        the picks.
      </p>
    }
  `,
  styleUrls: ['./checkout-shared.css'],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-20);
      max-width: 820px;
    }
    .sum {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr);
      gap: var(--lx-sp-16);
      padding: var(--lx-sp-12) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .sum:last-child {
      border-bottom: 0;
    }
    .sum__label {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12);
    }
    .sum__value {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-3);
      min-width: 0;
    }
    .sum__main {
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
      font-weight: var(--lx-fw-600);
      overflow-wrap: anywhere;
    }
    .sum__main--line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sum__meta {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .log {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .log__row {
      display: grid;
      grid-template-columns: 20px 260px minmax(0, 1fr);
      gap: var(--lx-sp-10);
      align-items: baseline;
      padding: var(--lx-sp-6) var(--lx-sp-4);
    }
    .log__mark {
      color: var(--lx-neutral-border-strong);
      font-size: var(--lx-fs-12);
    }
    .log__label {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-13);
    }
    .log__detail {
      color: var(--lx-neutral-border-strong);
      font-size: var(--lx-fs-11-5);
      overflow-wrap: anywhere;
    }
    .log__row:not([data-state='pending']) .log__label {
      color: var(--lx-text-primary);
    }
    .log__row:not([data-state='pending']) .log__detail {
      color: var(--lx-text-subtle);
    }
    .log__row[data-state='done'] .log__mark {
      color: var(--lx-accent);
    }
    .log__row[data-state='running'] .log__mark,
    .log__row[data-state='waiting'] .log__mark {
      color: var(--lx-warn);
    }
    .log__row[data-state='failed'] .log__mark,
    .log__row[data-state='failed'] .log__label,
    .log__row[data-state='failed'] .log__detail {
      color: var(--lx-danger);
    }
    .done {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-14) var(--lx-sp-16);
      border: 1px solid var(--lx-accent-tint-border);
      border-radius: var(--lx-r-8);
      background: var(--lx-accent-tint-bg);
    }
    .done__text {
      margin: 0;
      color: var(--lx-accent-on-tint);
      font-size: var(--lx-fs-13);
      font-weight: var(--lx-fw-600);
    }
    .done__path {
      margin: 0;
      color: var(--lx-accent-on-tint-dim);
      font-size: var(--lx-fs-11-5);
    }
  `,
})
export class LxStepRun {
  protected readonly store = inject(PhraseCheckoutStore);
  protected readonly MARK = MARK;
  protected readonly count = count;

  protected readonly summary = computed(() => {
    const token = this.store.token();
    const project = this.store.project();
    const detail = this.store.detail();
    const scope = this.store.scope();
    const base = this.store.baseLocale();
    const targets = this.store.selectedLocales();
    const tags = scope?.kind === 'tags' ? scope.tags.join(', ') : null;
    const rows: {
      label: string;
      value: string;
      meta: string;
      oneLine?: boolean;
      title?: string | null;
    }[] = [
      {
        label: 'Phrase account',
        value: token === null ? '' : noteOf(token),
        meta: [token?.org, token?.region].filter(Boolean).join(' · '),
      },
      {
        label: 'Project',
        value: project?.name ?? '',
        meta: detail === null ? '' : `${base} → ${this.store.targetLocales().length} locales`,
      },
      {
        label: 'Keys',
        value: scope === null ? '' : (tags ?? 'All keys'),
        meta: `${this.store.keysText()} keys`,
        oneLine: true,
        title: tags,
      },
      {
        label: 'Folder',
        value: shortPath(this.store.targetPath()),
        meta: `${targets.length + 1} XLIFF files: ${base} + ${targets.join(', ')}`,
      },
    ];
    return rows;
  });

  /** The done banner's source: the tag, "3 tags", or the project for all keys. */
  protected readonly from = computed(() =>
    this.store.scope()?.kind === 'all'
      ? (this.store.project()?.name ?? 'all keys')
      : this.store.scopeLabel(),
  );

  protected readonly xliffCount = computed(
    () => this.store.result()?.files.filter((f) => f.endsWith('.xlf')).length ?? 0,
  );

  protected short(path: string): string {
    return shortPath(path);
  }
}
