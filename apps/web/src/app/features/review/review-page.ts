// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type OnDestroy,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import type { RejectReason, SegmentDto } from '@lexi/shared';

import { ChromeStore } from '../../core/stores/chrome-store.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { ReviewStore, type ReviewScope } from '../../core/stores/review-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { ToastStore } from '../../core/stores/toast-store.js';
import { isTypingTarget } from '../../core/is-typing-target.js';
import {
  LxButton,
  LxIcon,
  LxPlaceholderChip,
  LxSegmentEditor,
  LxStateBadge,
} from '../../ui/index.js';
import { messageOf } from '../../core/api/server-message.js';
import { segmentsPlaceholderIds } from '../../ui/segment-dom.js';
import { LxRejectReasons, reasonsPayload, reasonsSpoken } from './reject-reasons.js';
import { LxReviewChecks } from './review-checks.js';
import { LxReviewComplete } from './review-complete.js';
import { LxReviewContext } from './review-context.js';
import { LxReviewDiff } from './review-diff.js';
import { LxReviewQueue } from './review-queue.js';

/**
 * S11 — Review (M14). Replaces M12's Focus mode, which was a second layout on
 * the Grid screen because the previous handoff had no mock for it.
 *
 * WHY IT IS A ROUTE NOW. Review is reached from three places that have nothing
 * to do with the grid: its own tab, a finished job's toast, and the detail
 * panel after a single draft. A layout flag on another screen cannot be linked
 * to, cannot be restored on reload, and — the part that actually bit — could
 * only be entered by rewriting the grid's own columns and filters.
 *
 * The scope comes from the query string (`?locale=`, `?job=`, `?rowId=`) so all
 * three entry points are ordinary links, and a reviewer can send one to a
 * colleague.
 *
 * KEYBOARD FIRST (FR-7.2, requirements §7.2). `a` / `r` / `e` plus the arrows
 * complete the loop without a mouse, and every one of them is gated on
 * `isTypingTarget` — the draft card IS the editor, and "bezahlen" must not fire
 * Approve on its own first letter. That hazard is why the keys live here rather
 * than in the shell.
 */
@Component({
  selector: 'lx-review-page',
  imports: [
    LxButton,
    LxIcon,
    LxPlaceholderChip,
    LxRejectReasons,
    LxReviewChecks,
    LxReviewComplete,
    LxReviewContext,
    LxReviewDiff,
    LxReviewQueue,
    LxSegmentEditor,
    LxStateBadge,
  ],
  host: {
    '(keydown)': 'onKey($event)',
    tabindex: '0',
  },
  templateUrl: './review-page.html',
  styleUrl: './review-page.css',
})
export class ReviewPage implements OnDestroy {
  protected readonly review = inject(ReviewStore);
  protected readonly drafts = inject(DraftStore);
  protected readonly settings = inject(SettingsStore);
  readonly #project = inject(ProjectStore);
  readonly #chrome = inject(ChromeStore);
  readonly #toasts = inject(ToastStore);
  readonly #route = inject(ActivatedRoute);
  readonly #injector = inject(Injector);

  private readonly editor = viewChild(LxSegmentEditor);

  /** The uncommitted buffer — local, the same split `LxUnitDetail` uses and for
   * the same IME reason: only one editor is mounted at a time and it must not
   * be re-rendered mid-composition. */
  readonly #buffer = signal<readonly SegmentDto[] | null>(null);
  protected readonly editing = signal(false);
  protected readonly reasons = signal<readonly RejectReason[]>([]);
  protected readonly note = signal('');

  readonly #params = toSignal(this.#route.queryParamMap, { initialValue: null });

  /**
   * Why the surface is empty, when it is empty because something failed. The
   * queue (`error()`) and the unit (`resource.error()`) fail separately, and
   * before M13 neither was rendered, so a server that did not answer read as
   * "Nothing to review — every draft has been decided".
   */
  protected readonly loadError = computed<string | null>(() => {
    const queue = this.review.error();
    if (queue !== null) return queue;
    const unit: unknown = this.review.resource.error();
    return unit ? messageOf(unit, 'This draft could not be loaded.') : null;
  });

