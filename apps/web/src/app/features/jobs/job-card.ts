// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { splitRowId } from '@lexi/shared/constants';
import type { Job, ReportQuery } from '@lexi/shared';

import { UnitsApi } from '../../core/api/units-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { span, stamp } from '../../core/format-time.js';
import {
  countedLocales,
  etaText,
  isActiveJob,
  jobDisplayName,
  jobTotals,
  localeList,
  localesText,
} from '../../core/job-math.js';
import { CsvImportStore } from '../../core/stores/csv-import-store.js';
import { JobsStore, waitsFor } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { LxButton, LxIcon, LxModalService, LxStackedBar, type BarSegment } from '../../ui/index.js';
import { segmentsPlainText } from '../../ui/segment-dom.js';
import { LxMenu } from '../../ui/menu.js';
import { LxJobLocaleRow } from './job-locale-row.js';
import { LxJobStatusChip } from './job-status-chip.js';
import { LxReportExportModal, type ReportExportModalData } from './report-export-modal.js';

interface Stat {
  readonly text: string;
  readonly tone: 'strong' | 'danger' | 'subtle' | 'warn';
}

/**
 * S14's job card: one task over a list of locales, keyed on
 * `[attr.data-status]` — the same recipe `LxStateBadge` uses, so a running
 * job can become a done one without swapping components out from under the
 * run-log selection.
 *
 * The card's totals leave out every locale the user skipped (they stay
 * untouched, so they are not part of what the job does), and each locale
 * row carries its own progress, chip and action.
 *
 * The finished card has two ways on, and they are not the same question.
 * "Show flagged units" narrows the RUN LOG, because a rejected unit's target
 * was never written and no grid filter can find it. "Review N →" on a locale
 * row opens S11 scoped to that locale of this job: exactly what it did write.
 */
@Component({
  selector: 'lx-job-card',
  imports: [LxButton, LxIcon, LxJobLocaleRow, LxJobStatusChip, LxMenu, LxStackedBar, RouterLink],
  host: {
    class: 'lx-job-card',
    '[attr.data-status]': 'job().status',
    '[attr.data-selected]': 'selected()',
    '(click)': 'select()',
    '(document:pointerdown)': 'closeReviewOutside($event)',
  },
  templateUrl: './job-card.html',
  styleUrl: './job-card.css',
})
export class LxJobCard {
  readonly job = input.required<Job>();

  readonly #jobs = inject(JobsStore);
  readonly #csvImport = inject(CsvImportStore);
  readonly #project = inject(ProjectStore);
  readonly #units = inject(UnitsApi);
  readonly #modal = inject(LxModalService);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly selected = computed(() => this.#jobs.selectedId() === this.job().id);
  protected readonly title = computed(() => jobDisplayName(this.job()));
  protected readonly expanded = computed(() => {
    const s = this.job().status;
    return s === 'running' || s === 'paused';
  });
  protected readonly queued = computed(() => this.job().status === 'queued');
  protected readonly finished = computed(() => !isActiveJob(this.job()));

  protected readonly totals = computed(() => jobTotals(this.job()));

  protected readonly segments = computed<readonly BarSegment[]>(() => {
    const { done, flagged } = this.totals();
    return [
      { value: Math.max(0, done - flagged), tone: 'accent', label: 'accepted' },
      { value: flagged, tone: 'danger', label: 'flagged' },
    ];
  });

