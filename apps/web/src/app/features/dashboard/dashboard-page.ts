// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { GridFilter, LocaleSummary, ProjectHealth, RuleIssue } from '@lexi/shared';
import type { RuleId } from '@lexi/shared/constants';

import { EventsStore } from '../../core/stores/events-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SaveStore } from '../../core/stores/save-store.js';
import { RULE_TITLE } from '../../core/rule-titles.js';
import { GLYPH, LxBadge, LxButton, LxStackedBar, type BarSegment } from '../../ui/index.js';

/**
 * S3 — the dashboard (M7).
 *
 * Its one job is G2: answer "what is missing in locale X" in under five
 * seconds. Everything on it is derived from `GET /api/project`, which
 * recomputes the counters from the row model on every call — so an edit in the
 * grid moves these figures with no invalidation path in between, and a figure
 * here can never disagree with the cell it came from.
 *
 * Two deliberate departures from the mock, both recorded in the plan:
 *
 * - The **re-hash reconciliation card** is omitted. FR-2.5 is phase 2, and a card offering to review pairings that cannot be
 *   reviewed would be a lie in the most load-bearing place on the screen.
 * - The coverage table's quick action reads "140 untranslated →" and opens the
 *   grid, where the mock says "Draft 140". There is no model to draft with
 *   until M8 wires the endpoint and M11 the job queue. Navigating to the work
 *   is the honest version of the same intent, and the button becomes "Draft
 *   140" when there is something behind it.
 */

interface AttentionAction {
  readonly label: string;
  readonly run: () => void;
}

interface AttentionItem {
  readonly key: string;
  readonly tone: 'danger' | 'warn' | 'neutral' | 'accent';
  readonly glyph: string;
  readonly title: string;
  readonly text: string;
  readonly action?: AttentionAction;
}

const EMPTY_HEALTH: ProjectHealth = {
  units: 0,
  unitsWithNote: 0,
  noteCoverage: 0,
  customIdUnits: 0,
  customIdShare: 0,
  errorCells: 0,
  warningCells: 0,
  staleUnits: 0,
  issues: [],
};

/** The four segments of the coverage bar, in the mock's order. */
const LEGEND = [
  { tone: 'accent', label: 'Reviewed & final' },
  { tone: 'warn', label: 'Machine draft' },
  { tone: 'danger', label: 'Needs review' },
  { tone: 'track', label: 'Untranslated' },
] as const;

@Component({
  selector: 'lx-dashboard-page',
  imports: [LxStackedBar, LxBadge, LxButton, RouterLink],
  templateUrl: './dashboard-page.html',
  styleUrl: './dashboard-page.css',
})
export class DashboardPage {
  readonly #router = inject(Router);
  readonly #grid = inject(GridStore);

  protected readonly project = inject(ProjectStore);
  protected readonly events = inject(EventsStore);
  protected readonly save = inject(SaveStore);

  protected readonly LEGEND = LEGEND;

  protected readonly health = computed<ProjectHealth>(
    () => this.project.project()?.health ?? EMPTY_HEALTH,
  );

  /** FR-4.4's health metric, coloured the way the mock colours it. */
  protected readonly noteTone = computed<'warn' | 'danger' | null>(() => {
    const coverage = this.health().noteCoverage;
    if (this.health().units === 0) return null;
    if (coverage < 50) return 'danger';
    return coverage < 80 ? 'warn' : null;
  });

  /**
   * FR-2.5b: a low custom-id share is the project's exposure to Angular's
   * content-hash churn, so it is amber below half and red below a fifth — the
   * one figure here that is a risk rather than a workload.
   */
  protected readonly customIdTone = computed<'warn' | 'danger' | null>(() => {
    const share = this.health().customIdShare;
    if (this.health().units === 0) return null;
    if (share < 20) return 'danger';
    return share < 50 ? 'warn' : null;
  });

