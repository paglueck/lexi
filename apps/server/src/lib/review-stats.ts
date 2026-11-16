// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { readLexiJson, writeLexiJson } from './lexi-dir.js';
import type { ServerConfig } from '../config.js';

/**
 * `.lexi/review-stats.json` — FR-7.4's edit rate, and nothing more.
 *
 * FR-7.5 asks for a full per-unit history (who/what/when/from-which-state).
 * That is deliberately NOT what this file is: M12 ships only what the edit-rate
 * metric (requirements §10 — "share of machine drafts approved without edit") actually
 * needs, a two-bucket counter per locale. A real audit trail, if ever wanted, is
 * a later and considerably larger feature — an append-only log keyed like the
 * job logs, not a rewrite of this file.
 *
 * MACHINE-LOCAL, UNLIKE `state.json`. `state.json` is nested by group/unit/locale
 * specifically because map-shaped data merges cleanly across two git branches —
 * two different units' entries never collide. A scalar counter has no such
 * property: two reviewers on two branches each incrementing the same integer is
 * an unresolvable conflict on every concurrent review session. So this file is
 * NOT committed (`.lexi/.gitignore` lists it, `lib/lexi-dir.ts`), same posture as
 * `drafts.json`.
 *
 * Per locale, not one project-wide pair: style guides are per-locale (requirements §10's
 * own qualifier, "after style guides have been tuned"), and so is the metric's
 * usefulness.
 */

export type ReviewOutcome = 'approvedClean' | 'corrected';

export interface ReviewLocaleStats {
  readonly approvedClean: number;
  readonly corrected: number;
}

export type ReviewStats = ReadonlyMap<string, ReviewLocaleStats>;

interface ReviewStatsFile {
  readonly version: 1;
  readonly locales: Record<string, ReviewLocaleStats>;
}

const FILE = 'review-stats.json';

const isLocaleStats = (value: unknown): value is ReviewLocaleStats =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ReviewLocaleStats).approvedClean === 'number' &&
  typeof (value as ReviewLocaleStats).corrected === 'number';

/** Parse the file into the flat per-locale lookup. Anything unreadable yields none. */
export function reviewStatsOf(raw: unknown): ReviewStats {
  const out = new Map<string, ReviewLocaleStats>();
  const file = raw as Partial<ReviewStatsFile> | null;
  if (file === null || typeof file !== 'object' || typeof file.locales !== 'object') return out;

  for (const [locale, stats] of Object.entries(file.locales ?? {})) {
    if (isLocaleStats(stats)) out.set(locale, stats);
  }
  return out;
}

export function toReviewStatsFile(stats: ReviewStats): ReviewStatsFile {
  const locales: Record<string, ReviewLocaleStats> = {};
  for (const [locale, record] of stats) locales[locale] = record;
  return { version: 1, locales };
}

export const readReviewStats = async (projectPath: string): Promise<ReviewStats> =>
  reviewStatsOf(await readLexiJson<unknown>(projectPath, FILE));

export const writeReviewStats = (
  cfg: ServerConfig,
  projectPath: string,
  stats: ReviewStats,
): Promise<void> => writeLexiJson(cfg, projectPath, FILE, toReviewStatsFile(stats));

/**
 * Approve vs. correct, by comparing the bytes a reviewer just submitted against
 * the machine draft's own recorded hash (`lib/machine-origin.ts`).
 *
 * Called BEFORE the origin marker is forgotten — after that point there is
 * nothing left to compare against.
 */
export function classifyReviewOutcome(submittedHash: string, originHash: string): ReviewOutcome {
  return submittedHash === originHash ? 'approvedClean' : 'corrected';
}

/** Pure updater: one locale's counters, one outcome higher. */
export function recordOutcome(
  stats: ReviewStats,
  locale: string,
  outcome: ReviewOutcome,
): ReviewStats {
  const current = stats.get(locale) ?? { approvedClean: 0, corrected: 0 };
  const next = new Map(stats);
  next.set(locale, { ...current, [outcome]: current[outcome] + 1 });
  return next;
}
