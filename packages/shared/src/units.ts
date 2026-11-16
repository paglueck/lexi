// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { FindingSchema, UnitStateSchema } from './xliff-enums.js';
import {
  GRID_FILTERS,
  PLACEHOLDER_STYLES,
  REVIEW_DECISIONS,
  SEARCH_SCOPES,
  UNIT_ID_PATTERN,
} from './constants.js';

/**
 * The grid's wire contract: `POST /api/units/query`, `POST /api/units/rows`,
 * `GET /api/units/:rowId`.
 *
 * THE DIVISION OF LABOUR (docs/architecture.md). The client owns the
 * ordered id list; the server owns the row bodies. `query` returns every
 * matching id — 20k composite ids is around 300 kB, negligible over loopback —
 * and that one payload buys an exact scroll height, a stable row-to-index
 * mapping, instant selection arithmetic, `Cmd+Enter → next filtered row` with
 * no latency, and a correct status-bar count. `rows` then fetches bodies in
 * windows driven by the rendered range.
 */

/* ---- segments ------------------------------------------------------------ */

/**
 * A segment as it crosses the wire.
 *
 * DELIBERATELY NOT the engine's `Segment`. That type carries `raw` — the exact
 * original bytes of a placeholder — and `span`, an offset into the document
 * text. Neither means anything in a browser, and both are how round-trip
 * fidelity gets lost: a byte that travels to the client and back has passed
 * through a decode/encode cycle, which is precisely what `escape(decode(x)) !==
 * x` makes unsafe.
 *
 * So the wire form is semantic only. When M6 writes an edited target back, the
 * client sends ids and text, and the SERVER re-attaches `raw` by looking each
 * placeholder up by id in the unit it belongs to. The bytes never leave the
 * machine's memory, let alone the process. Do not add `raw` here.
 */
export const TextSegmentSchema = z.object({
  k: z.literal('t'),
  v: z.string(),
  /** Set when the server clipped this run at GRID_TEXT_LIMIT. Grid rows only. */
  clipped: z.boolean().optional(),
});
export type TextSegmentDto = z.infer<typeof TextSegmentSchema>;

export const PlaceholderSegmentSchema = z.object({
  k: z.literal('p'),
  id: z.string(),
  /** The chip's label. Falls back to `id` when Angular wrote no equiv-text. */
  equivText: z.string().optional(),
  ctype: z.string().optional(),
});
export type PlaceholderSegmentDto = z.infer<typeof PlaceholderSegmentSchema>;

export interface GroupSegmentDto {
  readonly k: 'g';
  readonly id: string;
  readonly children: readonly SegmentDto[];
}

export type SegmentDto = TextSegmentDto | PlaceholderSegmentDto | GroupSegmentDto;

/**
 * `<g>` nests, so this schema is recursive. zod 4 needs the getter form plus an
 * explicit annotation — without the annotation TypeScript cannot infer a type
 * that refers to itself and falls back to `any`, silently costing every
 * consumer its type safety.
 */
export const GroupSegmentSchema: z.ZodType<GroupSegmentDto> = z.object({
  k: z.literal('g'),
  id: z.string(),
  get children() {
    return z.array(SegmentSchema);
  },
});

export const SegmentSchema: z.ZodType<SegmentDto> = z.union([
  TextSegmentSchema,
  PlaceholderSegmentSchema,
  GroupSegmentSchema,
]);

/* ---- query --------------------------------------------------------------- */

export const GridFilterSchema = z.enum(GRID_FILTERS);
export const SearchScopeSchema = z.enum(SEARCH_SCOPES);

export const UnitsQueryRequestSchema = z.object({
  search: z.string().default(''),
  scope: SearchScopeSchema.default('all'),
  /** File groups to include. Empty means every group — the rail's "all files". */
  groups: z.array(z.string()).default([]),
  /**
   * Which locales the filters apply to. Empty means the project's visible
   * columns: "untranslated" has to mean untranslated IN SOMETHING, and the
   * answer differs per locale, so the client is explicit about it.
   */
  locales: z.array(z.string()).default([]),
  /** Combine with AND (FR-3.4). */
  filters: z.array(GridFilterSchema).default([]),
});
export type UnitsQueryRequest = z.infer<typeof UnitsQueryRequestSchema>;

