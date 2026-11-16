// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

/**
 * `/api/shared-sources` — style guides and the Term Base read from a folder
 * OUTSIDE the project's `.lexi/`, so several projects can share one Git
 * repository of them.
 *
 * A link REPLACES the project's own file rather than layering over it: while
 * one is set, every read and every write goes to the linked folder, and
 * `.lexi/styleguides/` or `.lexi/termbase.csv` is left where it is, untouched.
 *
 * The link is a fact about THIS MACHINE — an absolute path to wherever the
 * shared repository happens to be checked out — so it lives in
 * `.lexi/settings.local.json`, which `.lexi/.gitignore` already excludes.
 */

export const SHARED_SOURCE_KINDS = ['styleguides', 'termbase'] as const;
export type SharedSourceKind = (typeof SHARED_SOURCE_KINDS)[number];

/** One linkable source, as the pages show it. */
export const SharedSourceStateSchema = z.object({
  /** The linked folder, absolute and realpath'd. Null when not linked. */
  path: z.string().nullable(),
  /**
   * False when a folder is linked but is not there right now — the shared
   * repository is not checked out on this machine, or was moved. Reads then
   * find nothing; the page says why instead of showing an empty list.
   */
  available: z.boolean(),
});
export type SharedSourceState = z.infer<typeof SharedSourceStateSchema>;

export const SharedSourcesResponseSchema = z.object({
  styleguides: SharedSourceStateSchema,
  termbase: SharedSourceStateSchema,
});
export type SharedSourcesResponse = z.infer<typeof SharedSourcesResponseSchema>;

/**
 * `PUT /api/shared-sources`. An absent key leaves that link as it is; `null`
 * removes it. `.strict()`, because a misspelled key would otherwise be a link
 * that silently did not happen.
 */
export const SharedSourcesPutRequestSchema = z
  .object({
    styleguides: z.string().min(1).max(4096).nullable().optional(),
    termbase: z.string().min(1).max(4096).nullable().optional(),
  })
  .strict();
export type SharedSourcesPutRequest = z.infer<typeof SharedSourcesPutRequestSchema>;
