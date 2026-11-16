// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { DraftStore } from '../../core/stores/draft-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { ReviewStore } from '../../core/stores/review-store.js';
import { LxButton } from '../../ui/button.js';
import { GLYPH } from '../../ui/glyphs.js';

/**
 * "You are done here" — the end of a review queue (M15).
 *
 * WHY IT IS A PANEL AND NOT A DIALOG. It sits at the top of the review surface
 * rather than over it, so the unit under it stays visible and a decided row
 * stays clickable: the queue keeps decided rows on purpose, precisely so a
 * reviewer can go back and look at one, and a modal would fight that the moment
 * it appeared. It also survives a reload and never interrupts a decision that
 * is halfway made.
 *
 * SAVING IS THE POINT. Review decisions land in the overlay, not in anybody's
 * XLIFF — durable across a crash (`.lexi/drafts.json`) but invisible to git,
 * to a build, and to a colleague. Somebody who has just decided twenty-six
 * drafts is exactly the person who should be asked, once, whether to write
 * them out.
 */
@Component({
  selector: 'lx-review-complete',
  imports: [LxButton, RouterLink],
  template: `
    <div class="head">
      <span class="lx-badge" data-tone="accent" aria-hidden="true">{{ GLYPH.state.reviewed }}</span>
      <p class="title">Queue complete</p>
      <span class="tally">{{ tally() }}</span>
    </div>

    <div class="actions">
      @if (drafts.isDirty()) {
        <button
          type="button"
          lx-button
          variant="primary"
          [disabled]="drafts.saving()"
          (click)="save()"
        >
          {{ drafts.saving() ? 'Saving…' : 'Save ' + drafts.count() }}
        </button>
      } @else {
        <span class="saved">Everything here is saved.</span>
      }

      <button type="button" lx-button (click)="backToGrid()">Back to the grid</button>

      @if (nextLocale(); as next) {
        <a
          lx-button
          variant="accent-soft"
          routerLink="/review"
          [queryParams]="{ locale: next.locale }"
        >
          {{ next.locale }} has {{ next.pending }} waiting →
        </a>
      }
    </div>

    @if (drafts.error(); as message) {
      <p class="failed">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: var(--lx-sp-14) var(--lx-sp-16);
      border: 1px solid var(--lx-accent-tint-border);
      border-radius: var(--lx-r-9);
      background: var(--lx-accent-tint-bg);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
    }
    .title {
      margin: 0;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
      font-weight: var(--lx-fw-600);
    }
    .tally {
      color: var(--lx-accent-on-tint);
      font-size: var(--lx-fs-12);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--lx-sp-8);
      margin-top: var(--lx-sp-10);
    }
    a[lx-button] {
      text-decoration: none;
    }
    .saved {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12);
    }
    .failed {
      margin: var(--lx-sp-8) 0 0;
      color: var(--lx-danger);
      font-size: var(--lx-fs-12-5);
    }
  `,
})
export class LxReviewComplete {
  protected readonly review = inject(ReviewStore);
  protected readonly drafts = inject(DraftStore);
  readonly #project = inject(ProjectStore);
  readonly #router = inject(Router);

  protected readonly GLYPH = GLYPH;

  protected readonly tally = computed(() => {
    const done = this.review.doneCount();
    const accepted = this.review.acceptedCount();
    const rejected = this.review.rejectedCount();
    const drafts = `${done} ${done === 1 ? 'draft' : 'drafts'}`;
    return rejected === 0
      ? `${drafts} · all accepted`
      : `${drafts} · ${accepted} accepted · ${rejected} rejected`;
  });

  /** The locale with the most still waiting, so finishing one queue offers the next. */
  protected readonly nextLocale = computed(() => {
    const current = this.review.locale();
    let best: { locale: string; pending: number } | null = null;
    for (const l of this.#project.targetLocales()) {
      if (l.locale === current) continue;
      const pending = l.draftMachine + l.needsReview;
      if (pending > 0 && (best === null || pending > best.pending))
        best = { locale: l.locale, pending };
    }
    return best;
  });

  protected async save(): Promise<void> {
    await this.drafts.saveAll();
  }

  /**
   * A plain navigation, deliberately.
   *
   * It must NOT call `focusLocale`/`setVisibleLocales`: those persist the
   * columns and the filter set to `.lexi/project.json`, and the whole reason
   * `ReviewStore` owns its own queue is that Review must not rewrite the grid
   * the user left behind (see its class comment). "Back to the grid" means
   * back to the grid as they left it.
   */
  protected backToGrid(): void {
    void this.#router.navigate(['/grid']);
  }
}
