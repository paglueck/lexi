// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { IgnoredFinding, IssueRuleSummary } from '@lexi/shared';

import { RULE_NAME } from '../../core/rule-titles.js';
import { IssuesStore } from '../../core/stores/issues-store.js';
import { LxBadge, LxButton, LxIcon, LxStackedBar, type BarSegment } from '../../ui/index.js';

/**
 * S12's left column: how many findings are open, split by severity and
 * locale, then one row per rule. Rules with nothing open are not listed and
 * rules switched off are only counted, as the handoff asks.
 */
@Component({
  selector: 'lx-issues-rules',
  imports: [RouterLink, LxBadge, LxButton, LxIcon, LxStackedBar],
  template: `
    @let s = issues.summary();
    <div class="summary">
      <div class="total">
        <span class="total__n lx-num">{{ total() }}</span>
        <span class="total__label">open findings</span>
      </div>
      <lx-stacked-bar [segments]="bar()" [total]="total()" size="sm" />
      <div class="locales" role="group" aria-label="Locale">
        <button
          type="button"
          class="loc"
          [attr.aria-pressed]="issues.locale() === null"
          (click)="issues.setLocale(null)"
        >
          All locales
        </button>
        @for (locale of s?.locales ?? []; track locale) {
          <button
            type="button"
            class="loc"
            [attr.aria-pressed]="issues.locale() === locale"
            (click)="issues.setLocale(locale)"
          >
            {{ locale }}
          </button>
        }
      </div>
    </div>

    <div class="lists">
      @if (errors().length > 0) {
        <div class="cap cap--error">
          <span>Errors</span><span class="cap__n">{{ s?.errors ?? 0 }}</span>
        </div>
        <ul class="rules" aria-label="Error rules">
          @for (r of errors(); track r.rule) {
            <li>
              <button
                type="button"
                class="rule"
                [attr.aria-current]="r.rule === issues.rule() ? 'true' : null"
                (click)="issues.selectRule(r.rule)"
              >
                <lx-badge tone="danger" size="xs" aria-hidden="true">!</lx-badge>
                <span class="rule__name">{{ name(r) }}</span>
                <span class="rule__n lx-mono">{{ r.count }}</span>
              </button>
            </li>
          }
        </ul>
      }

      @if (warnings().length > 0) {
        <div class="cap cap--warn">
          <span>Warnings</span><span class="cap__n">{{ s?.warnings ?? 0 }}</span>
        </div>
        <ul class="rules" aria-label="Warning rules">
          @for (r of warnings(); track r.rule) {
            <li>
              <button
                type="button"
                class="rule"
                [attr.aria-current]="r.rule === issues.rule() ? 'true' : null"
                (click)="issues.selectRule(r.rule)"
              >
                <lx-badge tone="warn" size="xs" aria-hidden="true">!</lx-badge>
                <span class="rule__name">{{ name(r) }}</span>
                <span class="rule__n lx-mono">{{ r.count }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </div>

    <div class="foot">
      @if (issues.ignored(); as ignored) {
        <div class="ignored">
          <div class="ignored__head">
            <span class="lx-caption">Ignored</span>
            <button
              type="button"
              lx-button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label="Close the ignored list"
              (click)="issues.closeIgnored()"
            >
              <lx-icon name="x" [size]="12" />
            </button>
          </div>
          @for (item of ignored; track key(item)) {
            <div class="ignored__row">
              <span class="ignored__what">
                <span class="lx-mono">{{ item.unitId }}</span> · {{ item.locale }} ·
                {{ ruleName(item) }}
              </span>
              <button
                type="button"
                lx-button
                variant="ghost"
                size="xs"
                (click)="issues.unignore(item)"
              >
                Un-ignore
              </button>
            </div>
          } @empty {
            <p class="ignored__none">Nothing is ignored.</p>
          }
        </div>
      }
      <button
        type="button"
        class="foot__counts"
        (click)="toggleIgnored()"
        [attr.aria-expanded]="issues.ignored() !== null"
      >
        {{ s?.rulesOff ?? 0 }} {{ (s?.rulesOff ?? 0) === 1 ? 'rule' : 'rules' }} off ·
        {{ s?.ignored ?? 0 }} {{ (s?.ignored ?? 0) === 1 ? 'finding' : 'findings' }} ignored
      </button>
      <a class="foot__link" routerLink="/settings" [queryParams]="{ section: 'validation' }"
        >Rule severities in Settings</a
      >
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: var(--lx-w-issues-rail);
      flex: none;
      min-height: 0;
      border-right: 1px solid var(--lx-border-section);
      background: var(--lx-bg-rail);
    }
    .summary {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-14) var(--lx-sp-12) var(--lx-sp-12);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .total {
      display: flex;
      align-items: baseline;
      gap: var(--lx-sp-8);
    }
    .total__n {
      font-size: var(--lx-fs-22);
      font-weight: var(--lx-fw-600);
      letter-spacing: -0.02em;
    }
    .total__label {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12);
    }
    .locales {
      display: flex;
      flex-wrap: wrap;
      gap: var(--lx-sp-6);
    }
    .loc {
      padding: 3px var(--lx-sp-8);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-6);
      background: var(--lx-bg-field);
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-11-5);
    }
    .loc[aria-pressed='true'] {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-bg-selected);
      color: var(--lx-accent-on-tint);
    }
    .lists {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding-bottom: var(--lx-sp-8);
    }
    .cap {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--lx-sp-14) var(--lx-sp-12) var(--lx-sp-6);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-10);
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }
    .cap--error {
      color: var(--lx-danger);
    }
    .cap--warn {
      color: var(--lx-warn);
    }
    .cap__n {
      color: var(--lx-text-subtle);
      letter-spacing: 0;
    }
    .rules {
      display: flex;
      flex-direction: column;
      gap: 1px;
      margin: 0;
      padding: 0 var(--lx-sp-6);
      list-style: none;
    }
    .rule {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
      width: 100%;
      padding: var(--lx-sp-7) var(--lx-sp-8);
      border-radius: var(--lx-r-6);
      background: transparent;
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-12-5);
      text-align: left;
    }
    .rule:hover {
      background: var(--lx-bg-field);
    }
    .rule[aria-current='true'] {
      background: var(--lx-bg-selected);
      box-shadow: var(--lx-ring-selected);
      color: var(--lx-text-primary);
      font-weight: var(--lx-fw-600);
    }
    .rule__name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rule__n {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-11);
      font-weight: var(--lx-fw-400);
    }
    .rule[aria-current='true'] .rule__n {
      color: var(--lx-accent-on-tint);
    }
    .foot {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-12);
      border-top: 1px solid var(--lx-border-row);
      font-size: var(--lx-fs-11-5);
    }
    .foot__counts {
      padding: 0;
      background: none;
      color: var(--lx-text-subtle);
      text-align: left;
    }
    .foot__counts:hover {
      color: var(--lx-text-secondary);
    }
    .foot__link {
      color: var(--lx-accent);
    }
    .ignored {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-4);
      max-height: 220px;
      padding-bottom: var(--lx-sp-8);
      overflow-y: auto;
      border-bottom: 1px solid var(--lx-border-row);
    }
    .ignored__head,
    .ignored__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-6);
    }
    .ignored__what {
      min-width: 0;
      overflow: hidden;
      color: var(--lx-text-secondary);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ignored__none {
      margin: 0;
      color: var(--lx-text-faint);
    }
  `,
})
export class LxIssuesRules {
  protected readonly issues = inject(IssuesStore);

  protected readonly errors = computed(() =>
    (this.issues.summary()?.rules ?? []).filter((r) => r.severity === 'error'),
  );
  protected readonly warnings = computed(() =>
    (this.issues.summary()?.rules ?? []).filter((r) => r.severity === 'warning'),
  );
  protected readonly total = computed(() => {
    const s = this.issues.summary();
    return s === undefined ? 0 : s.errors + s.warnings;
  });
  protected readonly bar = computed<readonly BarSegment[]>(() => {
    const s = this.issues.summary();
    return [
      { value: s?.errors ?? 0, tone: 'danger', label: 'errors' },
      { value: s?.warnings ?? 0, tone: 'warn', label: 'warnings' },
    ];
  });

  protected name(r: IssueRuleSummary): string {
    return RULE_NAME[r.rule];
  }

  protected ruleName(item: IgnoredFinding): string {
    return RULE_NAME[item.rule];
  }

  protected key(item: IgnoredFinding): string {
    return `${item.rowId} ${item.locale} ${item.rule}`;
  }

  protected toggleIgnored(): void {
    if (this.issues.ignored() === null) void this.issues.loadIgnored();
    else this.issues.closeIgnored();
  }
}