/**
 * Facet counts, returned in the SAME response as the ids — one round trip,
 * never N.
 *
 * Counted over the search and group scope with the filter checkboxes
 * themselves excluded, so ticking a filter never makes its own count jump
 * around under the cursor. A filter with no data source is absent from this
 * record rather than present as zero, which is what lets the rail tell
 * "nothing matched" apart from "cannot answer yet".
 */
export const UnitsFacetsSchema = z.partialRecord(GridFilterSchema, z.number().int().nonnegative());
export type UnitsFacets = z.infer<typeof UnitsFacetsSchema>;

export const UnitsQueryResponseSchema = z.object({
  /** Rows matching the filters. The status bar's "N of M". */
  total: z.number().int().nonnegative(),
  /** Every matching row id, in display order. The client owns this list. */
  ids: z.array(z.string()),
  /** Rows in scope before the filters — the "of M" half. */
  scopeTotal: z.number().int().nonnegative(),
  facets: UnitsFacetsSchema,
  /** Per-group row counts for the rail's tree. */
  groupCounts: z.record(z.string(), z.number().int().nonnegative()),
});
export type UnitsQueryResponse = z.infer<typeof UnitsQueryResponseSchema>;

/* ---- rows ---------------------------------------------------------------- */

export const UnitCellSchema = z.object({
  state: UnitStateSchema,
  /** At least one validation finding of severity `error` (FR-3.7's overlay). */
  error: z.boolean(),
  /** The unit does not exist in this locale's file at all (FR-2.2). */
  missing: z.boolean(),
  segments: z.array(SegmentSchema),
});
export type UnitCell = z.infer<typeof UnitCellSchema>;

export const UnitRowSchema = z.object({
  rowId: z.string(),
  unitId: z.string(),
  group: z.string(),
  /** A developer-assigned `@@customId` rather than a content hash (FR-2.5b). */
  customId: z.boolean(),
  isIcu: z.boolean(),
  source: z.array(SegmentSchema),
  /** Keyed by locale. Only the locales the request asked for. */
  cells: z.record(z.string(), UnitCellSchema),
});
export type UnitRow = z.infer<typeof UnitRowSchema>;

export const UnitRowsRequestSchema = z.object({
  ids: z.array(z.string()).max(2000),
  locales: z.array(z.string()),
});
export type UnitRowsRequest = z.infer<typeof UnitRowsRequestSchema>;

export const UnitRowsResponseSchema = z.object({
  rows: z.array(UnitRowSchema),
});
export type UnitRowsResponse = z.infer<typeof UnitRowsResponseSchema>;

/* ---- detail -------------------------------------------------------------- */

export const UnitNoteSchema = z.object({
  /** Angular writes `description` and `meaning`; they are shown differently. */
  from: z.string().nullable(),
  priority: z.string().nullable(),
  text: z.string(),
});
export type UnitNote = z.infer<typeof UnitNoteSchema>;

/** One `<context-group purpose="location">` entry — the "used in" list (FR-4.3a). */
export const UnitLocationSchema = z.object({
  sourcefile: z.string(),
  linenumber: z.string().nullable(),
});
export type UnitLocation = z.infer<typeof UnitLocationSchema>;

/**
 * The committed target a pending edit is shadowing — S11's "against previous
 * target" diff (M14).
 *
 * The overlay never mutates the parsed document, so the pre-draft text is
 * still sitting in the file model while the draft is unsaved; this is that
 * text, and nothing more. Null whenever there is no pending edit, which is
 * also what makes "was there anything here before the model wrote?" answerable
 * without a second request.
 */
export const PreviousTargetSchema = z.object({
  segments: z.array(SegmentSchema),
  state: UnitStateSchema,
});
export type PreviousTarget = z.infer<typeof PreviousTargetSchema>;

