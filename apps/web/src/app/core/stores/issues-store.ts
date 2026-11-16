// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Injectable,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { httpResource } from '@angular/common/http';
import type {
  IgnoredFinding,
  IssueFinding,
  IssueFindingsResponse,
  IssuesSummary,
  SegmentDto,
  UnitDetail,
  UnitTarget,
} from '@lexi/shared';
import type { IssueGrouping, RuleId } from '@lexi/shared/constants';

import { IssuesApi } from '../api/issues-api.js';
import { messageOf } from '../api/server-message.js';
import { DraftStore } from './draft-store.js';
import { EventsStore } from './events-store.js';
import { ProjectStore } from './project-store.js';
import { resolveTarget } from './review-store.js';
import { SaveStore } from './save-store.js';
import { TranslateStore } from './translate-store.js';
import { UnitsStore, nextSelectedIndex } from './units-store.js';

/**
 * S12, the Issues screen (FR-8.3): every validation finding, grouped by rule.
 *
 * Like `ReviewStore`, this owns its own view state and takes its scope from
 * the URL (`?rule=&locale=&rowId=`), so every entry point is an ordinary link
 * and nothing here ever rewrites the grid's persisted columns or filters.
 *
 * The two reads are `httpResource`s. Stepping through rules and findings fires
 * a request per step, and only the last answer may ever be shown.
 */

export interface IssuesScope {
  readonly rule: RuleId | null;
  readonly locale: string | null;
  readonly rowId: string | null;
}

/** A finding's identity within one rule's list. */
export const findingKey = (f: Pick<IssueFinding, 'rowId' | 'locale' | 'message'>): string =>
  `${f.rowId} ${f.locale} ${f.message}`;

export interface FindingGroup {
  /** The file, the locale, or '' when not grouped. */
  readonly label: string;
  readonly findings: readonly IssueFinding[];
}

/**
 * The table's groups, in display order. Pure and exported for the spec: the
 * selection index counts across groups, so the grouping and the flat order
 * must come from the same function.
 */
export function groupFindings(
  findings: readonly IssueFinding[],
  grouping: IssueGrouping,
): FindingGroup[] {
  if (grouping === 'none') return findings.length === 0 ? [] : [{ label: '', findings }];
  const labelOf = (f: IssueFinding): string => (grouping === 'file' ? f.file : f.locale);
  const groups = new Map<string, IssueFinding[]>();
  for (const f of findings) {
    const label = labelOf(f);
    const list = groups.get(label);
    if (list === undefined) groups.set(label, [f]);
    else list.push(f);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({ label, findings: list }));
}

export interface InventoryRow {
  readonly id: string;
  readonly source: number;
  readonly target: number;
}

/**
 * S12's placeholder inventory: each id with its count in the source and in the
 * target. Source order first, then anything only the target has.
 */
export function placeholderInventory(
  source: readonly SegmentDto[],
  target: readonly SegmentDto[],
): InventoryRow[] {
  const ids = (segments: readonly SegmentDto[], into: string[] = []): string[] => {
    for (const s of segments) {
      if (s.k === 'p') into.push(s.id);
      else if (s.k === 'g') ids(s.children, into);
    }
    return into;
  };
  const count = (list: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const id of list) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  const inSource = count(ids(source));
  const inTarget = count(ids(target));
  const order = [...inSource.keys(), ...[...inTarget.keys()].filter((id) => !inSource.has(id))];
  return order.map((id) => ({ id, source: inSource.get(id) ?? 0, target: inTarget.get(id) ?? 0 }));
}

/**
 * The finding's own column, shortened: "CLOSE_LINK missing", "ICU_1 renamed to
 * ICU", "INTERPOLATION extra". Falls back to the engine's sentence for every
 * rule that has no ids to talk about.
 */
