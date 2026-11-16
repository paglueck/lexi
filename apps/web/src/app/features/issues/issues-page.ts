// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, effect, inject, viewChild, type OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import type { IssueFinding } from '@lexi/shared';
import { RULE_IDS, type RuleId } from '@lexi/shared/constants';

import { ChromeStore } from '../../core/stores/chrome-store.js';
import { IssuesStore, type IssuesScope } from '../../core/stores/issues-store.js';
import { isTypingTarget } from '../../core/is-typing-target.js';
import { LxIssuesDetail } from './issues-detail.js';
import { LxIssuesFindings } from './issues-findings.js';
import { LxIssuesRules } from './issues-rules.js';

/**
 * S12, Issues (FR-8.3, FR-8.4): pick a rule, work down its findings, fix in
 * place or jump to the unit in the grid.
 *
 * The scope comes from the query string (`?rule=&locale=&rowId=`), like
 * Review's, so the dashboard, the grid's detail panel and a pasted link all
 * land on the same finding, and opening this screen never touches the grid's
 * persisted columns or filters.
 *
 * The handoff draws its own 32 px shortcut bar under the findings. The app
 * already has one full-bleed status bar (deviation 1), so the shortcuts go
 * there instead of into a second bar.
 */
@Component({
  selector: 'lx-issues-page',
  imports: [LxIssuesRules, LxIssuesFindings, LxIssuesDetail],
  host: {
    '(keydown)': 'onKey($event)',
  },
  template: `
    <lx-issues-rules />
    <lx-issues-findings (open)="openInGrid($event)" />
    @if (issues.selected()) {
      <lx-issues-detail (open)="openInGrid($event)" />
    }
    @if (issues.loadError(); as message) {
      <p class="failed" role="alert">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .failed {
      position: absolute;
      right: var(--lx-sp-16);
      bottom: var(--lx-sp-16);
      margin: 0;
      padding: var(--lx-sp-8) var(--lx-sp-12);
      border: 1px solid var(--lx-danger-tint-border);
      border-radius: var(--lx-r-7);
      background: var(--lx-danger-cell-bg);
      color: var(--lx-danger);
      font-size: var(--lx-fs-12);
    }
  `,
})
export class IssuesPage implements OnDestroy {
  protected readonly issues = inject(IssuesStore);
  readonly #chrome = inject(ChromeStore);
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);

  private readonly findings = viewChild(LxIssuesFindings);

  readonly #params = toSignal(this.#route.queryParamMap, { initialValue: null });

  constructor() {
    this.issues.setActive(true);

    effect(() => {
      this.issues.enter(scopeFrom(this.#params()));
    });

    effect(() => {
      const s = this.issues.summary();
      this.#chrome.setLeft(
        s === undefined
          ? []
          : [
              { text: `${s.errors} errors` },
              { text: `${s.warnings} warnings` },
              { text: `${s.ignored} ignored` },
            ],
      );
    });
    // In an effect, like Review's: the previous screen's reset can land after
    // this constructor, and would wipe a value set here directly.
    effect(() => {
      this.#chrome.setRight([
        { key: '↑↓', text: 'move' },
        { key: 'f', text: 'apply fix' },
        { key: '↵', text: 'open in grid' },
        { key: 'i', text: 'ignore' },
        { key: '[ ]', text: 'previous / next rule' },
      ]);
    });

    // The list is the one focus stop the keys act on.
    effect(() => {
      if (this.issues.findings().length > 0) queueMicrotask(() => this.#focusListIfIdle());
    });
  }

  ngOnDestroy(): void {
    this.issues.setActive(false);
    this.#chrome.reset();
  }

  /**
   * Open the unit in the grid with its target cell selected. Through the URL,
   * so the grid decides how to make the row visible (`UnitsStore.reveal`).
   */
  protected openInGrid(finding: IssueFinding): void {
    void this.#router.navigate(['/grid'], {
      queryParams: { row: finding.rowId, locale: finding.locale },
    });
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    // A menu or a button handles its own keys.
    const target = event.target as HTMLElement | null;
    if (target?.closest('[role="menu"]')) return;

    const selected = this.issues.selected();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.issues.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.issues.move(-1);
        break;
      case 'Enter':
        if (target?.tagName === 'BUTTON' || target?.tagName === 'A') return;
        if (selected !== undefined) {
          event.preventDefault();
          this.openInGrid(selected);
        }
        break;
      case 'f':
        if (selected?.fix) {
          event.preventDefault();
          void this.issues.applyFix();
        }
        break;
      case 'i':
        if (selected !== undefined) {
          event.preventDefault();
          void this.issues.ignore();
        }
        break;
      case '[':
        event.preventDefault();
        this.issues.stepRule(-1);
        break;
      case ']':
        event.preventDefault();
        this.issues.stepRule(1);
        break;
    }
  }

  #focusListIfIdle(): void {
    const active = document.activeElement;
    if (active === null || active === document.body) this.findings()?.focus();
  }
}

/** The scope, read off the query string. Exported for the spec. */
export function scopeFrom(params: { get(name: string): string | null } | null): IssuesScope {
  const rule = params?.get('rule') ?? null;
  return {
    rule: rule !== null && (RULE_IDS as readonly string[]).includes(rule) ? (rule as RuleId) : null,
    locale: params?.get('locale') ?? null,
    rowId: params?.get('rowId') ?? null,
  };
}
