// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';

import type {
  Finding,
  Job,
  JobLogOutcome,
  JobRecord,
  RunLogEntry,
  SegmentDto,
  TranslateRejection,
  UnitLocation,
  UnitNote,
  UnitState,
} from '@lexi/shared';

import { notFound } from '../lib/http-error.js';
import { readJobLogLines, readJobRecord } from '../lib/lexi-dir.js';
import { dtoContextOf, toWireDetail } from '../lib/unit-dto.js';
import type { ProjectService } from './project-service.js';

/**
 * The review report for one job: everything a native speaker needs to judge
 * what the model wrote, gathered so `job-report-html.ts` only has to lay it out.
 *
 * Read from DISK — the job's record and run log — rather than from the queue,
 * which forgets every job when the server restarts. The live index adds what a
 * log line does not carry (the key's notes, where it is used, what the cell
 * says now); a unit the index no longer has is still reported from its log.
 */
export interface JobReport {
  readonly record: JobRecord;
  readonly generatedAt: string;
  /**
   * The system message most units were sent, shown once at the top rather than
   * on every card. Null when no unit carries a prompt (a log written before
   * prompts were kept).
   */
  readonly sharedSystem: string | null;
  /** Grouped by locale, in the job's run order; inside a locale, in its unit order. */
  readonly units: readonly ReportUnit[];
}

export interface ReportUnit {
  /** 1-based, counted across the whole job — what a reviewer quotes back ("#12"). */
  readonly no: number;
  readonly locale: string;
  readonly rowId: string;
  readonly unitId: string;
  readonly group: string | null;
  readonly outcome: JobLogOutcome;
  readonly notes: readonly UnitNote[];
  readonly locations: readonly UnitLocation[];
  readonly source: readonly SegmentDto[];
  /** What the job wrote. Null for every outcome but `accepted`. */
  readonly written: readonly SegmentDto[] | null;
  /** What the cell holds now, when that differs from `written` (edited, reviewed, reverted). */
  readonly current: readonly SegmentDto[] | null;
  /** For a skipped unit, the translation the job left in place (what the cell holds now). */
  readonly kept: readonly SegmentDto[] | null;
  readonly currentState: UnitState | null;
  readonly confidence: string | null;
  readonly notesForReviewer: string | null;
  readonly findings: readonly Finding[];
  readonly rejection: TranslateRejection | null;
  /** Why a unit was skipped or failed. */
  readonly message: string | null;
  /** The model's verbatim answer; shown for rejections, where it is all there is. */
  readonly raw: string | null;
  /** This unit's system message, only when it differs from `sharedSystem`. */
  readonly system: string | null;
  readonly user: string | null;
  /**
   * A batch's user message names every unit in it, so only the first card of
   * the request shows it; the others point there with this number.
   */
  readonly userShownAt: number | null;
  /** Set when the unit shared a request with others (FR-6.8). */
  readonly batch: { readonly size: number; readonly key: string } | null;
  /** The key no longer resolves in the open project. */
  readonly gone: boolean;
}

