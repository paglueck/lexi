// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SegmentDto } from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { ensureLexiDir, lexiDirOf, readLexiJson, writeLexiText } from './lexi-dir.js';
import { resolveForCreate } from './paths.js';

/**
 * What a CSV export said, kept in `.lexi/exports/<id>.json`.
 *
 * A reviewer edits the file for days; when it comes back, the import needs to
 * know what each cell held at export time, to tell the reviewer's edit from a
 * change somebody made in the project since. The id travels in the CSV's
 * `Export` column. The snapshot is committed with the project, so a teammate
 * importing the file finds the same baseline.
 */
export interface ExportSnapshot {
  version: 1;
  id: string;
  jobId: string;
  /** ISO time of the export; "the latest snapshot" is decided by it. */
  at: string;
  rows: {
    group: string | null;
    unitId: string;
    locale: string;
    source: SegmentDto[];
    /** What the Translation cell was rendered from; null when it was empty. */
    segments: SegmentDto[] | null;
  }[];
}

const dirOf = (projectPath: string): string => join(lexiDirOf(projectPath), 'exports');

/** Snapshot ids are `randomUUID()`s; checked before an id becomes part of a path. */
const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isExportId = (id: string): boolean => EXPORT_ID.test(id);

/** Write `.lexi/exports/<id>.json`, creating `.lexi/` on first use. */
export async function writeExportSnapshot(
  cfg: ServerConfig,
  projectPath: string,
  snapshot: ExportSnapshot,
): Promise<void> {
  if (!isExportId(snapshot.id)) throw new Error(`not an export id: ${snapshot.id}`);
  // `writeLexiText` creates `.lexi/` but not a subfolder of it, and the write
  // is re-checked against the jail like every other one in this layout.
  await ensureLexiDir(cfg, projectPath);
  await mkdir(await resolveForCreate(dirOf(projectPath), cfg), { recursive: true });
  // Compact, unlike the settings files beside it: a snapshot holds every
  // exported cell with its segments, is committed, and is read by a machine.
  await writeLexiText(
    cfg,
    projectPath,
    `exports/${snapshot.id}.json`,
    `${JSON.stringify(snapshot)}\n`,
  );
}

/**
 * Whether parsed JSON has the shape the import relies on. The file is
 * committed and may have been hand-edited or merged badly; one that parses
 * but is not a snapshot must read as "no snapshot", so its rows fall back to
 * comparing with the current cell instead of failing the whole preview.
 */
function isSnapshot(raw: unknown): raw is ExportSnapshot {
  if (typeof raw !== 'object' || raw === null) return false;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || typeof s.jobId !== 'string' || typeof s.at !== 'string') {
    return false;
  }
  if (!Array.isArray(s.rows)) return false;
  return s.rows.every((row: unknown) => {
    if (typeof row !== 'object' || row === null) return false;
    const r = row as Record<string, unknown>;
    return (
      typeof r.unitId === 'string' &&
      typeof r.locale === 'string' &&
      (r.group === undefined || r.group === null || typeof r.group === 'string') &&
      Array.isArray(r.source) &&
      (r.segments === null || Array.isArray(r.segments))
    );
  });
}

/**
 * The snapshot with this id, or null when it is absent, unreadable, not
 * shaped like a snapshot, or the id is not one.
 */
export async function readExportSnapshot(
  projectPath: string,
  id: string,
): Promise<ExportSnapshot | null> {
  if (!isExportId(id)) return null;
  const raw = await readLexiJson<unknown>(projectPath, `exports/${id}.json`);
  return isSnapshot(raw) ? raw : null;
}

/** The newest snapshot of a job, by `at`. Null when it was never exported. */
export async function latestExportSnapshotOf(
  projectPath: string,
  jobId: string,
): Promise<ExportSnapshot | null> {
  const names = await readdir(dirOf(projectPath)).catch(() => [] as string[]);
  let latest: ExportSnapshot | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const snap = await readExportSnapshot(projectPath, name.slice(0, -'.json'.length));
    if (snap?.jobId !== jobId) continue;
    if (latest === null || snap.at > latest.at) latest = snap;
  }
  return latest;
}
