// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { FS_ENTRY_KINDS } from './constants.js';

/**
 * `GET /api/fs/roots` and `GET /api/fs/browse` — the folder picker behind S1/S2.
 *
 * The server jails both to the roots granted at boot (the home directory, plus
 * any path passed on the command line). There is deliberately no query parameter
 * that widens the jail: anything able to call this endpoint already holds the
 * boot token, so an `allowOutside` flag would be consent theatre. Granting a new
 * root happens out of band, on the command line.
 */

export const FsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(FS_ENTRY_KINDS),
  /** True for `.xlf` / `.xliff`, so the picker can highlight useful folders. */
  isXliff: z.boolean(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsRootSchema = z.object({
  path: z.string(),
  label: z.string(),
});
export type FsRoot = z.infer<typeof FsRootSchema>;

export const FsRootsResponseSchema = z.object({
  roots: z.array(FsRootSchema),
});
export type FsRootsResponse = z.infer<typeof FsRootsResponseSchema>;

export const FsBrowseQuerySchema = z.object({
  path: z.string().min(1),
});
export type FsBrowseQuery = z.infer<typeof FsBrowseQuerySchema>;

export const FsBrowseResponseSchema = z.object({
  /** The realpath of the requested directory — may differ from what was asked for. */
  path: z.string(),
  /** Null when `path` is itself a root. */
  parent: z.string().nullable(),
  entries: z.array(FsEntrySchema),
});
export type FsBrowseResponse = z.infer<typeof FsBrowseResponseSchema>;
