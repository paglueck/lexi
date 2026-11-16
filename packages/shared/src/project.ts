// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { GRID_FILTERS, LOCALE_SOURCES, RULE_IDS } from './constants.js';
import { EscapePolicySchema, SeveritySchema, WriteStateModeSchema } from './xliff-enums.js';

/**
 * Opening a project: `POST /api/projects/scan`, `POST /api/projects/open`,
 * `GET/PATCH /api/project`, and the recents list behind S1.
 *
 * The scan step is deliberately separate from the open step. FR-1.3 requires a
 * confirmation before anything is treated as authoritative, and FR-1.2b requires
 * the disagreements to be shown rather than resolved — so scan reports what it
 * found and how it found it, and open records what the user confirmed.
 */

/** One `<file>` element. A document may hold several, each with its own locale. */
export const ScannedFileSchema = z.object({
  /** Absolute, realpath'd. */
  path: z.string(),
  /** Relative to the project root — what the wizard displays. */
  relPath: z.string(),
  /** Which `<file>` inside the document. Almost always 0, but see edge/two-files. */
  fileIndex: z.number().int().nonnegative(),
  /** The correlation key: `messages.de.xlf` and `de/messages.xlf` share one. */
  group: z.string(),
  locale: z.string().nullable(),
  localeSource: z.enum(LOCALE_SOURCES),
  /** `target-language` as written, when it disagrees with the path (FR-1.2b). */
  conflictingTargetLanguage: z.string().nullable(),
  sourceLanguage: z.string().nullable(),
  targetLanguage: z.string().nullable(),
  unitCount: z.number().int().nonnegative(),
  /** No targets and the languages agree — the extraction template (FR-1.2a). */
  isTemplate: z.boolean(),
  isRtl: z.boolean(),
});
export type ScannedFile = z.infer<typeof ScannedFileSchema>;

export const ProjectScanRequestSchema = z.object({
  path: z.string().min(1),
});
export type ProjectScanRequest = z.infer<typeof ProjectScanRequestSchema>;

export const ProjectScanResponseSchema = z.object({
  root: z.string(),
  files: z.array(ScannedFileSchema),
  /** Shown verbatim in the wizard header ("scanned recursively in 0.4 s"). */
  durationMs: z.number(),
  /** Files that are XLIFF by extension but could not be parsed. Never silent. */
  skipped: z.array(z.object({ relPath: z.string(), reason: z.string() })),
  /** The locale the wizard should propose: the extraction template's. */
  suggestedSourceLocale: z.string().nullable(),
  /**
   * What `.lexi/project.json` recorded the last time this folder was opened,
   * keyed by `relPath`. Null on a first open. The wizard prefills from it when a
   * user deliberately re-maps an existing project.
   */
  saved: z
    .object({
      sourceLocale: z.string(),
      mapping: z.array(
        z.object({ relPath: z.string(), fileIndex: z.number().int(), locale: z.string() }),
      ),
    })
    .nullable(),
});
export type ProjectScanResponse = z.infer<typeof ProjectScanResponseSchema>;

/** One confirmed row of the wizard table. */
export const FileMappingSchema = z.object({
  path: z.string(),
  fileIndex: z.number().int().nonnegative(),
  locale: z.string().min(1),
  /** The amber "Fix to pt-BR" action: rewrite `target-language` on open. */
  fixTargetLanguage: z.boolean().default(false),
});
export type FileMapping = z.infer<typeof FileMappingSchema>;

export const ProjectOpenRequestSchema = z.object({
  path: z.string().min(1),
  mapping: z.array(FileMappingSchema).min(1),
  sourceLocale: z.string().min(1),
});
export type ProjectOpenRequest = z.infer<typeof ProjectOpenRequestSchema>;

/** Per-locale totals, enough for the dashboard's first cut (FR-2.2, FR-2.3). */
export const LocaleSummarySchema = z.object({
  locale: z.string(),
  isRtl: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  unitCount: z.number().int().nonnegative(),
  /** Reviewed AND final — the two states that need nobody's attention. */
  translated: z.number().int().nonnegative(),
  untranslated: z.number().int().nonnegative(),
  /**
   * Split from `needsReview` in M7, because S3's coverage bar has four segments
   * and the two it separates are answers to different questions: a machine
   * draft is work the tool produced and nobody has looked at, a needs-review
   * target is work a human touched. Lumping them was defensible while nothing
   * could produce a draft; from M11 on it would hide the metric the whole MVP
   * exists to measure.
   */
  draftMachine: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  /** In the source but absent from this locale's file altogether (FR-2.2). */
  missing: z.number().int().nonnegative(),
  /** Present here but no longer in the source — the re-hash casualties (FR-2.2). */
  orphans: z.number().int().nonnegative(),
});
export type LocaleSummary = z.infer<typeof LocaleSummarySchema>;