export interface JobReportDeps {
  readonly projects: ProjectService;
  /** The folder the job ran in, when the queue still knows it. */
  readonly projectPathOf: (jobId: string) => string | null;
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

const sameSegments = (a: readonly SegmentDto[], b: readonly SegmentDto[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export async function buildJobReport(deps: JobReportDeps, jobId: string): Promise<JobReport> {
  const { projects } = deps;
  const projectPath = deps.projectPathOf(jobId) ?? projects.current?.path ?? null;
  const stored =
    projectPath === null ? null : await readJobRecord<StoredJobRecord>(projectPath, jobId);
  if (projectPath === null || stored === null) {
    throw notFound(`no report for job ${jobId}: it is unknown, or ran before reports were kept`);
  }

  const record = normalizeRecord(stored);
  const entries = (await readJobLogLines<RunLogEntry>(projectPath, jobId)).sort(
    (a, b) => a.seq - b.seq,
  );
  // A row can appear once per locale, so the key is both.
  const keyOf = (locale: string, rowId: string): string => `${locale}\u0000${rowId}`;
  const byRow = new Map(entries.map((e) => [keyOf(e.locale, e.rowId), e]));

  // The job's project may have been closed since; its index then describes
  // somebody else's keys and must not be read for this report.
  const index = projects.current?.path === projectPath ? projects.index : null;
  const ctx = index === null ? null : dtoContextOf(projects);

  // The most common system message is the shared one. Usually there is only
  // one; a glossary-matched term block makes them differ per unit.
  const systems = new Map<string, { text: string; count: number }>();
  for (const e of entries) {
    const system = e.run?.prompt?.system;
    if (system === undefined) continue;
    const key = hashOf(system);
    const seen = systems.get(key);
    if (seen) seen.count += 1;
    else systems.set(key, { text: system, count: 1 });
  }
  const sharedSystem = [...systems.values()].sort((a, b) => b.count - a.count)[0]?.text ?? null;

  const units: ReportUnit[] = [];
  const userShown = new Map<string, number>();
  let no = 0;
  for (const { locale, rowId } of record.job.locales.flatMap((l) =>
    l.ids.map((rowId) => ({ locale: l.locale, rowId })),
  )) {
    no += 1;
    const entry = byRow.get(keyOf(locale, rowId));
    // Never reached (cancelled before its turn, or its locale skipped): nothing to review.
    if (entry === undefined) continue;

    const row = index?.byRowId.get(rowId);
    const detail = row && ctx ? toWireDetail(row, [locale], ctx) : null;
    const now = detail?.targets.find((t) => t.locale === locale) ?? null;
    const written = entry.outcome === 'accepted' ? (entry.target?.segments ?? null) : null;
    const changed = now !== null && written !== null && !sameSegments(now.segments, written);
    const prompt = entry.run?.prompt;
    const userKey = prompt === undefined ? null : hashOf(prompt.user);
    const shownAt = userKey === null ? undefined : userShown.get(userKey);
    if (userKey !== null && shownAt === undefined) userShown.set(userKey, no);

    units.push({
      no,
      locale,
      rowId,
      unitId: detail?.unitId ?? rowId,
      group: detail?.group ?? null,
      outcome: entry.outcome,
      notes: detail?.notes ?? [],
      locations: detail?.locations ?? [],
      source: detail?.source ?? [],
      written,
      current: changed ? now.segments : null,
      kept: entry.outcome === 'skipped' ? (now?.segments ?? null) : null,
      currentState: now?.state ?? null,
      confidence: entry.run?.confidence ?? null,
      notesForReviewer: entry.run?.notesForReviewer ?? null,
      findings: now?.findings ?? entry.findings,
      rejection: entry.rejection,
      message: entry.message,
      raw: entry.outcome === 'rejected' ? (entry.run?.raw ?? null) : null,
      system: prompt !== undefined && prompt.system !== sharedSystem ? prompt.system : null,
      user: shownAt === undefined ? (prompt?.user ?? null) : null,
      userShownAt: shownAt ?? null,
      batch: entry.run?.batch ?? null,
      gone: detail === null,
    });
  }

  return { record, generatedAt: new Date().toISOString(), sharedSystem, units };
}

/**
 * A record as it may be on disk: written by this version, by one from before
 * jobs could be named (no `job.name`; it reads as null, the default title), or
 * by one from before jobs held several locales — `job.locale` + `job.ids` and
 * one locale style guide. Those still open as a one-locale job.
 */
type LegacyJob = Omit<Job, 'locales' | 'number' | 'task' | 'currentLocale' | 'name'> & {
  locale: string;
  ids: string[];
  total: number;
  currentIndex: number;
  currentRowId: string | null;
  accepted: number;
  rejected: number;
  skipped: number;
  failed: number;
};
type UnnamedJobRecord = Omit<JobRecord, 'job'> & {
  job: Omit<Job, 'name'> & { name?: string | null };
};
export type StoredJobRecord =
  | UnnamedJobRecord
  | (Omit<JobRecord, 'job' | 'styleguides'> & {
      job: LegacyJob;
      styleguides: {
        global: { name: string; text: string } | null;
        locale: { name: string; text: string } | null;
      };
    });

export function normalizeRecord(stored: StoredJobRecord): JobRecord {
  // A record from before jobs could be named has no `name`: it gets the default title.
  if ('locales' in stored.job) {
    const record = stored as UnnamedJobRecord;
    return { ...record, job: { ...record.job, name: record.job.name ?? null } };
  }
  const legacy = stored as Extract<StoredJobRecord, { job: LegacyJob }>;
  const { job } = legacy;
  return {
    ...legacy,
    job: {
      id: job.id,
      number: 1,
      task: 'draft',
      name: null,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      currentLocale: null,
      avgMsPerUnit: job.avgMsPerUnit,
      pendingReview: job.pendingReview,
      locales: [
        {
          locale: job.locale,
          status: job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'cancelled',
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          total: job.total,
          ids: job.ids,
          currentIndex: job.currentIndex,
          currentRowId: job.currentRowId,
          accepted: job.accepted,
          rejected: job.rejected,
          skipped: job.skipped,
          failed: job.failed,
          avgMsPerUnit: job.avgMsPerUnit,
          pendingReview: job.pendingReview,
        },
      ],
    },
    styleguides: {
      global: legacy.styleguides.global,
      locales: { [job.locale]: legacy.styleguides.locale },
    },
  };
}
