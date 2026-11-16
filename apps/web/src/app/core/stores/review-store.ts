// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, linkedSignal, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { RejectReason, SegmentDto, UnitDetail, UnitTarget } from '@lexi/shared';

import { JobsApi } from '../api/jobs-api.js';
import { UnitsApi } from '../api/units-api.js';
import { DraftStore, type Draft } from './draft-store.js';
import { ProjectStore } from './project-store.js';
import { SaveStore } from './save-store.js';
import { TranslateStore } from './translate-store.js';
import { nextSelectedIndex } from './units-store.js';

/**
 * S11 — the Review screen (M14), replacing M12's Focus mode.
 *
 * WHY THIS OWNS ITS QUEUE INSTEAD OF BORROWING THE GRID'S. Focus mode was a
 * second layout on the Grid screen, so `GridStore.enterFocus` narrowing the
 * grid to one locale and one filter was not a side effect — it WAS the screen.
 * Review is a peer screen reached from its own tab, from a job's toast and from
 * the detail panel, and `focusLocale` replaces the visible columns and the
 * filter set AND persists both to `.lexi/project.json`. Driving it from here
 * would mean opening Review silently rewrote the grid the user left behind.
 *
 * So the queue is this store's own id list, asked for imperatively rather than
 * through an `httpResource`: it is re-asked after each decision, not on every
 * keystroke, and no answer is ever superseded by a later one.
 *
 * THE QUEUE MUST VISIBLY SHRINK, AND DECIDED ROWS MUST STAY VISIBLE. Those pull
 * in opposite directions and S11 asks for both: handling an item has to remove
 * it from the "N open" count and Next must never re-show it, but the row stays
 * in place at half opacity so a decision can be looked at again. `#merge` is
 * where that is reconciled — the reloaded list decides what is OPEN, the
 * decided map decides what stays DRAWN.
 */

/** Where the queue comes from. */
export type ReviewScope =
  | { readonly kind: 'locale'; readonly locale: string }
  /** Everything one batch job actually drafted — S8's completed card and its toast. */
  | { readonly kind: 'job'; readonly jobId: string; readonly locale: string }
  /** One unit, from the detail panel's "Draft ready · Review →". */
  | { readonly kind: 'unit'; readonly rowId: string; readonly locale: string };

export type Decision = 'accepted' | 'rejected';

export interface BulkApproveOutcome {
  readonly approved: number;
  readonly skipped: number;
}

/**
 * The target being reviewed: the pending draft if there is one, else the
 * server's own copy — the same read order `LxUnitDetail.targets` uses,
 * extracted as a pure function so it is testable without Angular DI.
 */
export function resolveTarget(
  detail: UnitDetail | undefined,
  locale: string | null,
  draftFor: (rowId: string, locale: string) => Draft | undefined,
): UnitTarget | undefined {
  if (detail === undefined || locale === null) return undefined;
  const target = detail.targets.find((t) => t.locale === locale);
  if (target === undefined) return undefined;
  return draftFor(detail.rowId, locale)?.target ?? target;
}

/**
 * Fold a reloaded queue into the one on screen, keeping decided rows in place.
 *
 * Pure and exported for the spec, like `nextSelectedIndex` and `applyJobFrame`:
 * it is the one rule here that is easy to get subtly wrong and invisible in a
 * screenshot. A row that has been decided stays at its original index even
 * though the reload no longer returns it; a row that left the queue for any
 * other reason (someone edited it in another tab, a reload dropped it) goes;
 * and anything genuinely new is appended rather than interleaved, so the
 * reviewer's place does not move under them.
 */
export function mergeQueue(
  shown: readonly string[],
  reloaded: readonly string[],
  decided: ReadonlySet<string>,
): readonly string[] {
  const open = new Set(reloaded);
  const kept = shown.filter((id) => open.has(id) || decided.has(id));
  const seen = new Set(kept);
  return [...kept, ...reloaded.filter((id) => !seen.has(id))];
}

/** The instruction a re-draft carries, built from S11's reason chips. */
export function redraftInstruction(reasons: readonly string[]): string {
  if (reasons.length === 0) return 'The previous draft was rejected. Try a different wording.';
  return `The previous draft was rejected for these reasons: ${reasons.join('; ')}. Address them.`;
}

@Injectable({ providedIn: 'root' })
export class ReviewStore {
  readonly #units = inject(UnitsApi);
  readonly #jobs = inject(JobsApi);
  readonly #drafts = inject(DraftStore);
  readonly #project = inject(ProjectStore);
  readonly #save = inject(SaveStore);
  readonly #translate = inject(TranslateStore);

