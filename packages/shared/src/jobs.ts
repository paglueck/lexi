// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import {
  CSV_DELIMITERS,
  CSV_SPLITS,
  JOB_LOCALE_STATUSES,
  JOB_LOG_OUTCOMES,
  JOB_STATUSES,
  JOB_TASKS,
  REPORT_FORMATS,
} from './constants.js';
import { TranslateRejectionSchema, TranslateRunSchema } from './prompt.js';
import { LlmParamsSchema } from './settings.js';
import { UnitTargetSchema } from './units.js';
import { FindingSchema } from './xliff-enums.js';

/**
 * `POST /api/jobs`, `/api/jobs/:id/{pause,resume,cancel}`, `DELETE /api/jobs/:id`,
 * `/api/jobs/:id/locales/:locale/{skip,unskip}`, `GET /api/jobs/:id/log?after=` — M11.
 *
 * A job is ONE task over an ordered list of locales (S14). The locales run one
 * after another, each a loop over `translateUnit` (M9's single-unit path,
 * unchanged) plus bookkeeping: which unit is running, how many were
 * accepted/flagged/failed, and a run-log entry per unit. A failure inside one
 * locale never stops the next one — every unit's outcome is contained, and the
 * locale loop moves on regardless.
 *
 * Each locale is drafted with ITS Term Base entries and style guide, exactly as
 * a single-locale job used to be; nothing about the prompt is shared across
 * locales.
 */

export const JobStatusSchema = z.enum(JOB_STATUSES);
export const JobTaskSchema = z.enum(JOB_TASKS);
export const JobLocaleStatusSchema = z.enum(JOB_LOCALE_STATUSES);

export const JobCreateRequestSchema = z
  .object({
    task: JobTaskSchema.default('draft'),
    /**
     * In RUN order — the S15 modal's "As listed" / "Smallest first" is decided
     * on the client and stored as this order. Each locale carries the row ids
     * the client already has from its current filter (the "client owns
     * the id list"), counted per locale because a grid filter matches a row if
     * ANY visible locale matches.
     */
    locales: z
      .array(
        z
          .object({
            locale: z.string().min(1),
            ids: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1)
      .refine((locales) => new Set(locales.map((l) => l.locale)).size === locales.length, {
        message: 'each locale may appear only once',
      }),
    instruction: z.string().max(2000).optional(),
    /**
     * What the Jobs page calls the job instead of its generated title
     * ("Draft untranslated units · de, fr"). Trimmed; an empty name is the same
     * as none.
     */
    name: z.string().trim().max(120).optional(),
    /** FR-6.10, applied per unit inside the job rather than asked once for all of them. */
    overwrite: z.boolean().optional(),
  })
  .strict();
/** What a client sends — `task` may be left out. */
export type JobCreateRequest = z.input<typeof JobCreateRequestSchema>;
/** The same request once parsed, with `task` defaulted. */
export type ParsedJobCreateRequest = z.output<typeof JobCreateRequestSchema>;

const count = z.number().int().nonnegative();

/** One locale of a job: its own ids, counters and lifecycle. */
export const JobLocaleSchema = z.object({
  locale: z.string(),
  status: JobLocaleStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  total: count,
  /** The ordered ids this locale runs, so a reload can show the queue without a second request. */
  ids: z.array(z.string()),
  currentIndex: count,
  currentRowId: z.string().nullable(),
  accepted: count,
  rejected: count,
  /** Units the overwrite guard refused — NOT the locale status `skipped`. */
  skipped: count,
  failed: count,
  /** Mean latency of this locale's completed units. Null until its first unit finishes. */
  avgMsPerUnit: z.number().nonnegative().nullable(),
  /**
   * How many of the drafts this locale wrote are still waiting for a reviewer
   * (M15) — what the finished card's "Review N →" counts down.
   *
   * COMPUTED AT THE BOUNDARY, on every read, because nothing tells the queue
   * that a review happened: reviewing is an ordinary target PATCH and emits no
   * job event. The value on the queue's own live record is meaningless; only
   * what `JobQueue.withReview` hands to a route is real.
   */
  pendingReview: count,
});
export type JobLocale = z.infer<typeof JobLocaleSchema>;

export const JobSchema = z.object({
  id: z.string(),
  /** The short `#14` the queue shows. Counts up per server process; `id` stays the real key. */
  number: z.number().int().positive(),
  task: JobTaskSchema,
  /** The name the user gave the job; null means the client shows its generated title. */
  name: z.string().nullable(),
  status: JobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** In run order. */
  locales: z.array(JobLocaleSchema).min(1),
  /** The locale running (or paused) right now; null before the first starts and after the last. */
  currentLocale: z.string().nullable(),
  /**
   * Mean latency per unit across every locale completed so far, for the
   * card's "~4 min left". The client derives the ETA string — the server hands
   * over the numbers a presentation string would be built from, not the
   * string itself.
   */
  avgMsPerUnit: z.number().nonnegative().nullable(),
  /** Sum of the locales' `pendingReview`; computed at the boundary like theirs. */
  pendingReview: count,
});
export type Job = z.infer<typeof JobSchema>;

/**
 * One line of `.lexi/logs/<jobId>.jsonl` (FR-6.14) — the same shape
 * `TranslateUnitResponse` already carries per unit, plus the context a log
 * needs once it is no longer the only response in flight.
 *
 * `run` is present only for `accepted`/`rejected` — the model actually
 * answered. `rejection` is populated only for `rejected` — a restore-gate
 * failure (FR-6.11). `message` carries the human-readable reason for
 * `skipped` (FR-6.10's overwrite guard named the existing text) and `failed`
 * (an unreachable endpoint, a row that no longer resolves) — two different
 * sentences about two different moments, neither of which produced an answer
 * worth logging as `run`.
 *
 * `target` and `unsavedCount` are what a typed edit's response ALSO carries
 * (`TargetPatchResponse`), and for the same reason: `DraftStore.adopt` needs
 * them to mirror a machine draft into its client-side overlay exactly the way
 * it already does for a single-unit run (M9). Without this a job's drafts
 * exist only on the server — visible in the grid (which reads server-rendered
 * rows) but invisible to the Save button, which reads the client's own dirty
 * count. `target` is null for every outcome but `accepted`.
 */
export const RunLogEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  rowId: z.string(),
  locale: z.string(),
  outcome: z.enum(JOB_LOG_OUTCOMES),
  run: TranslateRunSchema.nullable(),
  rejection: TranslateRejectionSchema.nullable(),
  message: z.string().nullable(),
  findings: z.array(FindingSchema),
  target: UnitTargetSchema.nullable(),
  unsavedCount: z.number().int().nonnegative(),
});
export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