/**
 * What a model run knows about itself — `.lexi/state.json`'s record, as the
 * Review screen's "How this draft was made" panel reads it (S11, FR-6.11).
 *
 * Everything past `at`/`model`/`style` is OPTIONAL because the file is
 * committed: a `state.json` written before M14 has none of it, and a marker
 * that failed to parse would wrongly demote a live machine draft to a plain
 * edit. The hash stays server-side — it is the index's business, not a screen's.
 */
export const MachineOriginSchema = z.object({
  at: z.string(),
  model: z.string(),
  style: z.enum(PLACEHOLDER_STYLES),
  temperature: z.number().optional(),
  /** The locale style guide's title, or null when the locale has none. */
  styleGuide: z.string().nullable().optional(),
  /**
   * Term Base entries the prompt carried, how many of them the answer used,
   * and how many the term base holds. The `glossary` prefix is the field's
   * name from before the Term Base; it stays so stored records keep reading.
   */
  glossaryInjected: z.number().int().nonnegative().optional(),
  glossaryApplied: z.number().int().nonnegative().optional(),
  glossaryTotal: z.number().int().nonnegative().optional(),
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  notesForReviewer: z.string().nullable().optional(),
});
export type MachineOriginDto = z.infer<typeof MachineOriginSchema>;

export const UnitTargetSchema = z.object({
  locale: z.string(),
  isRtl: z.boolean(),
  state: UnitStateSchema,
  /**
   * The `<trans-unit>` is not in this locale's file.
   *
   * Editable all the same: writing here creates it, as part of the same save
   * (FR-1.9). Without `ng-extract-i18n-merge` this is the ordinary state of
   * every string added since the translation files were last copied.
   */
  missing: z.boolean(),
  /**
   * There is no file for this locale in this file group at all, so there is
   * nowhere for a translation to go yet.
   *
   * Told apart from `missing` because the two need different answers: one is an
   * edit, the other is a decision about the project's shape that FR-1.9 says to
   * offer rather than take (`POST /api/locales/file`).
   */
  noFile: z.boolean(),
  /**
   * What `POST /api/locales/file` would call the file, when there is none.
   *
   * Computed by the server so the screen can name it before anything appears in
   * the user's repository — and so the naming convention lives in exactly one
   * place. A client that guessed would be right until it met a project naming
   * its files `en-GB.xlf`.
   */
  newFile: z.string().nullable(),
  /** Untruncated, unlike the grid's. */
  segments: z.array(SegmentSchema),
  findings: z.array(FindingSchema),
  /** Placeholder ids present in the source but absent here (FR-3.8). */
  missingPlaceholders: z.array(z.string()),
  charCount: z.number().int().nonnegative(),
  /** M14 — the diff's other side. Null unless a pending edit is shadowing something. */
  previous: PreviousTargetSchema.nullable(),
  /** M14 — present only while the machine-draft marker is still valid for this cell. */
  origin: MachineOriginSchema.nullable(),
  /**
   * M14 — the reasons a reviewer rejected the last draft for this cell
   * (`.lexi/review-notes.json`). Empty when there are none.
   */
  reviewReasons: z.array(z.string()),
});
export type UnitTarget = z.infer<typeof UnitTargetSchema>;

export const UnitDetailSchema = z.object({
  rowId: z.string(),
  unitId: z.string(),
  group: z.string(),
  customId: z.boolean(),
  isIcu: z.boolean(),
  sourceLocale: z.string(),
  source: z.array(SegmentSchema),
  notes: z.array(UnitNoteSchema),
  locations: z.array(UnitLocationSchema),
  targets: z.array(UnitTargetSchema),
  /** Which file each locale's copy lives in, relative to the project root. */
  files: z.record(z.string(), z.string()),
  /**
   * Where an edited note is written (FR-4.2): the source-locale file, relative
   * to the project root. Null for an orphan, which has no source unit to hold it.
   */
  notesFile: z.string().nullable(),
  /**
   * That file is the extraction template, which `ng extract-i18n` regenerates
   * — so a note written there does not survive the next extraction (FR-4.3c).
   */
  notesFileIsTemplate: z.boolean(),
  /** `notes` includes an edit that has not been saved yet. */
  notesPending: z.boolean(),
});
export type UnitDetail = z.infer<typeof UnitDetailSchema>;

