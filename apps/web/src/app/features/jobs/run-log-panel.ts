// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, effect, inject, signal } from '@angular/core';
import { splitRowId } from '@lexi/shared/constants';
import type { CsvImportSummary, RunLogEntry, TranslateRun } from '@lexi/shared';

import { CsvImportApi } from '../../core/api/csv-import-api.js';
import { JobsStore, type LogLocaleFilter } from '../../core/stores/jobs-store.js';
import { LxBadge, LxIcon, type BadgeTone } from '../../ui/index.js';

type Archetype =
  'accepted' | 'termbase' | 'reviewer-note' | 'retry' | 'rejected' | 'skipped' | 'failed';

const BADGE: Record<
  Archetype,
  { readonly tone: BadgeTone; readonly outline: boolean; readonly glyph: string }
> = {
  accepted: { tone: 'warn', outline: false, glyph: 'AI' },
  // Not 'AI': no model was asked. The source is a Term Base term and its entry
  // was written as the target, final.
  termbase: { tone: 'accent', outline: false, glyph: 'TB' },
  'reviewer-note': { tone: 'warn', outline: false, glyph: 'AI' },
  retry: { tone: 'neutral', outline: true, glyph: '↻' },
  rejected: { tone: 'danger', outline: false, glyph: '!' },
  skipped: { tone: 'neutral', outline: true, glyph: 'skip' },
  failed: { tone: 'danger', outline: false, glyph: '✕' },
};

/** Which of S8's four visual archetypes an entry reads as. */
function archetypeOf(entry: RunLogEntry): Archetype {
  if (entry.outcome === 'rejected') return 'rejected';
  if (entry.outcome === 'skipped') return 'skipped';
  if (entry.outcome === 'failed') return 'failed';
  if (entry.run?.parse === 'termbase') return 'termbase';
  if (entry.run?.notesForReviewer) return 'reviewer-note';
  if (entry.run?.parse === 'retried') return 'retry';
  return 'accepted';
}

/**
 * The model's own JSON answer, decoded for display.
 *
 * `run.raw` is the answer BEFORE the restore gate re-attaches real placeholder
 * bytes by id — the client never holds those (they are not sent, per the
 * "client never sees a byte of the file" invariant), so a masked-style answer
 * still shows its `[[n]]` tokens here rather than a chip. Honest, not wrong:
 * this is literally what the model said.
 */
function translationOf(run: TranslateRun | null): string | null {
  if (run === null) return null;
  try {
    const parsed: unknown = JSON.parse(run.raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { translation?: unknown }).translation === 'string'
    ) {
      return (parsed as { translation: string }).translation;
    }
  } catch {
    // Not JSON — `parse: 'plain'` already means the whole answer IS the text.
  }
  return run.raw;
}

/**
 * The line that turns "this was slow" into "this was slow BECAUSE".
 *
 * Reasoning is called out separately from the token total rather than folded
 * into it: a unit that spent nine hundred tokens thinking and twenty answering
 * is not a big translation, it is a model deliberating over a button label, and
 * those two readings need different fixes. Omitted entirely where the server
 * reports no such breakdown, which is most of them.
 */
function formatLatency(run: TranslateRun | null): string {
  if (run === null || run.parse === 'termbase') return '';
  const seconds = (run.latencyMs / 1000).toFixed(1);
  const tokens = (run.promptTokens ?? 0) + (run.completionTokens ?? 0);
  if (tokens === 0) return `${seconds} s`;
  const thinking = run.reasoningTokens ?? 0;
  return thinking > 0
    ? `${seconds} s · ${tokens} tok · ${thinking} thinking`
    : `${seconds} s · ${tokens} tok`;
}

interface LocaleFilter {
  readonly value: LogLocaleFilter;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
}

interface EntryView {
  readonly entry: RunLogEntry;
  readonly archetype: Archetype;
  readonly badge: { readonly tone: BadgeTone; readonly outline: boolean; readonly glyph: string };
  readonly unitId: string;
  readonly latency: string;
  readonly meta: string;
  readonly body: string;
}

/**
 * S14's run-log column (FR-6.14) — the 460px rail beside the queue, filtered
 * by locale for a job that drafts several.
 *
 * One archetype per entry, chosen from what the entry actually contains
 * (`archetypeOf`) rather than hard-coded to the mock's four example rows —
 * the same string of good or bad luck a job produces in practice.
 */
