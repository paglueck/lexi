// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

/**
 * `/api/termbase` — the Term Base tab (FR-5.8, FR-5.9), formerly the glossary
 * pane on S6.
 *
 * Stored as `.lexi/termbase.csv` — one row per term, one column per locale
 * (`termbase-csv.ts`), so the file a team commits is the same shape as the file
 * it imports. A project that still has the old `.lexi/glossary.json` is
 * migrated on first read.
 *
 * THE FALLBACK RULE: a locale without a translation keeps the source term as
 * written, exactly as a do-not-translate term does in every locale. An empty
 * cell is an instruction, not a gap.
 */

export const TermSchema = z.object({
  /** Stable across edits, so the table and the editor can address a row. */
  id: z.string().min(1),
  /**
   * The source-language term, matched case-sensitively and on word boundaries.
   * Empty only for a row just added and not yet named — it never matches.
   */
  term: z.string(),
  /** Locale tag → fixed translation. Absent or empty means "keep the source". */
  translations: z.record(z.string(), z.string()),
  /**
   * Keep the term as written in EVERY locale. The stored translations are not
   * deleted when this is switched on — they are locked and come back when it
   * is switched off.
   */
  dnt: z.boolean(),
  /** Meaning or usage. Sent to the model with the term. */
  note: z.string(),
});
export type Term = z.infer<typeof TermSchema>;

export const TermBaseResponseSchema = z.object({
  terms: z.array(TermSchema),
  total: z.number().int().nonnegative(),
  /**
   * `.lexi/termbase.csv` — the toolbar's mono path label. The absolute path of
   * the linked file when the Term Base comes from a shared folder.
   */
  path: z.string(),
  /** True when the Term Base is read from a shared folder (`shared-sources.ts`). */
  linked: z.boolean(),
  /** False when that shared folder is missing on this machine. Always true when not linked. */
  available: z.boolean(),
});
export type TermBaseResponse = z.infer<typeof TermBaseResponseSchema>;

/** `.strict()`: an unrecognised key here would silently become a lost field. */
export const TermCreateRequestSchema = z
  .object({
    term: z.string().max(200).optional(),
    translations: z.record(z.string(), z.string()).optional(),
    dnt: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type TermCreateRequest = z.infer<typeof TermCreateRequestSchema>;

export const TermPatchRequestSchema = z
  .object({
    term: z.string().max(200).optional(),
    translations: z.record(z.string(), z.string()).optional(),
    dnt: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type TermPatchRequest = z.infer<typeof TermPatchRequestSchema>;

/** One parsed CSV row, before it has an id. */
export const TermImportRowSchema = z
  .object({
    term: z.string().min(1).max(200),
    note: z.string().max(2000),
    dnt: z.boolean(),
    translations: z.record(z.string(), z.string()),
  })
  .strict();
export type TermImportRow = z.infer<typeof TermImportRowSchema>;

export const TERM_IMPORT_MODES = ['overwrite', 'keep'] as const;
export type TermImportMode = (typeof TERM_IMPORT_MODES)[number];

export const TermImportRequestSchema = z
  .object({
    rows: z.array(TermImportRowSchema).max(20_000),
    mode: z.enum(TERM_IMPORT_MODES),
    /**
     * The locale columns the file carried. A project locale the file has no
     * column for says nothing about that locale, so an update leaves it alone
     * rather than clearing it. Absent means every project locale.
     */
    locales: z.array(z.string()).optional(),
  })
  .strict();
export type TermImportRequest = z.infer<typeof TermImportRequestSchema>;

export const TermImportResponseSchema = TermBaseResponseSchema.extend({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type TermImportResponse = z.infer<typeof TermImportResponseSchema>;