  constructor() {
    // Reachable without the grid ever having mounted (a toast on the dashboard,
    // a pasted link), so the editor mode has to be loaded here too. Idempotent.
    void this.settings.load();

    effect(() => {
      const scope = scopeFrom(this.#params(), this.#project.targetLocales());
      if (scope !== null) void this.review.enter(scope);
    });

    // A decision moves to a different unit, and the chips belong to the unit
    // they were chosen for — carrying them forward would attach "ignores
    // glossary" to a string nobody has read yet.
    effect(() => {
      this.review.selectedRowId();
      this.reasons.set([]);
      this.note.set('');
      this.editing.set(false);
      this.#buffer.set(null);
    });

    effect(() => {
      this.#chrome.setLeft(
        this.review.ids().length === 0
          ? [{ text: 'Review queue empty' }]
          : [
              { text: `${this.review.openPosition()} of ${this.review.openIds().length} open` },
              { text: `${this.review.doneCount()} decided` },
            ],
      );
      this.#chrome.setRight([
        { key: 'a', text: 'accept' },
        { key: 'r', text: 'reject' },
        { key: 'e', text: 'edit' },
        { key: '↑↓', text: 'previous / next' },
      ]);
    });
  }

  ngOnDestroy(): void {
    this.#chrome.reset();
  }

  protected readonly availableIds = computed<readonly string[]>(() =>
    segmentsPlaceholderIds(this.review.detail()?.source ?? []),
  );

  /** The chips plus the free note, as both the PATCH and the prompt want them. */
  protected readonly payload = computed(() => reasonsPayload(this.reasons(), this.note()));

  protected readonly pendingLabel = computed(() => {
    const open = this.review.openIds().length;
    return `${open} ${open === 1 ? 'draft' : 'drafts'} pending`;
  });

  protected readonly sourceChars = computed(() => plainLength(this.review.detail()?.source ?? []));

  /** "48 chars · +23% length" — S11's draft-card meta line. */
  protected readonly lengthDelta = computed<string | null>(() => {
    const source = this.review.detail()?.source;
    const target = this.review.target();
    if (source === undefined || target === undefined) return null;
    const from = plainLength(source);
    if (from === 0) return null;
    const delta = Math.round(((target.charCount - from) / from) * 100);
    return delta === 0 ? 'same length' : `${delta > 0 ? '+' : ''}${delta}% length`;
  });

  protected storedReasons(reasons: readonly string[]): string {
    return reasonsSpoken(reasons).join(', ');
  }

  protected focusEditor(): void {
    this.editing.set(true);
    afterNextRender(() => this.editor()?.focus(), { injector: this.#injector });
  }

  protected onEdit(segments: readonly SegmentDto[]): void {
    this.#buffer.set(segments);
  }

  /** The editor's own commit — accept the corrected text and advance. */
  protected async commitEdit(): Promise<void> {
    const buffer = this.#buffer();
    this.editing.set(false);
    this.#buffer.set(null);
    if (buffer === null) return;
    await this.review.editCommit(buffer);
  }

  protected cancelEdit(): void {
    this.editing.set(false);
    this.#buffer.set(null);
    void this.review.revert();
  }

  protected async accept(): Promise<void> {
    if (this.editing()) {
      await this.commitEdit();
      return;
    }
    await this.review.approve();
  }

  protected async reject(): Promise<void> {
    const reasons = this.payload();
    await this.review.reject(reasons);
  }

  protected async redraft(): Promise<void> {
    await this.review.redraft(reasonsSpoken(this.payload()));
  }

  protected async bulkOutcomeToast(): Promise<void> {
    // Kept here rather than in the store: "say something about it" is a screen's
    // decision, and the store is used by the spec without a toast host mounted.
    const outcome = await this.review.bulkApprove(this.review.openIds());
    if (outcome === null) return;
    this.#toasts.show({
      tone: 'accent',
      title: `${outcome.approved} approved`,
      detail: outcome.skipped === 0 ? undefined : `${outcome.skipped} no longer qualified`,
    });
  }

  /**
   * FR-7.2's keymap. Every branch is gated on `isTypingTarget`, because the
   * draft card is a `contenteditable` and a bare letter inside it is text.
   */
  protected onKey(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      void this.accept();
      return;
    }
    if (isTypingTarget(event.target)) return;

    const key = event.key.toLowerCase();
    if (key === 'a') {
      event.preventDefault();
      void this.review.approve();
    } else if (key === 'r') {
      event.preventDefault();
      void this.reject();
    } else if (key === 'e' || event.key === 'Enter') {
      event.preventDefault();
      this.focusEditor();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.review.next();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.review.previous();
    }
  }
}

/** Plain-text length of a segment list, for the draft card's length delta. */
function plainLength(segments: readonly SegmentDto[]): number {
  let n = 0;
  const walk = (list: readonly SegmentDto[]): void => {
    for (const s of list) {
      if (s.k === 't') n += s.v.length;
      else if (s.k === 'g') walk(s.children);
    }
  };
  walk(segments);
  return n;
}

/** What the fallback needs to know about a locale: its name and its backlog. */
export interface ReviewableLocale {
  readonly locale: string;
  readonly draftMachine: number;
  readonly needsReview: number;
}

/**
 * Which locale the Review tab opens on when the URL names none.
 *
 * The one with the most work waiting, NOT the first in the list. The tab is
 * reached with no parameters at all, and a project's first target locale
 * alphabetically is very often the one nobody has drafted anything for — the
 * screen would then say "nothing to review" while the title bar's own pill
 * said 96 drafts were pending. Ties break on the list's own order, which is
 * the dashboard's order, so the choice is at least predictable.
 */
export function busiestLocale(locales: readonly ReviewableLocale[]): string | null {
  let best: ReviewableLocale | null = null;
  for (const l of locales) {
    const backlog = l.draftMachine + l.needsReview;
    if (backlog > 0 && (best === null || backlog > best.draftMachine + best.needsReview)) best = l;
  }
  return (best ?? locales[0])?.locale ?? null;
}

/**
 * The scope, read off the query string. Exported for the spec: three entry
 * points funnel through this one function, and getting the precedence wrong
 * would silently show the wrong queue.
 */
export function scopeFrom(
  params: { get(name: string): string | null } | null,
  locales: readonly ReviewableLocale[],
): ReviewScope | null {
  const locale = params?.get('locale') ?? null;
  const rowId = params?.get('rowId') ?? null;
  const job = params?.get('job') ?? null;

  // A job carries its own locale, so it wins over a stale `locale` in the URL.
  if (job !== null) {
    return { kind: 'job', jobId: job, locale: locale ?? busiestLocale(locales) ?? '' };
  }
  if (rowId !== null && locale !== null) return { kind: 'unit', rowId, locale };
  const chosen = locale ?? busiestLocale(locales);
  return chosen === null ? null : { kind: 'locale', locale: chosen };
}
