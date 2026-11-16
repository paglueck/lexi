// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { FIX_KINDS } from './constants.js';
import { SegmentSchema, TargetPatchResponseSchema } from './units.js';
import { FindingSchema, RuleIdSchema, SeveritySchema, UnitStateSchema } from './xliff-enums.js';

/**
 * The Issues screen (S12, FR-8.3): every validation finding across the project,
 * grouped by rule.
 *
 * Findings are recomputed from the row model on every read, like the dashboard,
 * so the screen cannot disagree with the grid. Ignored findings (FR-8.3's
 * "ignore for this unit") are left out of every count here AND of the grid's
 * and dashboard's, which read the same index.
 */

/** One rule in the rule list. Rules with no open findings are not sent. */
export const IssueRuleSummarySchema = z.object({
  rule: RuleIdSchema,
  severity: z.enum(['error', 'warning']),
  /** Open findings, not cells: a rule can fire twice on one cell. */
  count: z.number().int().nonnegative(),
  locales: z.array(z.string()),
});
export type IssueRuleSummary = z.infer<typeof IssueRuleSummarySchema>;

/** `GET /api/issues?locale=` */
export const IssuesSummarySchema = z.object({
  /** When the index was last rebuilt, epoch ms. */
  validatedAt: z.number(),
  /** Distinct units in the project. */
  units: z.number().int().nonnegative(),
  /** Target locales that have at least one open finding, for the locale chips. */
  locales: z.array(z.string()),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  /** Findings hidden by an ignore that is still valid. */
  ignored: z.number().int().nonnegative(),
  /** Rules configured `off` (FR-8.2). */
  rulesOff: z.number().int().nonnegative(),
  /** Errors first, then by count. */
  rules: z.array(IssueRuleSummarySchema),
});
export type IssuesSummary = z.infer<typeof IssuesSummarySchema>;

export const IssueFixSchema = z.object({
  kind: z.enum(FIX_KINDS),
  explanation: z.string(),
  origin: z.string(),
  /** The whole patched target, so the preview needs no second request. */
  segments: z.array(SegmentSchema),
  /** Top-level indices in `segments` the fix produced. */
  changed: z.array(z.number().int().nonnegative()),
});
export type IssueFix = z.infer<typeof IssueFixSchema>;

/** One row of the findings table. */
export const IssueFindingSchema = FindingSchema.extend({
  rowId: z.string(),
  unitId: z.string(),
  group: z.string(),
  locale: z.string(),
  /** The locale's file, relative to the project root. */
  file: z.string(),
  state: UnitStateSchema,
  /** The target, truncated the way the grid truncates it. */
  excerpt: z.array(SegmentSchema),
  /** Present only when exactly one fix is right (see `suggestFix`). */
  fix: IssueFixSchema.nullable(),
});
export type IssueFinding = z.infer<typeof IssueFindingSchema>;

/** `GET /api/issues/rules/:rule?locale=` */
export const IssueFindingsResponseSchema = z.object({
  rule: RuleIdSchema,
  severity: SeveritySchema,
  findings: z.array(IssueFindingSchema),
});
export type IssueFindingsResponse = z.infer<typeof IssueFindingsResponseSchema>;

/** Names one finding. The server recomputes everything else. */
export const IssueRefSchema = z.object({
  rowId: z.string().min(1),
  locale: z.string().min(1),
  rule: RuleIdSchema,
});
export type IssueRef = z.infer<typeof IssueRefSchema>;

/** `POST /api/issues/fix` answers like a target PATCH. */
export const IssueFixResponseSchema = TargetPatchResponseSchema;
export type IssueFixResponse = z.infer<typeof IssueFixResponseSchema>;

/** `POST /api/issues/fix-all` */
export const IssueFixAllRequestSchema = z.object({
  rule: RuleIdSchema,
  locale: z.string().min(1).optional(),
});
export type IssueFixAllRequest = z.infer<typeof IssueFixAllRequestSchema>;

export const IssueFixAllResponseSchema = z.object({
  applied: z.number().int().nonnegative(),
  unsavedCount: z.number().int().nonnegative(),
});
export type IssueFixAllResponse = z.infer<typeof IssueFixAllResponseSchema>;

/** `GET /api/issues/ignored`: what the rule-list footer can un-ignore. */
export const IgnoredFindingSchema = IssueRefSchema.extend({
  unitId: z.string(),
  group: z.string(),
});
export type IgnoredFinding = z.infer<typeof IgnoredFindingSchema>;

export const IgnoredFindingsResponseSchema = z.object({ ignored: z.array(IgnoredFindingSchema) });
export type IgnoredFindingsResponse = z.infer<typeof IgnoredFindingsResponseSchema>;
