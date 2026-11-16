// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CsvImportSummary, SegmentDto, UnitState } from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { ensureLexiDir, lexiDirOf, readLexiJson, writeLexiJson } from './lexi-dir.js';
import type { FinalMarker } from './final-marker.js';
import type { MachineOrigin } from './machine-origin.js';
import { resolveForCreate } from './paths.js';

/**
 * What one CSV import wrote, kept in `.lexi/imports/<id>.json`.
 *
 * The import writes straight to the XLIFF files and the save clears the
 * session's undo history, so this record is the only way back: it holds every
 * cell's target and state from before the import. It is committed with the
 * project, like the export snapshots, so the teammate who pulls an import can
 * still undo it.
 */
export interface ImportRecord {
  version: 1;
  id: string;
  /** ISO time of the save that wrote the cells. */
  at: string;
  jobId: string | null;
  /** The export snapshot most rows were compared with, when there was one. */
  exportId: string | null;
  state: UnitState;
  undone: boolean;
  cells: ImportedCell[];
}

export interface ImportedCell {
  rowId: string;
  locale: string;
  /** The locale file, relative to the project, as the response names it. */
  path: string;
  /**
   * The target as the import wrote it. Undo restores a cell only while it
   * still reads this way; anything since is somebody's later edit.
   */
  segments: SegmentDto[];
  /** The file's target before the import; null when there was none. */
  previous: SegmentDto[] | null;
  previousState: UnitState;
  /** The machine-draft marker the import retired, put back only if the bytes come back exactly. */
  previousOrigin: MachineOrigin | null;
  /**
   * The final marker the import retired — an earlier import's `final` in a
   * file without `state`. Optional because records written before it existed
   * have none; Undo then rebuilds the marker from `previousState`.
   */
  previousFinal?: FinalMarker | null;
}

const dirOf = (projectPath: string): string => join(lexiDirOf(projectPath), 'imports');

/** Import ids are `randomUUID()`s; checked before an id from a URL becomes part of a path. */
const IMPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isImportId = (id: string): boolean => IMPORT_ID.test(id);

/**
 * Whether parsed JSON is a record. The file is committed and may have been
 * merged badly; one that is not shaped like a record reads as absent rather
 * than failing a listing, or an undo halfway through its cells.
 */
function isImportRecord(raw: unknown): raw is ImportRecord {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.at !== 'string' ||
    typeof r.state !== 'string' ||
    typeof r.undone !== 'boolean' ||
    !(r.jobId === null || typeof r.jobId === 'string') ||
    !Array.isArray(r.cells)
  ) {
    return false;
  }
  return r.cells.every((cell: unknown) => {
    if (typeof cell !== 'object' || cell === null) return false;
    const c = cell as Record<string, unknown>;
    return (
      typeof c.rowId === 'string' &&
      typeof c.locale === 'string' &&
      typeof c.path === 'string' &&
      Array.isArray(c.segments) &&
      (c.previous === null || Array.isArray(c.previous)) &&
      typeof c.previousState === 'string'
    );
  });
}

/** Write `.lexi/imports/<id>.json`, creating the folder on first use. */
export async function writeImportRecord(
  cfg: ServerConfig,
  projectPath: string,
  record: ImportRecord,
): Promise<void> {
  if (!isImportId(record.id)) throw new Error(`not an import id: ${record.id}`);
  await ensureLexiDir(cfg, projectPath);
  await mkdir(await resolveForCreate(dirOf(projectPath), cfg), { recursive: true });
  await writeLexiJson(cfg, projectPath, `imports/${record.id}.json`, record);
}

/** The record with this id, or null when it is absent, unreadable, or the id is not one. */
export async function readImportRecord(
  projectPath: string,
  id: string,
): Promise<ImportRecord | null> {
  if (!isImportId(id)) return null;
  const raw = await readLexiJson<unknown>(projectPath, `imports/${id}.json`);
  return isImportRecord(raw) ? raw : null;
}

/** Every readable record, of one job when `jobId` is given, newest first. */
export async function listImportRecords(
  projectPath: string,
  jobId?: string,
): Promise<ImportRecord[]> {
  const names = await readdir(dirOf(projectPath)).catch(() => [] as string[]);
  const out: ImportRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readImportRecord(projectPath, name.slice(0, -'.json'.length));
    if (record === null || (jobId !== undefined && record.jobId !== jobId)) continue;
    out.push(record);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** A record as the job's import list shows it. */
export const summaryOf = (record: ImportRecord): CsvImportSummary => ({
  importId: record.id,
  at: record.at,
  jobId: record.jobId,
  count: record.cells.length,
  undone: record.undone,
});
