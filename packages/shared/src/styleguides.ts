// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import {
  MD_BLOCK_KINDS,
  MD_SPAN_STYLES,
  MD_TABLE_ALIGNS,
  STYLEGUIDE_MAX_BYTES,
} from './constants.js';

/**
 * `/api/styleguides` and `POST /api/markdown/preview` — M10, screen S6.
 *
 * Style guides are plain `.md` files under `.lexi/styleguides/` (FR-5.5), so
 * they diff and review in Git like any other document. This file describes the
 * two things that travel: the guide itself, and the RENDERED form of whatever
 * is currently in the editor.
 *
 * THE POINT OF THE SECOND ONE: the preview crosses the wire as a typed block
 * tree, never as HTML. There is no `[innerHTML]` in this codebase and no
 * `DomSanitizer` call, so a style guide someone pasted out of a wiki cannot
 * become markup — the client renders spans through interpolation, and text is
 * all a span can ever hold. Sending HTML would have meant trusting a sanitizer
 * with a document we invited the user to paste into.
 */

/* ---- the guides themselves ----------------------------------------------- */

/**
 * One guide, as the locale bar lists it.
 *
 * `key` is `global` or a locale tag; `name` is the filename on disk. The two
 * are kept separate because the URL must not be able to name a file — see
 * `guideKeyToName` on the server, which is the only thing that maps one to the
 * other.
 */
export const StyleGuideSummarySchema = z.object({
  key: z.string(),
  /** `global.md`, `de.md` — S6's mono path label and S5's block source. */
  name: z.string(),
  /** Null for the global guide. */
  locale: z.string().nullable(),
  /** Estimated, like every token figure before a run (FR-5.4). */
  tokens: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type StyleGuideSummary = z.infer<typeof StyleGuideSummarySchema>;

export const StyleGuideSchema = StyleGuideSummarySchema.extend({
  text: z.string(),
  /**
   * False when the file has not been written yet.
   *
   * The editor still opens on it — that is how a guide gets created — so the
   * screen needs to tell "empty because nobody has written it" apart from
   * "empty because somebody emptied it", and only the first offers a template.
   */
  exists: z.boolean(),
});
export type StyleGuide = z.infer<typeof StyleGuideSchema>;

export const StyleGuideListResponseSchema = z.object({
  guides: z.array(StyleGuideSummarySchema),
  /**
   * Target locales of the open project that have no guide yet — exactly what
   * the dashed "+ locale" affordance offers.
   *
   * Computed here rather than in the browser for the same reason the proposed
   * filename of a new locale file is: a client deriving it from what it
   * happens to know would be right until it met a project whose locales it did
   * not have in that list.
   */
  missing: z.array(z.string()),
  /**
   * `.lexi/styleguides` — the path S6 prints, relative to the project. The
   * absolute path of the linked folder when the guides come from a shared one.
   */
  dir: z.string(),
  /** True when the guides are read from a shared folder (`shared-sources.ts`). */
  linked: z.boolean(),
  /** False when that shared folder is missing on this machine. Always true when not linked. */
  available: z.boolean(),
});
export type StyleGuideListResponse = z.infer<typeof StyleGuideListResponseSchema>;

/**
 * `PUT /api/styleguides/:key`.
 *
 * `.strict()` because zod strips unknown keys in silence,
 * and this payload overwrites a file the user has been typing into.
 */
export const StyleGuideSaveRequestSchema = z
  .object({ text: z.string().max(STYLEGUIDE_MAX_BYTES) })
  .strict();
export type StyleGuideSaveRequest = z.infer<typeof StyleGuideSaveRequestSchema>;

/* ---- the rendered preview ------------------------------------------------ */

/** One run of inline text. A link carries `href`; everything else has null. */
export const MdSpanSchema = z.object({
  text: z.string(),
  style: z.enum(MD_SPAN_STYLES),
  href: z.string().nullable(),
});
export type MdSpan = z.infer<typeof MdSpanSchema>;

/**
 * One block of the rendered guide.
 *
 * UNIFORM RATHER THAN A DISCRIMINATED UNION, deliberately. A union is the
 * better TypeScript, but Angular's template type-checker does not narrow one
 * across an `@switch`, so the view would need a cast per case — and a cast in
 * the one place whose whole job is to be provably safe is the wrong trade. Here
 * every field is always present, `@switch (b.kind)` reads the fields it cares
 * about, and there is nothing to narrow.
 *
 * `lines` is the block's inline content, one entry per paragraph, list item or
 * quoted paragraph. A `code` block holds its whole text as a single plain span
 * so whitespace survives; a `rule` holds nothing.
 *
 * `cells` and `align` exist only for a `table` block: `cells[0]` is the header
 * row, `cells[1..]` the body rows, and `align` has one entry per column from
 * the delimiter row's `:---:` markers. Every other kind leaves both `[]`.
 */
export const MdBlockSchema = z.object({
  kind: z.enum(MD_BLOCK_KINDS),
  /** 1–6 for a heading, 0 for everything else. */
  level: z.number().int().min(0).max(6),
  /** True only for a numbered list. */
  ordered: z.boolean(),
  /** A fence's declared language, `''` when there is none. */
  lang: z.string(),
  lines: z.array(z.array(MdSpanSchema)),
  /** `table` only: rows of cells of spans, header row first. */
  cells: z.array(z.array(z.array(MdSpanSchema))),
  /** `table` only: one alignment per column. */
  align: z.array(z.enum(MD_TABLE_ALIGNS)),
});
export type MdBlock = z.infer<typeof MdBlockSchema>;

/**
 * `POST /api/markdown/preview` — renders the editor's UNSAVED buffer.
 *
 * It takes text rather than a guide key because the live preview must follow
 * what is on screen, not what is on disk.
 */
export const MarkdownPreviewRequestSchema = z
  .object({ text: z.string().max(STYLEGUIDE_MAX_BYTES) })
  .strict();
export type MarkdownPreviewRequest = z.infer<typeof MarkdownPreviewRequestSchema>;

export const MarkdownPreviewResponseSchema = z.object({
  blocks: z.array(MdBlockSchema),
  /** The same estimate the editor computes locally, so the two can be compared. */
  tokens: z.number().int().nonnegative(),
});
export type MarkdownPreviewResponse = z.infer<typeof MarkdownPreviewResponseSchema>;