/* ---- editing notes (FR-4.2) ---------------------------------------------- */

/**
 * `description` and `meaning` are what Angular writes; anything else a file
 * already carries is kept as it is. Restricted to a token, because it is
 * written into an attribute — never a quote, never a space.
 */
export const NoteEditSchema = z.object({
  from: z
    .string()
    .regex(/^[A-Za-z][\w.-]{0,39}$/)
    .nullable(),
  text: z.string().trim().min(1).max(2000),
});
export type NoteEdit = z.infer<typeof NoteEditSchema>;

/** The unit's notes as they should read — the whole list, in order. */
export const NotesPutRequestSchema = z.object({
  notes: z.array(NoteEditSchema).max(20),
});
export type NotesPutRequest = z.infer<typeof NotesPutRequestSchema>;

/**
 * Where the undo history stands (⌘Z / ⌘⇧Z). Carried on the responses of the
 * edits that record a step, so the toolbar moves without a second request.
 * The labels name the step an undo or redo would act on ("Edit", "Approve").
 */
export const HistoryStatusSchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  undoLabel: z.string().nullable(),
  redoLabel: z.string().nullable(),
});
export type HistoryStatus = z.infer<typeof HistoryStatusSchema>;

export const NotesPutResponseSchema = z.object({
  detail: UnitDetailSchema,
  unsavedCount: z.number().int().nonnegative(),
  history: HistoryStatusSchema.optional(),
});
export type NotesPutResponse = z.infer<typeof NotesPutResponseSchema>;

/* ---- writing (M6) -------------------------------------------------------- */

/**
 * A segment as it comes back IN, which is deliberately not the one that went out.
 *
 * Two members of the outbound shape must never be accepted back, and the reason
 * is structural rather than stylistic:
 *
 *   - `clipped` marks a text run the SERVER truncated at `GRID_TEXT_LIMIT` for a
 *     one-line grid cell. Accepting one back would splice a truncated string
 *     into somebody's file and silently delete the rest of their translation.
 *   - `equivText` and `ctype` are display echoes. The server re-derives them
 *     from its own bytes; trusting the client's copy would let a round trip
 *     through the browser decide what a placeholder looks like, which is the
 *     whole thing `raw` never crossing the wire exists to prevent.
 *
 * So an inbound placeholder is an id and nothing else. The server looks the id
 * up in the unit it belongs to and re-attaches the original bytes.
 */
export const EditTextSegmentSchema = z
  .object({ k: z.literal('t'), v: z.string() })
  // STRICT, and that is the point. zod strips unknown keys by default, so a
  // `clipped: true` run — the grid's 140-character preview — would be quietly
  // accepted and its prefix spliced over somebody's full translation. Refusing
  // the whole request is the only safe reading of a payload we do not recognise.
  .strict();
export const EditPlaceholderSegmentSchema = z
  .object({ k: z.literal('p'), id: z.string().min(1) })
  .strict();

export interface EditGroupSegmentDto {
  readonly k: 'g';
  readonly id: string;
  readonly children: readonly EditSegmentDto[];
}
export type EditSegmentDto =
  | z.infer<typeof EditTextSegmentSchema>
  | z.infer<typeof EditPlaceholderSegmentSchema>
  | EditGroupSegmentDto;

/** `<g>` nests, so this is recursive — zod 4's getter form plus the annotation. */
export const EditGroupSegmentSchema: z.ZodType<EditGroupSegmentDto> = z.object({
  k: z.literal('g'),
  id: z.string().min(1),
  get children() {
    return z.array(EditSegmentSchema);
  },
});

export const EditSegmentSchema: z.ZodType<EditSegmentDto> = z.union([
  EditTextSegmentSchema,
  EditPlaceholderSegmentSchema,
  EditGroupSegmentSchema,
]);

/** `PATCH /api/units/:rowId/targets/:locale`. */
export const ReviewPatchSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    /**
     * Why, for a reject. Stored in `.lexi/review-notes.json` and offered back
     * as the re-draft instruction. A fixed chip, or free text from S11's
     * "Add note…". Cleared by any decision that is not a reject.
     */
    reasons: z.array(z.string().min(1).max(200)).max(8).default([]),
  })
  // STRICT: a typo'd member here would be silently dropped by zod's default,
  // and a review decision that quietly did not arrive is the worst possible
  // failure mode for the metric it feeds.
  .strict();