  readonly #rtl = computed(
    () =>
      new Set(
        this.#project
          .targetLocales()
          .filter((l) => l.isRtl)
          .map((l) => l.locale),
      ),
  );
  protected isRtl(locale: string): boolean {
    return this.#rtl().has(locale);
  }

  /** The stats row, exactly as the design's `jbVals()` builds it per variant. */
  protected readonly stats = computed<readonly Stat[]>(() => {
    const job = this.job();
    const { total, done, flagged } = this.totals();
    const counted = countedLocales(job);
    if (this.expanded()) {
      const at = counted.findIndex((l) => l.status === 'running' || l.status === 'paused');
      const paused = job.status === 'paused';
      const left = etaText(total - done, job.avgMsPerUnit);
      return [
        { text: `${fmt(done)} of ${fmt(total)}`, tone: 'strong' },
        { text: `${flagged} flagged`, tone: 'danger' },
        { text: `locale ${at + 1} of ${counted.length}`, tone: 'subtle' },
        ...(paused
          ? [{ text: 'paused', tone: 'warn' } as const]
          : left === ''
            ? []
            : [{ text: `${left} left`, tone: 'subtle' } as const]),
      ];
    }
    if (this.queued()) {
      return [
        { text: `${fmt(total)} units`, tone: 'strong' },
        { text: localesText(counted.length), tone: 'subtle' },
        ...(total > 0 ? [{ text: etaText(total), tone: 'subtle' } as const] : []),
      ];
    }
    return [
      { text: `${fmt(Math.max(0, done - flagged))} drafts written`, tone: 'strong' },
      { text: `${flagged} rejected`, tone: 'danger' },
    ];
  });

  /**
   * "starts after #14", or "starts next" when nothing is ahead of it. From
   * the RUN order, oldest first — the list itself shows the newest on top.
   */
  protected readonly queuedNote = computed(() => {
    const ahead = waitsFor(this.#jobs.jobs(), this.job().id);
    return ahead === null ? 'starts next' : `starts after #${ahead.number}`;
  });

  /**
   * `16 Oct, 13:12 · 4 min 06 s` for a job that ran; a sentence and the moment
   * for one that was stopped. Always dated: a finished job outlives its day.
   */
  protected readonly finishedMeta = computed(() => {
    const j = this.job();
    const at = stamp(j.finishedAt);
    if (j.status === 'cancelled') {
      const why = j.startedAt === null ? 'cancelled before it started' : 'stopped by user';
      return at === '' ? why : `${why} · ${at}`;
    }
    const took = span(j.startedAt, j.finishedAt);
    return took === '' ? at : `${at} · ${took}`;
  });

  protected readonly showFlaggedLink = computed(() => this.finished() && this.totals().flagged > 0);

  /**
   * The locales with drafts still waiting for a reviewer (M15). Review is one
   * locale's queue, so with one of them the header button goes straight
   * there, and with several it opens a menu of them. It counts DOWN as drafts
   * are decided — driven by `pendingReview`, not `accepted`, which never moves.
   */
  protected readonly reviewLocales = computed(() =>
    this.finished()
      ? this.job()
          .locales.filter((l) => l.pendingReview > 0)
          .map((l) => ({ locale: l.locale, count: l.pendingReview }))
      : [],
  );
  protected readonly reviewOpen = signal(false);

  protected toggleReview(event: Event): void {
    event.stopPropagation();
    this.reviewOpen.update((open) => !open);
  }

  /**
   * A locale picked from the review menu. Stops here so the card's own click
   * does not also select it on the way to the Review screen.
   */
  protected pickReview(event: Event): void {
    event.stopPropagation();
    this.reviewOpen.set(false);
  }

  /** A click anywhere outside the review button and its menu closes the menu. */
  protected closeReviewOutside(event: Event): void {
    if (!this.reviewOpen()) return;
    const review = this.#host.querySelector('.review');
    if (review !== null && !review.contains(event.target as Node)) this.reviewOpen.set(false);
  }

  /** The locale being drafted right now, and the unit inside it. */
  protected readonly current = computed(() => {
    const j = this.job();
    if (j.status !== 'running' || j.currentLocale === null) return null;
    const loc = j.locales.find((l) => l.locale === j.currentLocale);
    if (loc === undefined || loc.currentRowId === null) return null;
    return {
      locale: loc.locale,
      rowId: loc.currentRowId,
      unitId: splitRowId(loc.currentRowId).unitId,
    };
  });

  /** The current unit's source text, fetched once per unit as the "now" line moves on. */
  protected readonly currentSource = signal<string | null>(null);

  constructor() {
    let asked: string | null = null;
    effect(() => {
      const rowId = this.current()?.rowId ?? null;
      if (rowId === asked) return;
      asked = rowId;
      this.currentSource.set(null);
      if (rowId === null) return;
      this.#units
        .detail(rowId)
        .then((detail) => {
          if (asked === rowId) this.currentSource.set(segmentsPlainText(detail.source));
        })
        .catch(() => undefined);
    });
  }

  /**
   * The keyboard way in. The whole card stays clickable for a mouse, but a card
   * cannot itself be a button — it holds Pause, Cancel and the locale actions,
   * and an interactive element inside another is announced as nonsense — so
   * the title is the button, pressed while its job's log is the one on screen.
   */
  protected selectFromKeyboard(event: Event): void {
    event.stopPropagation();
    this.select();
  }

  protected select(): void {
    void this.#jobs.select(this.job().id);
  }

  protected pause(event: Event): void {
    event.stopPropagation();
    void this.#jobs.pause(this.job().id);
  }

  protected resume(event: Event): void {
    event.stopPropagation();
    void this.#jobs.resume(this.job().id);
  }

  protected cancel(event: Event): void {
    event.stopPropagation();
    void this.#jobs.cancel(this.job().id);
  }

  protected remove(event: Event): void {
    event.stopPropagation();
    void this.#jobs.remove(this.job().id);
  }

  protected showFlagged(event: Event): void {
    event.stopPropagation();
    void this.#jobs.select(this.job().id, 'flagged');
  }

  /**
   * The review report is for the drafts a job wrote and the ones it could not,
   * so a finished job that reached no unit at all has nothing to put in one.
   */
  protected readonly hasReport = computed(() => this.totals().done > 0);
  protected readonly reportBusy = signal(false);
  protected readonly reportError = signal<string | null>(null);

  /** Asks what to export first: the HTML review report or the CSV for a market reviewer. */
  protected async downloadReport(event: Event): Promise<void> {
    event.stopPropagation();
    const data: ReportExportModalData = {
      locales: localeList(this.job()),
      localeCount: this.job().locales.length,
    };
    const ref = this.#modal.open<LxReportExportModal, ReportQuery>(LxReportExportModal, { data });
    const query = await new Promise<ReportQuery | undefined>((resolve) => {
      ref.closed.subscribe((value) => resolve(value));
    });
    if (query === undefined) return;

    this.reportBusy.set(true);
    this.reportError.set(null);
    try {
      await this.#jobs.downloadReport(this.job().id, query);
    } catch (error) {
      this.reportError.set(messageOf(error, 'The review report could not be created.'));
    } finally {
      this.reportBusy.set(false);
    }
  }

  private readonly importInput = viewChild<ElementRef<HTMLInputElement>>('importFile');
  protected readonly importError = signal<string | null>(null);
  /** Off while a pick is being read and previewed: a second pick would only be ignored. */
  protected readonly importBusy = this.#csvImport.busy;

  /** "Import reviewed CSV…": the native picker first, the import screen after. */
  protected chooseImport(event: Event): void {
    event.stopPropagation();
    const input = this.importInput()?.nativeElement;
    if (input === undefined) return;
    input.value = '';
    input.click();
  }

  protected async onImportFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.#csvImport.start(files, { jobId: this.job().id });
    this.importError.set(this.#csvImport.error());
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');
