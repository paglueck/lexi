// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@lexi/xliff';
import type { RecentProject } from '@lexi/shared';

import type { ServerConfig } from '../config.js';

/**
 * `~/.lexi/recents.json` — S1's recent-projects list (FR-1.7).
 *
 * The only thing Lexi writes outside the project being edited, which is why the
 * directory comes from `cfg.stateDir` rather than `homedir()`: a test that
 * writes into the developer's real home is a test nobody wants to run twice.
 *
 * Failures are swallowed on purpose. A read-only home directory, or a recents
 * file some other tool corrupted, must not stop a project from opening — the
 * list is a convenience, not state anything depends on.
 */

const FILE = 'recents.json';
const MAX_ENTRIES = 10;

/**
 * An entry as it is stored. `exists` and `origin` are facts about the folder
 * at the moment the list is served, so they are worked out then (see
 * `routes/recents.ts`) and never written.
 */
export type StoredRecent = Omit<RecentProject, 'exists' | 'origin'>;

/** Stable per path, so DELETE /api/recents/:id needs no path in the URL. */
export const recentIdFor = (path: string): string =>
  createHash('sha256').update(path).digest('hex').slice(0, 12);

export async function readRecents(cfg: ServerConfig): Promise<StoredRecent[]> {
  const raw = await readFile(join(cfg.stateDir, FILE), 'utf8').catch(() => null);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredRecent[]) : [];
  } catch {
    return [];
  }
}

async function writeRecents(cfg: ServerConfig, recents: readonly StoredRecent[]): Promise<void> {
  try {
    await mkdir(cfg.stateDir, { recursive: true });
    // Only the stored fields, whatever the caller's objects carry besides.
    const stored = recents.map(
      ({ id, path, name, openedAt, localeCount, unitCount, coverage }): StoredRecent => ({
        id,
        path,
        name,
        openedAt,
        localeCount,
        unitCount,
        coverage,
      }),
    );
    await atomicWrite(join(cfg.stateDir, FILE), `${JSON.stringify(stored, null, 2)}\n`);
  } catch {
    // See the note above: the list is a convenience.
  }
}

/** Move a project to the front of the list, replacing any older entry for it. */
export async function recordRecent(cfg: ServerConfig, entry: StoredRecent): Promise<void> {
  const existing = await readRecents(cfg);
  const next = [entry, ...existing.filter((r) => r.path !== entry.path)].slice(0, MAX_ENTRIES);
  await writeRecents(cfg, next);
}

/** Empty the list — "Clear recent projects". */
export async function clearRecents(cfg: ServerConfig): Promise<void> {
  await writeRecents(cfg, []);
}

/**
 * Point an entry at the folder it moved to. The id follows the path, so the
 * entry gets a new one; an older entry for the new path is dropped rather than
 * kept twice. Null when there was no entry with that id.
 */
export async function relocateRecent(
  cfg: ServerConfig,
  id: string,
  path: string,
): Promise<StoredRecent[] | null> {
  const existing = await readRecents(cfg);
  const at = existing.findIndex((r) => r.id === id);
  const entry = existing[at];
  if (entry === undefined) return null;
  const moved: StoredRecent = { ...entry, id: recentIdFor(path), path };
  const next = existing.flatMap((r, i) => (i === at ? [moved] : r.path === path ? [] : [r]));
  await writeRecents(cfg, next);
  return next;
}

/** Returns false when there was nothing with that id, so the route can 404. */
export async function forgetRecent(cfg: ServerConfig, id: string): Promise<boolean> {
  const existing = await readRecents(cfg);
  const next = existing.filter((r) => r.id !== id);
  if (next.length === existing.length) return false;
  await writeRecents(cfg, next);
  return true;
}