export function findingSummary(finding: Pick<IssueFinding, 'message' | 'placeholders'>): string {
  const p = finding.placeholders;
  if (p === undefined) return finding.message;
  if (p.missing.length === 1 && p.unexpected.length === 1) {
    return `${p.missing[0]} renamed to ${p.unexpected[0]}`;
  }
  const counted = (ids: readonly string[], word: string): string[] => {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts].map(([id, n]) => (n === 1 ? `${id} ${word}` : `${id} ${word} ×${n}`));
  };
  const parts = [...counted(p.missing, 'missing'), ...counted(p.unexpected, 'extra')];
  return parts.length === 0 ? finding.message : parts.join(', ');
}

@Injectable({ providedIn: 'root' })
export class IssuesStore {
  readonly #api = inject(IssuesApi);
  readonly #drafts = inject(DraftStore);
  readonly #project = inject(ProjectStore);
  readonly #save = inject(SaveStore);
  readonly #translate = inject(TranslateStore);
  readonly #units = inject(UnitsStore);
  readonly #events = inject(EventsStore);

  /** The rule the URL or the user asked for; `rule()` is what is actually shown. */
  readonly #requestedRule = signal<RuleId | null>(null);
  readonly #locale = signal<string | null>(null);
  /** A row to select once its rule's findings arrive (from `?rowId=`). */
  readonly #pendingRow = signal<string | null>(null);
  readonly #busy = signal(false);
  readonly #error = signal<string | null>(null);
  readonly #ignored = signal<readonly IgnoredFinding[] | null>(null);
  /** The Issues screen is mounted — the title bar's "Validated 14:09 · Revalidate". */
  readonly #active = signal(false);

  readonly locale = this.#locale.asReadonly();
  readonly busy = this.#busy.asReadonly();
  readonly error = this.#error.asReadonly();
  /** The footer's list of ignores, when it is open. */
  readonly ignored = this.#ignored.asReadonly();
  readonly grouping = signal<IssueGrouping>('file');
  readonly active = this.#active.asReadonly();