export type ReviewPatch = z.infer<typeof ReviewPatchSchema>;

export const TargetPatchRequestSchema = z.object({
  segments: z.array(EditSegmentSchema),
  /**
   * The lifecycle state to move to. Omitted means "decide from the content" —
   * an edit that leaves text behind is `reviewed`, one that empties it is
   * `untranslated`.
   */
  state: UnitStateSchema.optional(),
  /**
   * What the reviewer just decided, when a reviewer decided it (M14).
   *
   * It rides on the PATCH rather than getting an endpoint of its own because a
   * review decision IS a PATCH — the same commit M12 already reduced all three
   * actions to, with different segments. Omitted by the grid, which has no
   * reviewer to ask; see `REVIEW_DECISIONS` for why that distinction matters
   * to the edit-rate metric.
   *
   * On a `reject` the server ignores `segments` and `state` entirely and
   * restores its OWN snapshot of the displaced target — the bytes recorded at
   * draft time, not whatever the browser is currently holding.
   */
  review: ReviewPatchSchema.optional(),
});
export type TargetPatchRequest = z.infer<typeof TargetPatchRequestSchema>;

export const TargetPatchResponseSchema = z.object({
  /** The same shape the detail panel already renders, so one render path serves both. */
  target: UnitTargetSchema,
  /** Pending edits across the whole project — the title bar's count. */
  unsavedCount: z.number().int().nonnegative(),
  history: HistoryStatusSchema.optional(),
});
export type TargetPatchResponse = z.infer<typeof TargetPatchResponseSchema>;

/**
 * `POST /api/units/bulk-approve` — FR-7.3's bulk approve, behind Focus mode's
 * own confirmation modal (the client, not this endpoint, is where "confirm"
 * lives).
 *
 * Commits each row's CURRENT, unmodified target — exactly what a single-unit
 * Approve does, batched, and re-validated server-side per row rather than
 * trusting the client's (possibly stale) filtered id list.
 */
export const BulkApproveRequestSchema = z.object({
  rowIds: z.array(z.string()).min(1),
  locale: z.string().min(1),
});
export type BulkApproveRequest = z.infer<typeof BulkApproveRequestSchema>;

export const BulkApproveResponseSchema = z.object({
  /** Rows actually approved. */
  approved: z.array(z.string()),
  /** Rows that no longer qualified by the time the request landed. */
  skipped: z.array(z.string()),
  unsavedCount: z.number().int().nonnegative(),
  history: HistoryStatusSchema.optional(),
});
export type BulkApproveResponse = z.infer<typeof BulkApproveResponseSchema>;

/**
 * `DELETE /api/units/:rowId` — remove a key from the source file and every
 * locale file. Unlike every other write, this one is NOT staged: it goes to
 * disk at once, behind the grid's own confirmation modal.
 */
export const UnitDeleteResponseSchema = z.object({
  /** Files the `<trans-unit>` was removed from. */
  written: z.array(z.string()),
  /** Files that changed on disk since they were read, and were left alone. */
  skipped: z.array(z.string()),
  unsavedCount: z.number().int().nonnegative(),
});
export type UnitDeleteResponse = z.infer<typeof UnitDeleteResponseSchema>;

/**
 * `POST /api/units` — the grid's "New key…": a `<trans-unit>` written into the
 * group's SOURCE file. Like a delete, it goes to disk at once; the translations
 * are then ordinary staged edits, which create the unit in each locale file on
 * Save (FR-1.9).
 *
 * The id's rule is `UNIT_ID_PATTERN` (constants), shared with the modal.
 */

export const UnitCreateRequestSchema = z
  .object({
    unitId: z.string().trim().min(1).regex(UNIT_ID_PATTERN, 'no whitespace or control characters'),
    /** The file group, e.g. `messages`. Optional only when the project has one. */
    group: z.string().optional(),
    /** Plain text; placeholders cannot be stated here. */
    source: z.string().min(1),
    description: z.string().optional(),
    meaning: z.string().optional(),
  })
  .strict();