@Component({
  selector: 'lx-run-log-panel',
  imports: [LxBadge, LxIcon],
  templateUrl: './run-log-panel.html',
  styleUrl: './run-log-panel.css',
})
export class LxRunLogPanel {
  protected readonly jobs = inject(JobsStore);
  readonly #csvImports = inject(CsvImportApi);

  readonly #imports = signal<readonly CsvImportSummary[]>([]);

  /**
   * One line per CSV import of the shown job, newest first, above the unit
   * entries. Fetched when the shown job changes. S16 is a separate route, so
   * coming back from an import re-creates this panel and loads afresh.
   */
  protected readonly importLines = computed(() =>
    this.#imports().map((i) => ({
      id: i.importId,
      text:
        `CSV import · ${i.count} ${i.count === 1 ? 'unit' : 'units'} · ${formatClock(i.at)}` +
        (i.undone ? ' · undone' : ''),
    })),
  );

  constructor() {
    effect((onCleanup) => {
      const id = this.jobs.selectedId();
      this.#imports.set([]);
      if (id === null) return;
      let stale = false;
      onCleanup(() => (stale = true));
      this.#csvImports.jobImports(id).then(
        (r) => {
          if (!stale) this.#imports.set(r.imports);
        },
        // The line is a nicety: a failed fetch leaves the log as it was.
        () => undefined,
      );
    });
  }

  protected readonly showingFlagged = computed(() => this.jobs.logFilter() === 'flagged');

  protected readonly heading = computed(() => {
    const job = this.jobs.selected();
    return job === null ? 'Run log' : `Run log · #${job.number}`;
  });

  /** `All` plus one segment per locale of the selected job, each with its entry count. */
  protected readonly filters = computed<readonly LocaleFilter[]>(() => {
    const job = this.jobs.selected();
    if (job === null) return [];
    const entries = this.jobs.filteredLog();
    const active = this.jobs.logLocale();
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.locale, (counts.get(e.locale) ?? 0) + 1);
    return [
      { value: 'all', label: 'All', count: entries.length, active: active === 'all' },
      ...job.locales.map((l) => ({
        value: l.locale,
        label: l.locale,
        count: counts.get(l.locale) ?? 0,
        active: active === l.locale,
      })),
    ];
  });

  protected readonly emptyText = computed(() => {
    const locale = this.jobs.logLocale();
    if (this.showingFlagged())
      return locale === 'all' ? 'Nothing flagged in this job.' : `Nothing flagged in ${locale}.`;
    if (locale === 'all') return 'Nothing has run yet.';
    const status = this.jobs.selected()?.locales.find((l) => l.locale === locale)?.status;
    if (status === 'skipped') return `${locale} was skipped. Its units stay untouched.`;
    return `No entries yet. ${locale} starts after the locale before it.`;
  });

  protected setLocale(value: LogLocaleFilter): void {
    this.jobs.setLogLocale(value);
  }

  protected readonly views = computed<readonly EntryView[]>(() =>
    this.jobs.visibleLog().map((entry) => {
      const archetype = archetypeOf(entry);
      const body =
        archetype === 'skipped' || archetype === 'failed'
          ? (entry.message ?? '')
          : archetype === 'rejected'
            ? (entry.rejection?.detail ?? '')
            : (translationOf(entry.run) ?? '');
      return {
        entry,
        archetype,
        badge: BADGE[archetype],
        unitId: splitRowId(entry.rowId).unitId,
        latency: formatLatency(entry.run),
        meta: metaOf(archetype, entry),
        body,
      };
    }),
  );

  protected showAll(): void {
    this.jobs.setLogFilter('all');
  }

  protected export(): void {
    const blob = new Blob([JSON.stringify(this.jobs.visibleLog(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const job = this.jobs.selected();
    const jobId = job === null ? 'job' : `job-${job.number}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${jobId}-run-log.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

/** The local HH:MM of an ISO instant. */
function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function metaOf(archetype: Archetype, entry: RunLogEntry): string {
  if (archetype === 'reviewer-note')
    return `notes_for_reviewer: "${entry.run?.notesForReviewer ?? ''}"`;
  if (archetype === 'termbase') return 'from the Term Base · no model asked';
  if (archetype === 'retry') return `retry · ${((entry.run?.latencyMs ?? 0) / 1000).toFixed(1)} s`;
  if (archetype === 'accepted') {
    const confidence = entry.run?.confidence;
    return confidence ? `confidence ${confidence}` : '';
  }
  return '';
}
