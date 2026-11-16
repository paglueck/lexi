// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import {
  LLM_CONFIDENCES,
  LLM_PARSE_MODES,
  PLACEHOLDER_STYLES,
  PROMPT_BLOCK_KINDS,
} from './constants.js';
import { LlmParamsSchema } from './settings.js';
import { UnitTargetSchema } from './units.js';
import { FindingSchema } from './xliff-enums.js';

/**
 * `POST /api/prompt/preview` and `POST /api/translate/unit` — M9, screen S5.
 *
 * THE POINT OF THIS FILE: the prompt is composed ENTIRELY on the server and the
 * client renders the blocks it is handed. It composes nothing, concatenates
 * nothing and knows the order of nothing. That is what makes the preview
 * provably the same text the request carries (FR-5.7) rather than a second
 * implementation that agrees with the first until someone edits one of them.
 *
 * So the preview response is not "the data to build a prompt from". It is the
 * prompt, already built, cut into the blocks requirements §6 names so the screen can put
 * a token count and a caption beside each one.
 */

export const PlaceholderStyleSchema = z.enum(PLACEHOLDER_STYLES);

/* ---- preview ------------------------------------------------------------- */

export const PromptPreviewRequestSchema = z.object({
  rowId: z.string().min(1),
  locale: z.string().min(1),
  /** Omitted means the machine setting, which is what a real run would use. */
  placeholderStyle: PlaceholderStyleSchema.optional(),
  /** FR-6.12's "shorter" / "more formal", previewed before it is sent. */
  instruction: z.string().max(2000).optional(),
});
export type PromptPreviewRequest = z.infer<typeof PromptPreviewRequestSchema>;

/**
 * One named block of the composed prompt.
 *
 * `content` is verbatim — exactly the characters that go into the message, with
 * no rendering or re-wrapping on the way — because a preview that prettified
 * anything would stop being evidence.
 */
export const PromptBlockSchema = z.object({
  /** `role`, `invariants`, `styleguide.global`, `styleguide.de`, `terminology`, `user`. */
  id: z.string(),
  kind: z.enum(PROMPT_BLOCK_KINDS),
  /** Which message it lands in — S5's System / User segmented control. */
  role: z.enum(['system', 'user']),
  title: z.string(),
  /** The explanatory line S5 prints under the title. `''` for none. */
  caption: z.string(),
  content: z.string(),
  tokens: z.number().int().nonnegative(),
  /** `global.md`, `de.md` — the right-aligned mono label. Null when not a file. */
  source: z.string().nullable(),
  /**
   * The block exists in the prompt order but has nothing in it — no style guide
   * has been written yet, no glossary term matched.
   *
   * Rendered as an honest empty state rather than dropped, because "there is no
   * German style guide" is the single most useful thing this screen can tell
   * somebody whose drafts are coming back too informal.
   */
  empty: z.boolean(),
});
export type PromptBlock = z.infer<typeof PromptBlockSchema>;

/** One `[[n]]` token and what it stands for — S5's placeholder legend. */
export const PromptPlaceholderSchema = z.object({
  /** `[[0]]` in masked style, the element's id in raw style. */
  token: z.string(),
  label: z.string(),
  id: z.string(),
});
export type PromptPlaceholder = z.infer<typeof PromptPlaceholderSchema>;

/**
 * One line of the terminology list (FR-5.8, FR-5.9).
 *
 * `translation` is empty for a DNT term and for a term with no translation for
 * this locale — both mean "keep the source as written". `note` is the Term
 * Base's "note for the model". Both new fields default, so a job record
 * written before the Term Base still parses.
 */
export const PromptTermSchema = z.object({
  term: z.string(),
  translation: z.string(),
  dnt: z.boolean(),
  note: z.string().default(''),
});
export type PromptTerm = z.infer<typeof PromptTermSchema>;

export const PromptTotalsSchema = z.object({
  tokens: z.number().int().nonnegative(),
  system: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive(),
  /**
   * Always true before a run.
   *
   * FR-5.4 wants a token count before there is any way to obtain a real one, so
   * the meter shows a character-based approximation and says so. `usage` from
   * an actual completion replaces it afterwards (`TranslateRun.promptTokens`).
   */
  estimated: z.literal(true),
});
export type PromptTotals = z.infer<typeof PromptTotalsSchema>;

export const PromptPreviewResponseSchema = z.object({
  rowId: z.string(),
  unitId: z.string(),
  locale: z.string(),
  sourceLocale: z.string(),
  placeholderStyle: PlaceholderStyleSchema,
  blocks: z.array(PromptBlockSchema),
  totals: PromptTotalsSchema,
  /** The JSON contract, rendered for S5's `Schema` segment. */
  schema: z.string(),
  placeholders: z.array(PromptPlaceholderSchema),
  terminology: z.object({
    matched: z.array(PromptTermSchema),
    /** Terms in the term base altogether — S5's "2 of 148 terms matched". */
    total: z.number().int().nonnegative(),
  }),
  /** The footer's model and parameter summary: what a run would actually use. */
  model: z.string(),
  params: LlmParamsSchema,
  /** `''` when a model is configured. Otherwise why a run would fail right now. */
  blocked: z.string(),
});
export type PromptPreviewResponse = z.infer<typeof PromptPreviewResponseSchema>;