export type UnitCreateRequest = z.infer<typeof UnitCreateRequestSchema>;

export const UnitCreateResponseSchema = z.object({
  rowId: z.string(),
  /** The source file the unit was written to. */
  written: z.string(),
  unsavedCount: z.number().int().nonnegative(),
});
export type UnitCreateResponse = z.infer<typeof UnitCreateResponseSchema>;

/** `POST /api/save` (FR-1.6, NFR-4). */
export const SaveRequestSchema = z.object({
  /** Absolute paths to save. Empty or omitted means every file with pending edits. */
  paths: z.array(z.string()).optional(),
});
export type SaveRequest = z.infer<typeof SaveRequestSchema>;

export const SaveResponseSchema = z.object({
  /** Files whose bytes actually changed. */
  written: z.array(z.string()),
  /**
   * Files that had pending edits which composed to exactly the existing text.
   * Never rewritten (FR-1.6): a translator who types a character and deletes it
   * again must not produce a commit.
   */
  skipped: z.array(z.string()),
  at: z.string(),
  unsavedCount: z.number().int().nonnegative(),
});
export type SaveResponse = z.infer<typeof SaveResponseSchema>;

/**
 * `POST /api/files/reload` — FR-1.5, the reload banner's action.
 *
 * Paths are absolute, because that is the key the server's document map uses and
 * the `file-changed` event carries the same form. The client displays them
 * relative to the project root; it never has to construct one.
 */
export const FilesReloadRequestSchema = z.object({
  /** Empty or omitted reloads every document the project has open. */
  paths: z.array(z.string()).default([]),
});
export type FilesReloadRequest = z.infer<typeof FilesReloadRequestSchema>;

export const FilesReloadResponseSchema = z.object({
  reloaded: z.array(z.string()),
  /** Unreadable — deleted, or being written as we looked. The old copy is kept. */
  failed: z.array(z.string()),
  /**
   * Unsaved edits that could not be carried across the reload because the unit
   * or its placeholders no longer exist. The banner says this out loud.
   */
  dropped: z.number().int().nonnegative(),
  unsavedCount: z.number().int().nonnegative(),
});
export type FilesReloadResponse = z.infer<typeof FilesReloadResponseSchema>;

/* ---- discard and undo ----------------------------------------------------- */

const CellRefSchema = z.object({ rowId: z.string().min(1), locale: z.string().min(1) });

/**
 * `POST /api/drafts/discard` — throw unsaved work away and go back to the
 * files. With `cells`, just those target drafts (the grid's multi-cell
 * "Revert"); without, EVERYTHING unsaved, note edits included. Either way it
 * is one undo step, so ⌘Z brings it all back.
 */
export const DiscardRequestSchema = z.object({
  cells: z.array(CellRefSchema).min(1).optional(),
});
export type DiscardRequest = z.infer<typeof DiscardRequestSchema>;

/** A cell a discard, undo or redo moved, with what it reads now. */
export const ChangedCellSchema = CellRefSchema.extend({
  /** Null when the row or its column is gone. */
  target: UnitTargetSchema.nullable(),
  /** Whether the cell still holds an unsaved edit afterwards. */
  pending: z.boolean(),
});
export type ChangedCell = z.infer<typeof ChangedCellSchema>;

export const DiscardResponseSchema = z.object({
  cells: z.array(ChangedCellSchema),
  /** Rows whose unsaved note edit moved. Notes are not mirrored by the client. */
  noteRows: z.array(z.string()),
  unsavedCount: z.number().int().nonnegative(),
  history: HistoryStatusSchema,
});
export type DiscardResponse = z.infer<typeof DiscardResponseSchema>;

/** `POST /api/history/undo` and `/redo`: the step that was taken back or redone. */
export const HistoryStepResponseSchema = DiscardResponseSchema.extend({
  label: z.string(),
});
export type HistoryStepResponse = z.infer<typeof HistoryStepResponseSchema>;
