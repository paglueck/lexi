// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, input } from '@angular/core';
import { RULE_IDS, type RuleId } from '@lexi/shared/constants';
import type { Finding } from '@lexi/shared';

import { GLYPH } from '../../ui/glyphs.js';

/**
 * S11's Checks card (FR-6.11, FR-8.4).
 *
 * WHAT PASSED IS AS INFORMATIVE AS WHAT FAILED, which is why this does not just
 * list `target.findings`. A reviewer looking at a machine draft wants to know
 * that the placeholders were checked and are fine — an empty findings list
 * proves nothing on its own, because it looks identical to "nothing ran".
 *
 * So the card is a fixed list of the rules that apply to this target, each
 * either satisfied or carrying its finding. A rule that cannot say anything
 * about this particular string (there are no plurals in it) is reported as "not
 * applicable" rather than as a pass, because claiming a check passed when it
 * never ran is the one thing worse than staying quiet.
 */

/**
 * A rule as a satisfied CHECK, not as a problem.
 *
 * `RULE_TITLE` names the failure, because everywhere else in the app a rule is
 * mentioned it is because something went wrong — the dashboard counts open
 * issues, the Settings pane configures severities. Here the common case is the
 * rule PASSING, and "✓ Placeholders do not match the source" is a tick beside
 * a sentence that says the opposite. So the affirmative phrasing lives here, in
 * the one place that needs it, rather than being bent out of the other map.
 */
const RULE_PASSED: Readonly<Record<RuleId, string>> = {
  'placeholder.mismatch': 'Placeholder ids match the source',
  'placeholder.pairing': 'Opening and closing tags are paired',
  'icu.structure': 'ICU structure is intact',
  'icu.pluralCoverage': 'Every plural category this locale needs is present',
  'icu.deadCategory': 'No plural category the locale never uses',
  'target.empty': 'The target has content',
  'target.identicalToSource': 'The target is not a copy of the source',
  'whitespace.edges': 'Leading and trailing whitespace match the source',
  'punctuation.terminal': 'Terminal punctuation matches the source',
  'language.script': 'The answer is in the right script',
  'xml.wellFormed': 'No XLIFF markup lost',
  'glossary.term': 'Term base terms are used',
  'glossary.dnt': 'Do-not-translate terms are kept as they are',
};

/** The rules worth naming on the review surface, in the order S11 lists them. */
const SHOWN: readonly RuleId[] = [
  'placeholder.mismatch',
  'placeholder.pairing',
  'xml.wellFormed',
  'icu.structure',
  'icu.pluralCoverage',
  'language.script',
  'whitespace.edges',
  'punctuation.terminal',
  'target.identicalToSource',
  // Not the glossary rules: "✓ Term base terms are used" beside a string that
  // contains no term — or a project with no term base — would be a
  // tick for a check that never ran. They appear when they fire (below).
];

/** Rules that only mean something for an ICU string. */
const ICU_ONLY: ReadonlySet<RuleId> = new Set([
  'icu.structure',
  'icu.pluralCoverage',
  'icu.deadCategory',
]);

export type CheckOutcome = 'pass' | 'warning' | 'error' | 'skipped';

export interface Check {
  readonly rule: RuleId;
  readonly outcome: CheckOutcome;
  readonly label: string;
}

/**
 * Fold the findings into one row per rule. Pure and exported: "how many passed"
 * is the number a reviewer trusts, and it is worth a test rather than a glance.
 */
export function checksFor(findings: readonly Finding[], isIcu: boolean): readonly Check[] {
  const byRule = new Map<RuleId, Finding>();
  for (const f of findings) if (!byRule.has(f.rule)) byRule.set(f.rule, f);

  const rows = SHOWN.map<Check>((rule) => {
    const finding = byRule.get(rule);
    if (finding !== undefined) {
      return { rule, outcome: finding.severity, label: finding.message };
    }
    // A skipped rule is named by what it WOULD have checked, in the same
    // affirmative voice, so the card reads as one list rather than two.
    if (ICU_ONLY.has(rule) && !isIcu) {
      return { rule, outcome: 'skipped', label: `${RULE_PASSED[rule]} — no ICU in this string` };
    }
    return { rule, outcome: 'pass', label: RULE_PASSED[rule] };
  });

  // Anything the engine reported that is not in the shown list still has to
  // appear — a finding nobody sees is worse than an untidy card.
  for (const f of findings) {
    if (!SHOWN.includes(f.rule) && (RULE_IDS as readonly string[]).includes(f.rule)) {
      rows.push({ rule: f.rule, outcome: f.severity, label: f.message });
    }
  }
  return rows;
}

@Component({
  selector: 'lx-review-checks',
  template: `
    <div class="head">
      <span class="lx-caption">Checks</span>
      <span class="summary">{{ summary() }}</span>
    </div>
    <ul class="grid">
      @for (check of checks(); track check.rule) {
        <li class="check" [attr.data-outcome]="check.outcome">
          <span class="lx-badge" [attr.data-tone]="tone(check.outcome)" aria-hidden="true">{{
            glyph(check.outcome)
          }}</span>
          <span class="label">{{ check.label }}</span>
          <span class="sr-only">{{ spoken(check.outcome) }}</span>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
      padding: var(--lx-sp-14);
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-9);
      background: var(--lx-bg-rail);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-8);
      margin-bottom: var(--lx-sp-10);
    }
    .summary {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--lx-sp-8) var(--lx-sp-18);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .check {
      display: flex;
      align-items: flex-start;
      gap: var(--lx-sp-7);
      font-size: var(--lx-fs-12-5);
    }
    .label {
      color: var(--lx-text-secondary);
      line-height: var(--lx-lh-body);
    }
    .check[data-outcome='warning'] .label {
      color: var(--lx-warn);
    }
    .check[data-outcome='error'] .label {
      color: var(--lx-danger);
    }
    .check[data-outcome='skipped'] .label {
      color: var(--lx-text-faint);
    }
    @media (width <= 1100px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class LxReviewChecks {
  readonly findings = input.required<readonly Finding[]>();
  readonly isIcu = input(false);

  protected readonly checks = computed(() => checksFor(this.findings(), this.isIcu()));

  protected readonly summary = computed(() => {
    const rows = this.checks();
    const passed = rows.filter((c) => c.outcome === 'pass').length;
    const warnings = rows.filter((c) => c.outcome === 'warning').length;
    const blocking = rows.filter((c) => c.outcome === 'error').length;
    return `${passed} passed · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} · ${blocking} blocking`;
  });

  protected tone(outcome: CheckOutcome): string {
    if (outcome === 'error') return 'danger';
    if (outcome === 'warning') return 'warn';
    if (outcome === 'skipped') return 'neutral';
    return 'accent';
  }

  protected glyph(outcome: CheckOutcome): string {
    if (outcome === 'error' || outcome === 'warning') return GLYPH.error;
    if (outcome === 'skipped') return GLYPH.state.untranslated;
    return GLYPH.state.reviewed;
  }

  /** FR-3.7 again: the outcome is never carried by colour alone. */
  protected spoken(outcome: CheckOutcome): string {
    if (outcome === 'error') return ', blocking';
    if (outcome === 'warning') return ', warning';
    if (outcome === 'skipped') return ', not applicable';
    return ', passed';
  }
}