  /**
   * The rail, from real data only.
   *
   * Ordered by what a person should do first: things that are broken, then
   * things that have moved underneath them, then things that are merely thin.
   * An item with no data behind it is not rendered at all — an empty rail is a
   * true statement about a healthy project, and the empty state says so.
   */
  protected readonly attention = computed<readonly AttentionItem[]>(() => {
    const health = this.health();
    const items: AttentionItem[] = [];

    for (const issue of health.issues.filter((i) => i.severity === 'error').slice(0, 3)) {
      items.push({
        key: `rule:${issue.rule}`,
        tone: 'danger',
        glyph: GLYPH.error,
        title: RULE_TITLE[issue.rule] ?? issue.rule,
        text: `${describeIssue(issue)}. These strings cannot reach Final until they are fixed.`,
        action: {
          label: 'Show in Issues',
          run: () => this.#openIssues(issue.rule, issue.locales[0]?.locale),
        },
      });
    }

    const changed = this.events.changedRelative();
    if (changed.length > 0) {
      items.push({
        key: 'files-changed',
        tone: 'neutral',
        glyph: GLYPH.retry,
        title: `${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed on disk`,
        text: unsavedWarning(this.save.unsavedCount(), changed),
        action: {
          label: this.events.reloading() ? 'Reloading…' : 'Reload',
          run: () => void this.events.reload(),
        },
      });
    }

    if (health.staleUnits > 0) {
      items.push({
        key: 'stale',
        tone: 'warn',
        glyph: GLYPH.error,
        title: `${format(health.staleUnits)} units drifted since the last open`,
        text: 'The English changed, so their translations may now say something the source no longer does.',
        action: { label: 'Show in grid', run: () => this.#openGrid(undefined, ['stale']) },
      });
    }

    const withoutNote = health.units - health.unitsWithNote;
    if (withoutNote > 0) {
      items.push({
        key: 'no-note',
        tone: 'neutral',
        glyph: GLYPH.info,
        title: `${format(withoutNote)} units have no note`,
        // FR-4.3c: the durable place for context is the template, not this app.
        text: 'Context reaches the translator and the model through the i18n attribute in the template — a note added here is overwritten by the next extraction.',
        action: { label: 'Show in grid', run: () => this.#openGrid(undefined, ['noNote']) },
      });
    }

    return items;
  });

  protected n(value: number): string {
    return format(value);
  }

  protected pct(locale: LocaleSummary): number {
    if (locale.unitCount === 0) return 0;
    return Math.round((locale.translated / locale.unitCount) * 100);
  }

  protected segments(locale: LocaleSummary): BarSegment[] {
    return [
      { value: locale.translated, tone: 'accent', label: 'Reviewed & final' },
      { value: locale.draftMachine, tone: 'warn', label: 'Machine draft' },
      { value: locale.needsReview, tone: 'danger', label: 'Needs review' },
    ];
  }

  /** The coverage table's quick action. */
  protected openUntranslated(locale: string): void {
    this.#openGrid(locale, ['untranslated']);
  }

  /**
   * The coverage table's other quick action: straight into the Review screen,
   * scoped to this locale (M14).
   *
   * An ordinary link with a query parameter, unlike `openUntranslated` — Review
   * takes its scope from the URL, so it does not have to mutate the grid's
   * saved columns and filters to be entered.
   */
  protected openReview(locale: string): void {
    void this.#router.navigate(['/review'], { queryParams: { locale } });
  }

  /**
   * FR-7.4's headline metric, aggregated across every locale — the dashboard is
   * where requirements §10 treats it as a top-line figure, not per-locale detail.
   */
  protected readonly editRate = computed(() => {
    const entries = this.project.editRate();
    const approvedClean = entries.reduce((sum, e) => sum + e.approvedClean, 0);
    const corrected = entries.reduce((sum, e) => sum + e.corrected, 0);
    const total = approvedClean + corrected;
    return {
      approvedClean,
      corrected,
      total,
      rate: total > 0 ? Math.round((approvedClean / total) * 100) : null,
    };
  });

  protected readonly editRateTone = computed<'warn' | 'danger' | null>(() => {
    const rate = this.editRate().rate;
    if (rate === null) return null;
    // Requirements §10's target: ≥ 60% after the style guides have been tuned.
    if (rate < 40) return 'danger';
    return rate < 60 ? 'warn' : null;
  });

  protected time(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime())
      ? '—'
      : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** S12, scoped to the rule and its busiest locale. Never touches the grid's persisted view. */
  #openIssues(rule: RuleId, locale: string | undefined): void {
    void this.#router.navigate(['/issues'], {
      queryParams: locale === undefined ? { rule } : { rule, locale },
    });
  }

  #openGrid(locale: string | undefined, filters: readonly GridFilter[]): void {
    if (locale !== undefined) this.#grid.focusLocale(locale, filters);
    else {
      this.#grid.clearFilters();
      for (const filter of filters) this.#grid.toggleFilter(filter);
    }
    void this.#router.navigate(['/grid']);
  }
}

const format = (value: number): string => value.toLocaleString();

/** "pl on 9 units, de on 2" — the locale is the actionable half. */
function describeIssue(issue: RuleIssue): string {
  const shown = issue.locales.slice(0, 3).map((l) => `${l.locale} on ${format(l.cells)}`);
  const rest = issue.locales.length - shown.length;
  const tail = rest > 0 ? `, and ${rest} more ${rest === 1 ? 'locale' : 'locales'}` : '';
  return `${shown.join(', ')}${tail} — ${format(issue.units)} ${
    issue.units === 1 ? 'unit' : 'units'
  } in total`;
}

/**
 * The sentence the reload banner exists for.
 *
 * A reload re-reads the files under the dirty buffer, and an edit whose unit
 * has been re-hashed away cannot survive it. Saying so before the click is the
 * difference between a warning and an apology.
 */
function unsavedWarning(unsaved: number, changed: readonly string[]): string {
  const files = changed.slice(0, 3).join(', ');
  const rest = changed.length > 3 ? `, and ${changed.length - 3} more` : '';
  if (unsaved === 0) return `${files}${rest}. Nothing of yours is unsaved.`;
  return `${files}${rest}. You have ${format(unsaved)} unsaved ${
    unsaved === 1 ? 'edit' : 'edits'
  } — any whose string no longer exists will be dropped.`;
}