  readonly #scope = signal<ReviewScope | null>(null);
  readonly #ids = signal<readonly string[]>([]);
  readonly #decided = signal<ReadonlyMap<string, Decision>>(new Map());
  readonly #busy = signal(false);
  readonly #loading = signal(false);
  readonly #error = signal<string | null>(null);
  /** Set when a job's run log is gone and the queue fell back to the locale. */
  readonly #fellBack = signal(false);

  readonly scope = this.#scope.asReadonly();
  readonly ids = this.#ids.asReadonly();
  readonly decided = this.#decided.asReadonly();
  readonly busy = this.#busy.asReadonly();
  readonly error = this.#error.asReadonly();
  readonly fellBackToLocale = this.#fellBack.asReadonly();

  readonly locale = computed<string | null>(() => this.#scope()?.locale ?? null);

  readonly selectedIndex = linkedSignal<readonly string[], number>({
    source: this.#ids,
    computation: nextSelectedIndex,
  });

  readonly selectedRowId = computed<string | null>(() => this.#ids()[this.selectedIndex()] ?? null);

  /**
   * The unit under review. An `httpResource` for the same reason the grid's
   * detail panel uses one: arrowing down the queue fires a request per row and
   * only the last answer may ever be shown.
   */
  readonly resource = httpResource<UnitDetail>(() => {
    const rowId = this.selectedRowId();
    const locale = this.locale();
    if (rowId === null || locale === null) return undefined;
    // `?locales=` is not optional here. The detail route defaults to the GRID'S
    // visible columns — right for the panel beside the grid, wrong for a screen
    // that takes its locale from the URL: reviewing a locale the grid does not
    // happen to show returned a unit with no target for it, and the whole
    // centre column fell into its empty state while the queue rail (which asks
    // for its own locale explicitly) listed the drafts perfectly.
    return `/api/units/${encodeURIComponent(rowId)}?locales=${encodeURIComponent(locale)}`;
  });

  readonly detail = computed<UnitDetail | undefined>(() => this.resource.value());
  readonly isLoading = computed(() => this.#loading() || this.resource.isLoading());

  readonly target = computed<UnitTarget | undefined>(() =>
    resolveTarget(this.detail(), this.locale(), (rowId, locale) =>
      this.#drafts.draftFor(rowId, locale),
    ),
  );

  /** Rows still awaiting a decision — the queue's "N open", not its length. */
  readonly openIds = computed<readonly string[]>(() => {
    const decided = this.#decided();
    return this.#ids().filter((id) => !decided.has(id));
  });

  readonly doneCount = computed(() => this.#ids().filter((id) => this.#decided().has(id)).length);

  /**
   * Every draft in this queue has been decided (M15).
   *
   * Needs its own signal rather than falling out of the empty state, because
   * the queue never empties: `#move` deliberately leaves the selection on the
   * last decided row so it can be revisited, which means `detail()` and
   * `target()` stay defined and the centre column's "nothing to review"
   * placeholder is never reached. Without this the screen simply sat there
   * after the final decision, saying nothing.
   */
  readonly complete = computed(() => this.#ids().length > 0 && this.openIds().length === 0);
  readonly acceptedCount = computed(() => this.#countDecisions('accepted'));
  readonly rejectedCount = computed(() => this.#countDecisions('rejected'));

  /** 1-based position among the OPEN drafts — S11's "Draft 1 of 26 open". */
  readonly openPosition = computed(() => {
    const rowId = this.selectedRowId();
    if (rowId === null) return 0;
    const at = this.openIds().indexOf(rowId);
    return at === -1 ? 0 : at + 1;
  });

  readonly decisionFor = (rowId: string): Decision | undefined => this.#decided().get(rowId);

  /** FR-7.4's edit rate for the locale under review, live across the session. */
  readonly editRate = computed(() => {
    const locale = this.locale();
    return locale === null ? undefined : this.#project.editRate().find((e) => e.locale === locale);
  });

  /**
   * A draft whose checks would stop it reaching Final (FR-8.4).
   *
   * Plain Accept is disabled for one; "Accept & mark needs review" and Reject
   * stay, because the draft may still be the most useful thing on the screen
   * and throwing it away is a decision the reviewer should make, not the UI.
   */
  readonly blocked = computed(() =>
    (this.target()?.findings ?? []).some((f) => f.severity === 'error'),
  );

  /* ---- entering the screen ------------------------------------------------ */

  /**
   * Point the queue at a scope and load it.
   *
   * Idempotent for the same scope, because the route's query parameters are
   * re-read on every navigation and re-entering Review must not discard the
   * decisions already made in this session.
   */
  async enter(scope: ReviewScope): Promise<void> {
    if (sameScope(this.#scope(), scope)) return;
    this.#scope.set(scope);
    this.#decided.set(new Map());
    this.#ids.set([]);
    this.#fellBack.set(false);
    await this.reload();
  }

  async reload(): Promise<void> {
    const scope = this.#scope();
    if (scope === null) return;
    this.#loading.set(true);
    try {
      const reloaded = await this.#idsFor(scope);
      this.#error.set(null);
      this.#ids.update((shown) => mergeQueue(shown, reloaded, new Set(this.#decided().keys())));
    } catch (error) {
      this.#error.set(messageOf(error));
    } finally {
      this.#loading.set(false);
    }
  }

  async #idsFor(scope: ReviewScope): Promise<readonly string[]> {
    if (scope.kind === 'unit') return [scope.rowId];
    if (scope.kind === 'job') {
      try {
        const { entries } = await this.#jobs.log(scope.jobId);
        // Only what the job actually WROTE. A rejected unit's target was left
        // untouched (FR-6.11), so there is no draft for a reviewer to judge.
        // A job drafts several locales; the review is for one of them.
        return entries
          .filter((e) => e.outcome === 'accepted' && e.locale === scope.locale)
          .map((e) => e.rowId);
      } catch {
        // `JobQueue` holds its jobs in memory, so a server restart orphans the
        // run log on disk. Falling back to the locale's own queue shows the
        // same drafts, just without the batch scoping — better than an empty
        // screen for work that plainly exists.
        this.#fellBack.set(true);
        return this.#queueFor(scope.locale);
      }
    }
    return this.#queueFor(scope.locale);
  }

  /** FR-7.1's queue: machine drafts OR needs-review, for exactly one locale. */
  async #queueFor(locale: string): Promise<readonly string[]> {
    const res = await this.#units.query({
      search: '',
      scope: 'all',
      groups: [],
      locales: [locale],
      filters: ['toReview'],
    });
    return res.ids;
  }

  /* ---- decisions ---------------------------------------------------------- */

  /** `a` — accept the draft exactly as it stands. */
  approve(): Promise<void> {
    return this.#decide('accepted', (rowId, locale, target) =>
      this.#drafts.commit(rowId, locale, target.segments, 'reviewed', {
        decision: 'approve',
        reasons: [],
      }),
    );
  }

  /** S11's "Accept & mark needs review" — keep it in the queue for a second pass. */
  acceptNeedsReview(): Promise<void> {
    return this.#decide('accepted', (rowId, locale, target) =>
      this.#drafts.commit(rowId, locale, target.segments, 'needsReview', {
        decision: 'approve',
        reasons: [],
      }),
    );
  }

  /** `e` then the editor's own commit — an edit that also advances the queue. */
  editCommit(segments: readonly SegmentDto[]): Promise<void> {
    return this.#decide('accepted', (rowId, locale) =>
      this.#drafts.commit(rowId, locale, segments, undefined, { decision: 'edit', reasons: [] }),
    );
  }

  /**
   * `r` — put back whatever the draft displaced.
   *
   * The segments sent are empty on purpose: the server restores its own
   * snapshot, because after a save the browser is no longer holding the text
   * that was there before. See `routes/edit.ts`.
   */
  reject(reasons: readonly RejectReason[] | readonly string[] = []): Promise<void> {
    return this.#decide('rejected', (rowId, locale) =>
      this.#drafts.commit(rowId, locale, [], undefined, {
        decision: 'reject',
        reasons: [...reasons],
      }),
    );
  }

  /**
   * "Re-draft with reason" (FR-6.12) — run the model again with the chips as
   * the added instruction. Not a decision: the unit stays open, now holding a
   * new draft to judge.
   */
  async redraft(reasons: readonly string[] = []): Promise<void> {
    const rowId = this.selectedRowId();
    const locale = this.locale();
    if (rowId === null || locale === null || this.#busy()) return;
    this.#busy.set(true);
    try {
      // No `overwrite`: re-drafting over our own draft is an ordinary retry and
      // the server's guard already knows it (FR-6.10).
      await this.#translate.translate(rowId, locale, { instruction: redraftInstruction(reasons) });
      this.resource.reload();
    } finally {
      this.#busy.set(false);
    }
  }

  /** `Esc` while editing — the editor's own revert, wired the way the grid's is. */
  async revert(): Promise<void> {
    const rowId = this.selectedRowId();
    const locale = this.locale();
    if (rowId === null || locale === null) return;
    await this.#drafts.revert(rowId, locale);
    this.resource.reload();
  }

  /** Move on without touching the unit. No server call: nothing changed. */
  skip(): void {
    this.next();
  }

  previous(): void {
    this.#move(-1);
  }

  next(): void {
    this.#move(1);
  }

  select(rowId: string): void {
    const at = this.#ids().indexOf(rowId);
    if (at !== -1) this.selectedIndex.set(at);
  }

  /**
   * FR-7.3's bulk accept, behind the caller's own confirmation (this store does
   * not ask). S11 scopes it to the CLEAN drafts: a warning or a validation
   * error is precisely what a reviewer is here to look at.
   */
  async bulkApprove(rowIds: readonly string[]): Promise<BulkApproveOutcome | null> {
    const locale = this.locale();
    if (locale === null || rowIds.length === 0 || this.#busy()) return null;
    this.#busy.set(true);
    try {
      const res = await this.#units.bulkApprove(rowIds, locale);
      this.#save.setUnsaved(res.unsavedCount);
      this.#remember(res.approved, 'accepted');
      await this.#advance();
      return { approved: res.approved.length, skipped: res.skipped.length };
    } finally {
      this.#busy.set(false);
    }
  }

  clearError(): void {
    this.#error.set(null);
  }

  /** The project this queue belongs to is going away. */
  reset(): void {
    this.#scope.set(null);
    this.#ids.set([]);
    this.#decided.set(new Map());
    this.#fellBack.set(false);
    this.#error.set(null);
  }

  /* ---- internals ---------------------------------------------------------- */

  async #decide(
    decision: Decision,
    commit: (rowId: string, locale: string, target: UnitTarget) => Promise<UnitTarget | null>,
  ): Promise<void> {
    const rowId = this.selectedRowId();
    const locale = this.locale();
    const target = this.target();
    if (rowId === null || locale === null || target === undefined || this.#busy()) return;
    this.#busy.set(true);
    try {
      const committed = await commit(rowId, locale, target);
      // A refused commit is not a decision. Marking one anyway would grey out a
      // row that is still open and drop it from the count of work left.
      if (committed === null) return;
      this.#remember([rowId], decision);
      await this.#advance();
    } finally {
      this.#busy.set(false);
    }
  }

  #remember(rowIds: readonly string[], decision: Decision): void {
    this.#decided.update((map) => {
      const next = new Map(map);
      for (const rowId of rowIds) next.set(rowId, decision);
      return next;
    });
  }

  /**
   * Re-ask the queue and move on.
   *
   * The reload is what makes the queue shrink — unlike the grid, where a commit
   * deliberately leaves the row in its stale filtered view until something else
   * re-queries. Here the whole point is that handling an item removes it, and
   * "Accept & next" must never land back on what was just accepted.
   */
  async #advance(): Promise<void> {
    await this.reload();
    await this.#project.refresh();
    // `nextSelectedIndex` holds the position when the selected row survives the
    // reload, which is exactly what a decided-but-still-drawn row does. So the
    // step to the next OPEN draft is made explicitly rather than falling out of
    // the list shrinking.
    if (this.#decided().has(this.selectedRowId() ?? '')) this.#move(1);
  }

  /** Step to the next row in this direction that has not been decided yet. */
  #move(delta: number): void {
    const ids = this.#ids();
    const decided = this.#decided();
    if (ids.length === 0) return;
    for (let at = this.selectedIndex() + delta; at >= 0 && at < ids.length; at += delta) {
      if (!decided.has(ids[at] as string)) {
        this.selectedIndex.set(at);
        return;
      }
    }
    // Nothing open in that direction. Staying put is right: the queue is either
    // finished or the reviewer is at its end, and wrapping around would re-show
    // work they have just been through.
  }

  #countDecisions(decision: Decision): number {
    let count = 0;
    for (const id of this.#ids()) if (this.#decided().get(id) === decision) count += 1;
    return count;
  }
}

const sameScope = (a: ReviewScope | null, b: ReviewScope): boolean => {
  if (a === null || a.kind !== b.kind) return false;
  if (a.kind === 'job' && b.kind === 'job') return a.jobId === b.jobId;
  if (a.kind === 'unit' && b.kind === 'unit') return a.rowId === b.rowId && a.locale === b.locale;
  return a.locale === b.locale;
};

function messageOf(error: unknown): string {
  const body = (error as { error?: { error?: { message?: string } } }).error;
  return body?.error?.message ?? 'The review queue could not be loaded.';
}