/* ---- translating one unit ------------------------------------------------ */

export const TranslateUnitRequestSchema = z
  .object({
    rowId: z.string().min(1),
    locale: z.string().min(1),
    placeholderStyle: PlaceholderStyleSchema.optional(),
    instruction: z.string().max(2000).optional(),
    /**
     * FR-6.10: a machine draft never silently replaces a human translation.
     * Without this the server refuses with 409 and says what is in the way.
     */
    overwrite: z.boolean().optional(),
  })
  .strict();
export type TranslateUnitRequest = z.infer<typeof TranslateUnitRequestSchema>;

/**
 * What the run itself did — FR-6.14's log entry, and the only honest source for
 * the question the MVP exists to answer.
 */
export const TranslateRunSchema = z.object({
  at: z.string(),
  model: z.string(),
  placeholderStyle: PlaceholderStyleSchema,
  latencyMs: z.number().int().nonnegative(),
  /** From the server's `usage`, where it reports one. Null otherwise. */
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  /**
   * Of `completionTokens`, how many the model spent thinking rather than
   * answering, and why it stopped.
   *
   * OPTIONAL, unlike the two counts above, for the reason `MachineOriginSchema`
   * gives: these lines are appended to a file that is read back whole by
   * `GET /api/jobs/:id/log`, and a log written before this field existed must
   * keep parsing. Null where the server reports no such breakdown.
   */
  reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  finishReason: z.string().nullable().optional(),
  /** How tolerant parsing arrived at the text (FR-6.9). */
  parse: z.enum(LLM_PARSE_MODES),
  confidence: z.enum(LLM_CONFIDENCES).nullable(),
  notesForReviewer: z.string().nullable(),
  /** The model's answer, verbatim. The run log's most useful column. */
  raw: z.string(),
  /**
   * Set when the unit was one of several in a single request (FR-6.8). `raw`
   * and the token counts are then the WHOLE request's, shared by every unit in
   * it; `key` is the item this unit's answer was read from. Optional so a run
   * log written before batching still parses.
   */
  batch: z.object({ size: z.number().int().positive(), key: z.string() }).optional(),
  /**
   * The messages as they were SENT (FR-6.14's "prompt sent"), for the review
   * report a native speaker checks a job against. Rebuilding the prompt later
   * would show today's style guide and glossary, not the ones the model read.
   *
   * Like `raw`, a batch's is the whole request's. The stricter format retry is
   * not included; `parse: 'retried'` says one happened.
   *
   * Written to `.lexi/logs/<jobId>.jsonl` only. The job queue strips it from
   * SSE frames and `GET /api/jobs/:id/log` (`withoutPrompt`), because a few KB
   * of system prompt per unit adds up in a client that keeps the whole log.
   * Optional so a log written before this field existed still parses.
   */
  prompt: z.object({ system: z.string(), user: z.string() }).optional(),
});
export type TranslateRun = z.infer<typeof TranslateRunSchema>;

/** A run as it goes over the wire: everything but the bulky `prompt`. */
export function withoutPrompt(run: TranslateRun): TranslateRun {
  if (run.prompt === undefined) return run;
  const rest = { ...run };
  delete rest.prompt;
  return rest;
}

/**
 * Why a draft was refused (FR-6.11).
 *
 * A rejection is FLAGGED, never discarded and never written: the raw answer is
 * still in `run`, so the reviewer can see what the model said and decide
 * whether the prompt or the model is at fault.
 */
export const TranslateRejectionSchema = z.object({
  reason: z.string(),
  detail: z.string(),
  missing: z.array(z.string()),
  extra: z.array(z.string()),
});
export type TranslateRejection = z.infer<typeof TranslateRejectionSchema>;

export const TranslateUnitResponseSchema = z.object({
  ok: z.boolean(),
  rowId: z.string(),
  locale: z.string(),
  /** Present only when the draft passed every gate and entered the overlay. */
  target: UnitTargetSchema.nullable(),
  unsavedCount: z.number().int().nonnegative(),
  run: TranslateRunSchema,
  rejection: TranslateRejectionSchema.nullable(),
  /**
   * Post-generation validation of an ACCEPTED draft (FR-6.11): placeholders,
   * ICU structure, CLDR plural coverage, whitespace, punctuation. These do not
   * block the draft — it lands flagged, which is the whole point of a draft.
   */
  findings: z.array(FindingSchema),
});
export type TranslateUnitResponse = z.infer<typeof TranslateUnitResponseSchema>;
