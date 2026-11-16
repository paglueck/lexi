// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { PHRASE_CHECKOUT_STEPS, PHRASE_CHECKOUT_STEP_STATES } from './constants.js';
import { JobLocaleStatusSchema, JobStatusSchema, RunLogEntrySchema } from './jobs.js';
import { SHARED_SOURCE_KINDS } from './shared-sources.js';
import { UpdateStateSchema } from './update.js';

/**
 * `GET /api/events` — ONE multiplexed SSE stream, not one per job.
 * HTTP/1.1 caps around six connections per origin.
 *
 * `index-updated` (M5) still has no concrete need for a payload of its own —
 * the dashboard and grid both recompute from `GET /api/project` /
 * `POST /api/units/query` on their own triggers — so it stays unschematised
 * until something actually wants to push rather than pull.
 */
export const LexiEventSchema = z.discriminatedUnion('type', [
  /** Sent once on connect. `serverId` changes per process, so a client can tell a restart from a reconnect. */
  z.object({
    type: z.literal('hello'),
    serverId: z.string(),
    at: z.number().int(),
  }),
  /** A real named event rather than a `:` comment, so it is visible to the client and testable. */
  z.object({
    type: z.literal('heartbeat'),
    at: z.number().int(),
  }),
  /** FR-1.5 — files changed on disk (e.g. after `git pull`); the client offers a reload. */
  z.object({
    type: z.literal('file-changed'),
    paths: z.array(z.string()),
  }),
  /**
   * A linked style guide folder or Term Base changed on disk — a `git pull` in
   * the shared repository, or another project writing to it. Only sent when
   * the content actually differs from what this process last saw, so a save
   * made here does not echo back.
   */
  z.object({
    type: z.literal('shared-source-changed'),
    source: z.enum(SHARED_SOURCE_KINDS),
  }),
  /**
   * FR-1.6 — a save finished. Carries what was actually WRITTEN, which is not
   * the same as what was asked for: a file whose text did not change is never
   * rewritten, so it appears in neither list the client acts on.
   */
  z.object({
    type: z.literal('save-complete'),
    written: z.array(z.string()),
    at: z.string(),
  }),
  /**
   * FR-6.7 — one unit finished. The counters are THAT LOCALE's (S14's locale
   * row); `jobAvgMsPerUnit` is the job-wide mean the card's ETA is built from.
   */
  z.object({
    type: z.literal('job-progress'),
    jobId: z.string(),
    locale: z.string(),
    jobAvgMsPerUnit: z.number().nonnegative().nullable(),
    currentIndex: z.number().int().nonnegative(),
    currentRowId: z.string().nullable(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    avgMsPerUnit: z.number().nonnegative().nullable(),
  }),
  /**
   * A job's lifecycle transition — queued/running/paused/done/cancelled/failed.
   *
   * The two timestamps ride along because THIS IS THE ONLY MOMENT THEY CHANGE,
   * and until M15 they never reached the browser at all: the frame carried
   * `status` alone, `applyJobFrame` patched `status` alone, and so a job you
   * watched run to completion finished with `startedAt`/`finishedAt` still
   * holding whatever the `POST /api/jobs` response happened to say — `null` for
   * anything that queued behind another job. The card's timestamp then rendered
   * empty until a reload, which is exactly the case nobody reloads for.
   *
   * Nullable rather than optional: a queued job has no start, and a job
   * cancelled before it ran has neither. The server sets both BEFORE publishing,
   * so a frame never disagrees with a subsequent `GET /api/jobs`.
   */
  z.object({
    type: z.literal('job-state'),
    jobId: z.string(),
    status: JobStatusSchema,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  }),
  /**
   * One locale's lifecycle transition inside a job — it started, paused, was
   * skipped or put back, finished, or was cancelled with the job. Timestamps
   * ride along for the same reason as `job-state`'s.
   */
  z.object({
    type: z.literal('job-locale-state'),
    jobId: z.string(),
    locale: z.string(),
    status: JobLocaleStatusSchema,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  }),
  /** A queued job was removed from the queue (S14's "Remove"). It no longer exists. */
  z.object({
    type: z.literal('job-removed'),
    jobId: z.string(),
  }),
  /** One run-log entry (FR-6.14), the moment it is written to `.lexi/logs/<jobId>.jsonl`. */
  z.object({
    type: z.literal('job-log'),
    jobId: z.string(),
    entry: RunLogEntrySchema,
  }),
  /** One file of a `POST /api/phrase/push`, as it moves through upload and processing. */
  z.object({
    type: z.literal('phrase-push-progress'),
    index: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    relPath: z.string(),
    localeId: z.string(),
    stage: z.enum(['uploading', 'processing', 'done', 'failed']),
  }),
  /**
   * A Phrase checkout moved: one of its six log rows started, waits for the
   * rate limit, finished or failed. `detail` is the row's right-hand text.
   */
  z.object({
    type: z.literal('phrase-checkout-progress'),
    step: z.enum(PHRASE_CHECKOUT_STEPS),
    state: z.enum(PHRASE_CHECKOUT_STEP_STATES),
    detail: z.string(),
  }),
  /** The desktop updater moved: a check started or ended, or a download made progress. */
  z.object({
    type: z.literal('update'),
    state: UpdateStateSchema,
  }),
]);
export type LexiEvent = z.infer<typeof LexiEventSchema>;
export type LexiEventType = LexiEvent['type'];