/**
 * One validation rule, aggregated across the project (FR-8.3).
 *
 * What the dashboard's needs-attention rail renders, each entry linking to
 * the Issues screen (S12, `./issues.ts`): which rule, how badly, and in which
 * locale, with enough detail to write "pl is missing `few`/`many` on 9 units"
 * rather than "9 issues".
 */
export const RuleIssueSchema = z.object({
  rule: z.enum(RULE_IDS),
  severity: z.enum(['error', 'warning']),
  /** Locale cells carrying at least one finding of this rule. */
  cells: z.number().int().nonnegative(),
  /** Distinct units, which is the number a human thinks in. */
  units: z.number().int().nonnegative(),
  /** Worst locale first. Empty only when `cells` is 0, which is not reported. */
  locales: z.array(z.object({ locale: z.string(), cells: z.number().int().nonnegative() })),
});
export type RuleIssue = z.infer<typeof RuleIssueSchema>;

/**
 * The dashboard's stat strip and needs-attention rail (S3).
 *
 * Recomputed from the row model on every `GET /api/project`, exactly as
 * `locales` is, so an edit moves these figures without an invalidation path to
 * get wrong.
 */
export const ProjectHealthSchema = z.object({
  /** Distinct keys — the same number as `Project.unitCount`, repeated here so the strip reads from one object. */
  units: z.number().int().nonnegative(),
  /** FR-4.4: units carrying at least one note, and the share as a percentage. */
  unitsWithNote: z.number().int().nonnegative(),
  noteCoverage: z.number(),
  /** FR-2.5b's health metric, as a count and a percentage. */
  customIdUnits: z.number().int().nonnegative(),
  customIdShare: z.number(),
  /** Cells with at least one error-severity finding — the strip's "Open issues". */
  errorCells: z.number().int().nonnegative(),
  warningCells: z.number().int().nonnegative(),
  /** Units that have drifted since the last open (FR-2.5b). */
  staleUnits: z.number().int().nonnegative(),
  /** Errors before warnings, then by size. Rules with no findings are omitted. */
  issues: z.array(RuleIssueSchema),
});
export type ProjectHealth = z.infer<typeof ProjectHealthSchema>;

/**
 * FR-7.4's edit rate, per locale — requirements §10's headline success metric ("share of
 * machine drafts approved without edit"). A lifetime cumulative total, not a
 * window: see `apps/server/src/lib/review-stats.ts` for why it is a two-bucket
 * counter rather than FR-7.5's (out of scope for M12) full per-unit history.
 */
export const EditRateLocaleStatsSchema = z.object({
  locale: z.string(),
  /** Approved with the machine's own text, unchanged. */
  approvedClean: z.number().int().nonnegative(),
  /** Edited, or rejected, before being approved. */
  corrected: z.number().int().nonnegative(),
  /** 0-100. Null when nothing has been reviewed for this locale yet. */
  rate: z.number().nullable(),
});
export type EditRateLocaleStats = z.infer<typeof EditRateLocaleStatsSchema>;

