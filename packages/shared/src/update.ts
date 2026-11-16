// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

/**
 * Where the desktop app's updater is, as one value the server can forward.
 *
 * `available` and `ready` carry the release notes, so the dialog that opens on
 * `ready` never has to remember what `available` said. `error` is a phase of
 * its own rather than a flag: a failed check and a failed download both end
 * there, and both leave the user free to try again.
 */
export const UpdateStateSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('idle') }),
  z.object({ phase: z.literal('checking') }),
  z.object({ phase: z.literal('none') }),
  z.object({
    phase: z.literal('available'),
    version: z.string(),
    releaseNotes: z.string().nullable(),
  }),
  z.object({
    phase: z.literal('downloading'),
    version: z.string(),
    percent: z.number().min(0).max(100),
  }),
  z.object({
    phase: z.literal('ready'),
    version: z.string(),
    releaseNotes: z.string().nullable(),
  }),
  z.object({ phase: z.literal('error'), message: z.string() }),
]);
export type UpdateState = z.infer<typeof UpdateStateSchema>;
export type UpdatePhase = UpdateState['phase'];

/**
 * How an update reaches the disk.
 *
 * - `auto` — electron-updater downloads and installs it (Windows, NSIS).
 * - `dmg` — the DMG is downloaded and opened, and the user drags Lexi into
 *   Applications. macOS, for as long as the build is only ad-hoc signed:
 *   Squirrel.Mac refuses to install an update into an app without a Developer
 *   ID signature.
 */
export const UPDATE_MODES = ['auto', 'dmg'] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

/**
 * `GET /api/update`.
 *
 * `supported` is false whenever no updater was handed to the server — the CLI,
 * the browser, the tests, and an unpackaged desktop build with no
 * `dev-app-update.yml`. The client then shows nothing update-related at all.
 */
export const UpdateStatusSchema = z.object({
  supported: z.boolean(),
  currentVersion: z.string(),
  mode: z.enum(UPDATE_MODES),
  state: UpdateStateSchema,
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