  readonly summaryResource = httpResource<IssuesSummary>(() => {
    if (!this.#project.isOpen()) return undefined;
    const locale = this.#locale();
    return locale === null ? '/api/issues' : `/api/issues?locale=${encodeURIComponent(locale)}`;
  });
  readonly summary = computed<IssuesSummary | undefined>(() => this.summaryResource.value());

  /** The requested rule while it still has findings, else the first rule listed. */
  readonly rule = computed<RuleId | null>(() => {
    const rules = this.summary()?.rules ?? [];
    const requested = this.#requestedRule();
    if (requested !== null && rules.some((r) => r.rule === requested)) return requested;
    return rules[0]?.rule ?? null;
  });
  readonly ruleSummary = computed(() => this.summary()?.rules.find((r) => r.rule === this.rule()));

  readonly findingsResource = httpResource<IssueFindingsResponse>(() => {
    const rule = this.rule();
    if (rule === null) return undefined;
    const locale = this.#locale();
    const qs = locale === null ? '' : `?locale=${encodeURIComponent(locale)}`;
    return `/api/issues/rules/${encodeURIComponent(rule)}${qs}`;
  });

  readonly groups = computed<readonly FindingGroup[]>(() => {
    const res = this.findingsResource.value();
    // A response for a rule we have since left is not this rule's list.
    if (res === undefined || res.rule !== this.rule()) return [];
    return groupFindings(res.findings, this.grouping());
  });

  /** Display order, across groups. The selection indexes into this. */
  readonly findings = computed<readonly IssueFinding[]>(() =>
    this.groups().flatMap((g) => g.findings),
  );
  readonly #keys = computed<readonly string[]>(() => this.findings().map(findingKey));

  readonly selectedIndex = linkedSignal<readonly string[], number>({
    source: this.#keys,
    computation: nextSelectedIndex,
  });
  readonly selected = computed<IssueFinding | undefined>(
    () => this.findings()[this.selectedIndex()],
  );

  readonly fixableCount = computed(() => this.findings().filter((f) => f.fix !== null).length);
  readonly localeCount = computed(() => new Set(this.findings().map((f) => f.locale)).size);

  /** The unit behind the selected finding, for its locale only (see ReviewStore on `?locales=`). */
  readonly detailResource = httpResource<UnitDetail>(() => {
    const f = this.selected();
    if (f === undefined) return undefined;
    return `/api/units/${encodeURIComponent(f.rowId)}?locales=${encodeURIComponent(f.locale)}`;
  });
  readonly detail = computed<UnitDetail | undefined>(() => {
    const d = this.detailResource.value();
    return d !== undefined && d.rowId === this.selected()?.rowId ? d : undefined;
  });
  readonly target = computed<UnitTarget | undefined>(() =>
    resolveTarget(this.detail(), this.selected()?.locale ?? null, (rowId, locale) =>
      this.#drafts.draftFor(rowId, locale),
    ),
  );

  readonly inventory = computed<readonly InventoryRow[]>(() =>
    placeholderInventory(this.detail()?.source ?? [], this.target()?.segments ?? []),
  );

  /** "Also on this unit": every other finding the same cell carries. */
  readonly others = computed(() => {
    const f = this.selected();
    const t = this.target();
    if (f === undefined || t === undefined) return [];
    let skipped = false;
    return t.findings.filter((other) => {
      if (!skipped && other.rule === f.rule && other.message === f.message) {
        skipped = true;
        return false;
      }
      return true;
    });
  });

  readonly isLoading = computed(
    () => this.summaryResource.isLoading() || this.findingsResource.isLoading(),
  );

  readonly loadError = computed<string | null>(() => {
    const failed: unknown = this.summaryResource.error() ?? this.findingsResource.error();
    return failed ? messageOf(failed, 'The findings could not be loaded.') : null;
  });

  constructor() {
    // A `?rowId=` entry point: select that unit's finding once its rule's list is here.
    effect(() => {
      const rowId = this.#pendingRow();
      const findings = this.findings();
      if (rowId === null || this.findingsResource.isLoading() || findings.length === 0) return;
      const locale = this.#locale();
      const at = findings.findIndex(
        (f) => f.rowId === rowId && (locale === null || f.locale === locale),
      );
      untracked(() => {
        if (at !== -1) this.selectedIndex.set(at);
        this.#pendingRow.set(null);
      });
    });

    // Pin the rule on screen once it has been chosen for the user. The list is
    // sorted by count, so a fix that leaves two rules tied would otherwise move
    // the screen to a different rule under the reviewer's hands.
    effect(() => {
      const shown = this.rule();
      if (shown !== null && this.#requestedRule() === null)
        untracked(() => this.#requestedRule.set(shown));
    });

    // A reload from disk (FR-1.5) rebuilds the row model under this screen.
    effect(() => {
      if (this.#events.reloadedAt() === 0) return;
      untracked(() => this.reload());
    });
  }

  setActive(active: boolean): void {
    this.#active.set(active);
  }

  /** Apply the URL's scope. Re-entering with the same scope keeps the selection. */
  enter(scope: IssuesScope): void {
    this.#requestedRule.set(scope.rule);
    this.#locale.set(scope.locale);
    this.#pendingRow.set(scope.rowId);
    // Anything may have changed on another screen since the last visit.
    this.reload();
  }

  selectRule(rule: RuleId): void {
    this.#requestedRule.set(rule);
  }

  /** `[` / `]`: the previous or next rule in the list's own order. */
  stepRule(delta: number): void {
    const rules = this.summary()?.rules ?? [];
    const at = rules.findIndex((r) => r.rule === this.rule());
    const next = rules[at + delta];
    if (next !== undefined) this.#requestedRule.set(next.rule);
  }

  setLocale(locale: string | null): void {
    this.#locale.set(locale);
  }

  select(index: number): void {
    if (index >= 0 && index < this.findings().length) this.selectedIndex.set(index);
  }

  move(delta: number): void {
    const n = this.findings().length;
    if (n === 0) return;
    this.selectedIndex.set(Math.min(Math.max(this.selectedIndex() + delta, 0), n - 1));
  }

  reload(): void {
    this.summaryResource.reload();
    this.findingsResource.reload();
    this.detailResource.reload();
  }

  /** `f`: apply the selected finding's suggested fix. */
  async applyFix(): Promise<boolean> {
    const f = this.selected();
    if (f === undefined || f.fix === null || this.#busy()) return false;
    return this.#run(async () => {
      const res = await this.#api.fix({ rowId: f.rowId, locale: f.locale, rule: f.rule });
      // The same mirror a typed edit or a machine draft updates, so the grid
      // cell, the unsaved count and the Save button all follow.
      this.#drafts.adopt(f.rowId, f.locale, res.target, res.unsavedCount, res.history);
    });
  }

  /** "Apply N suggested fixes" for the rule on screen. */
  async applyAll(): Promise<boolean> {
    const rule = this.rule();
    if (rule === null || this.#busy()) return false;
    return this.#run(async () => {
      const res = await this.#api.fixAll(rule, this.#locale());
      this.#save.setUnsaved(res.unsavedCount);
      void this.#drafts.refreshHistory();
      // Many cells changed at once and the draft mirror holds none of them, so
      // the grid re-asks rather than showing stale bodies.
      this.#units.reload();
    });
  }

  /** `i`: ignore the selected finding for this unit and locale. */
  async ignore(): Promise<boolean> {
    const f = this.selected();
    if (f === undefined || this.#busy()) return false;
    return this.#run(async () => {
      await this.#api.ignore({ rowId: f.rowId, locale: f.locale, rule: f.rule });
      if (this.#ignored() !== null) await this.loadIgnored();
    });
  }

  async unignore(item: IgnoredFinding): Promise<boolean> {
    if (this.#busy()) return false;
    return this.#run(async () => {
      await this.#api.unignore({ rowId: item.rowId, locale: item.locale, rule: item.rule });
      await this.loadIgnored();
    });
  }

  async loadIgnored(): Promise<void> {
    try {
      this.#ignored.set((await this.#api.ignored()).ignored);
    } catch (error) {
      this.#error.set(messageOf(error, 'The ignored findings could not be loaded.'));
    }
  }

  closeIgnored(): void {
    this.#ignored.set(null);
  }

  async revalidate(): Promise<boolean> {
    if (this.#busy()) return false;
    // The list stays on screen while the server rebuilds; the counts move when it answers.
    return this.#run(async () => {
      await this.#api.revalidate(this.#locale());
    });
  }

  /** Re-draft the selected unit with the model. A human target needs the usual confirmation. */
  async redraft(): Promise<void> {
    const f = this.selected();
    if (f === undefined || this.#busy()) return;
    this.#busy.set(true);
    try {
      await this.#translate.translate(f.rowId, f.locale, {
        instruction: `The previous translation failed a check: ${f.message} Fix that.`,
      });
      this.reload();
      await this.#project.refresh();
    } finally {
      this.#busy.set(false);
    }
  }

  clearError(): void {
    this.#error.set(null);
  }

  reset(): void {
    this.#requestedRule.set(null);
    this.#locale.set(null);
    this.#pendingRow.set(null);
    this.#ignored.set(null);
    this.#error.set(null);
  }

  async #run(action: () => Promise<void>): Promise<boolean> {
    this.#busy.set(true);
    this.#error.set(null);
    try {
      await action();
      this.reload();
      // The dashboard's "Open issues" and the grid's error facet read the same index.
      await this.#project.refresh();
      return true;
    } catch (error) {
      this.#error.set(messageOf(error, 'That did not work.'));
      return false;
    } finally {
      this.#busy.set(false);
    }
  }
}