export const ProjectSchema = z.object({
  /** The project directory, absolute and realpath'd. */
  path: z.string(),
  /** Its basename — what the title bar shows. */
  name: z.string(),
  sourceLocale: z.string(),
  files: z.array(ScannedFileSchema),
  /**
   * TARGET locales only. The source locale has no targets, so a progress row
   * for it could only ever read "0% translated", which is false rather than
   * merely uninteresting.
   */
  locales: z.array(LocaleSummarySchema),
  /** Distinct keys in the project — FR-2.2's "total keys", counted once. */
  unitCount: z.number().int().nonnegative(),
  /** Share of units on developer-assigned ids, as a percentage (FR-2.5b). */
  customIdShare: z.number(),
  /** The stat strip and the needs-attention rail (S3, M7). */
  health: ProjectHealthSchema,
  /** FR-7.4's edit rate, one entry per target locale (S3, M12). */
  editRate: z.array(EditRateLocaleStatsSchema),
  /** Which locale columns the grid shows. Restored from `.lexi/project.json`. */
  visibleLocales: z.array(z.string()),
  /** The left rail's ticked boxes, likewise restored (FR-3.2). */
  filters: z.array(z.enum(GRID_FILTERS)),
  groups: z.array(z.string()),
  openedAt: z.string(),
  /**
   * Whether a save writes `state` attributes (requirements §4.2).
   *
   * `auto` — the default — writes them only into files that already use them,
   * decided per `<file>` through `hasAnyStateAttr`. Angular's own serializer
   * emits no `state`, while `ng-extract-i18n-merge` does. Defaulting to "always
   * on" would spray `state="translated"` across every touched target on the
   * first save in a repository that does not use the merge tool, turning a
   * one-word change into two changed lines and undoing the diff quality the
   * whole splice design exists to protect (NFR-8).
   */
  writeState: WriteStateModeSchema,
  escapePolicy: EscapePolicySchema,
  /**
   * Per-rule severity, so a project can downgrade a rule it disagrees with
   * (FR-8.2). Partial: a rule the project has never configured falls back to the
   * engine's default, and `.lexi/project.json` need not list all ten.
   */
  severities: z.partialRecord(z.enum(RULE_IDS), SeveritySchema),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * `POST /api/projects/resume` — open a folder with what `.lexi/project.json`
 * saved, so only the first open goes through the wizard. `needsSetup` means
 * there is nothing usable saved and the client should scan and run the wizard.
 */
export const ProjectResumeRequestSchema = ProjectScanRequestSchema;
export type ProjectResumeRequest = z.infer<typeof ProjectResumeRequestSchema>;

export type ProjectResumeResponse =
  { readonly needsSetup: false; readonly project: Project } | { readonly needsSetup: true };

/** Everything a user can change after opening. All optional (FR-2.1, FR-3.2). */
export const ProjectPatchSchema = z.object({
  sourceLocale: z.string().min(1).optional(),
  visibleLocales: z.array(z.string()).optional(),
  /** The left rail's ticked boxes. Persisted with the project (FR-3.2, FR-3.4). */
  filters: z.array(z.enum(GRID_FILTERS)).optional(),
  writeState: WriteStateModeSchema.optional(),
  escapePolicy: EscapePolicySchema.optional(),
  severities: z.partialRecord(z.enum(RULE_IDS), SeveritySchema).optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

/**
 * `POST /api/locales/file` — start a locale that has no file yet (FR-1.9).
 *
 * Explicit, and a separate call from editing, because it is a decision about
 * the project's shape rather than about a string: a new `.xlf` appears in
 * somebody's repository and their build has to be told about it. Inserting a
 * missing `<trans-unit>` into a file that DOES exist needs no such ceremony —
 * writing a translation into a file plainly means the unit has to be there —
 * and happens as part of an ordinary edit.
 */
export const CreateLocaleFileRequestSchema = z
  .object({
    /** Which file group to start, e.g. `messages` or `checkout/messages`. */
    group: z.string(),
    locale: z.string().min(1).max(35),
  })
  .strict();
export type CreateLocaleFileRequest = z.infer<typeof CreateLocaleFileRequestSchema>;

export const CreateLocaleFileResponseSchema = z.object({
  /** The new file, relative to the project root. */
  created: z.string(),
  /** The project as it now is, so the client need not ask again. */
  project: ProjectSchema,
});
export type CreateLocaleFileResponse = z.infer<typeof CreateLocaleFileResponseSchema>;

/** `~/.lexi/recents.json`, rendered as S1's recent list (FR-1.7). */
export const RecentProjectSchema = z.object({
  /** Stable id so DELETE /api/recents/:id needs no path in the URL. */
  id: z.string(),
  path: z.string(),
  name: z.string(),
  openedAt: z.string(),
  localeCount: z.number().int().nonnegative(),
  unitCount: z.number().int().nonnegative(),
  /** Coverage shares for the row's 4px bar. Percentages of unitCount. */
  coverage: z.object({
    translated: z.number(),
    draft: z.number(),
    needsReview: z.number(),
  }),
  /**
   * Where the project came from, read from `.lexi/phrase.json` when the list
   * is served. Absent for an ordinary folder.
   */
  origin: z
    .object({
      kind: z.literal('phrase'),
      /** The checked-out tags; empty when every key was checked out. */
      tags: z.array(z.string()),
    })
    .optional(),
  /** Whether the folder still exists, checked when the list is served. */
  exists: z.boolean(),
});
export type RecentProject = z.infer<typeof RecentProjectSchema>;

export const RecentsResponseSchema = z.object({
  recents: z.array(RecentProjectSchema),
});
export type RecentsResponse = z.infer<typeof RecentsResponseSchema>;

/** `POST /api/recents/:id/locate` — the folder moved; point the entry at its new place. */
export const LocateRecentRequestSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
export type LocateRecentRequest = z.infer<typeof LocateRecentRequestSchema>;