const StyleGuideSnapshotSchema = z.object({ name: z.string(), text: z.string() });

/**
 * `.lexi/logs/<jobId>.json` — what a job was TOLD, beside the `.jsonl` of what
 * it did, so the review report still works after the server restarts and the
 * in-memory `Job` is gone.
 *
 * `instruction` and `overwrite` live nowhere else once the queue forgets the
 * job, and the style guides are snapshotted at creation for the same reason
 * the run log keeps the prompt: the report shows what the model read, not
 * what the guide says today.
 */
export const JobRecordSchema = z.object({
  job: JobSchema,
  projectName: z.string(),
  sourceLocale: z.string(),
  instruction: z.string().nullable(),
  overwrite: z.boolean(),
  model: z.string(),
  params: LlmParamsSchema,
  styleguides: z.object({
    global: StyleGuideSnapshotSchema.nullable(),
    /** Keyed by locale code — each locale of the job read its own guide. */
    locales: z.record(z.string(), StyleGuideSnapshotSchema.nullable()),
  }),
  /**
   * Set when the person removed the job from the list. The record stays on disk
   * (its report and log still open), but a reopened project does not bring the
   * job card back.
   */
  dismissed: z.boolean().optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/** `POST /api/jobs/clear-finished`: the ids of the finished jobs taken off the list. */
export const JobsClearResponseSchema = z.object({ removed: z.array(z.string()) });
export type JobsClearResponse = z.infer<typeof JobsClearResponseSchema>;

export const JobLogResponseSchema = z.object({
  entries: z.array(RunLogEntrySchema),
});
export type JobLogResponse = z.infer<typeof JobLogResponseSchema>;

/** `GET /api/jobs/:id/report?format=&delimiter=&split=`. With no query it is the HTML report, as before. */
export const ReportQuerySchema = z.object({
  format: z.enum(REPORT_FORMATS).default('html'),
  delimiter: z.enum(CSV_DELIMITERS).default(';'),
  split: z.enum(CSV_SPLITS).default('single'),
});
export type ReportQuery = z.infer<typeof ReportQuerySchema>;
