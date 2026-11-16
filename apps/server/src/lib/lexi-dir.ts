// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite } from '@lexi/xliff';

import type { ServerConfig } from '../config.js';
import { resolveForCreate } from './paths.js';

/**
 * `.lexi/` — the project's own settings, written into somebody else's repository.
 *
 * Readable files, no database. Everything except
 * `settings.local.json`, `logs/` and `drafts.json` is meant to be committed
 * (FR-1.8), which means this layout becomes a public API the moment it is first
 * written. `drafts.json` is excluded because uncommitted edits are one person's
 * scratch state: committing somebody's half-finished translation would be a
 * surprise, and the file exists only so a crash loses nothing (NFR-4).
 *
 * Writes go through the engine's `atomicWrite` — temp file in the same
 * directory, fsync, rename — rather than `writeFile`. A half-written
 * `project.json` in a user's working tree would be our fault and their problem.
 *
 * Every write is re-checked against the jail. The project root is already
 * jailed by the time a route calls in here, so this is belt and braces — but
 * this is the module that creates files in somebody else's repository, and the
 * check costs one `realpath` per save.
 */

export const LEXI_DIR = '.lexi';

/**
 * What Lexi adds to the user's repository that they should NOT commit.
 *
 * Written when the directory is created, because doing it later means doing it
 * after the first thing worth ignoring has already been committed.
 *
 * `settings.local.json` is on the list although M8 put the endpoint and the API
 * key in `~/.lexi/settings.json` instead — a machine
 * fact does not belong in a repository. The line costs nothing and covers
 * anyone who writes such a file by hand.
 */
const GITIGNORE = `# Written by Lexi. Machine-local; everything else here is meant to be committed.
settings.local.json
logs/
drafts.json
review-stats.json
`;

export const lexiDirOf = (projectPath: string): string => join(projectPath, LEXI_DIR);

/** Create `.lexi/` if absent and make sure its `.gitignore` is there. */
export async function ensureLexiDir(cfg: ServerConfig, projectPath: string): Promise<string> {
  const dir = await resolveForCreate(lexiDirOf(projectPath), cfg);
  await mkdir(dir, { recursive: true });

  const gitignore = join(dir, '.gitignore');
  const existing = await readFile(gitignore, 'utf8').catch(() => null);
  // Never overwrite: the user may have added entries of their own.
  if (existing === null) await atomicWrite(gitignore, GITIGNORE);

  return dir;
}

/** Read and parse a JSON file under `.lexi/`. Null when absent or unreadable. */
export async function readLexiJson<T>(projectPath: string, name: string): Promise<T | null> {
  const raw = await readFile(join(lexiDirOf(projectPath), name), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt project.json must not make the project unopenable. Losing the
    // saved column choice is recoverable; refusing to open the folder is not.
    return null;
  }
}

/** Write a JSON file under `.lexi/`, creating the directory on first use. */
export async function writeLexiJson(
  cfg: ServerConfig,
  projectPath: string,
  name: string,
  value: unknown,
): Promise<void> {
  const dir = await ensureLexiDir(cfg, projectPath);
  await atomicWrite(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Write a text file under `.lexi/` atomically, creating the directory on first use. */
export async function writeLexiText(
  cfg: ServerConfig,
  projectPath: string,
  name: string,
  text: string,
): Promise<void> {
  const dir = await ensureLexiDir(cfg, projectPath);
  await atomicWrite(join(dir, name), text);
}

const jobLogPath = (projectPath: string, jobId: string): string =>
  join(lexiDirOf(projectPath), 'logs', `${jobId}.jsonl`);

/**
 * Append one line to `.lexi/logs/<jobId>.jsonl` (FR-6.14).
 *
 * Deliberately NOT `writeLexiJson`: that helper atomically rewrites the WHOLE
 * file on every call, which is right for a small settings object and wrong for
 * a log a 140-unit job appends to once per unit — rewriting the whole thing
 * each time is O(n²) over the run and defeats "tail this file while it grows".
 * A weaker per-line durability guarantee is the normal, accepted trade for a
 * JSONL log. `.lexi/.gitignore` already lists `logs/` (this module's own
 * template), so nothing here is ever meant to be committed.
 */
export async function appendJobLogLine(
  cfg: ServerConfig,
  projectPath: string,
  jobId: string,
  value: unknown,
): Promise<void> {
  await ensureLexiDir(cfg, projectPath);
  const target = await resolveForCreate(jobLogPath(projectPath, jobId), cfg);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(value)}\n`, 'utf8');
}

/** Every line of a job's log, oldest first. `[]` when the job has logged nothing yet. */
export async function readJobLogLines<T>(projectPath: string, jobId: string): Promise<T[]> {
  const raw = await readFile(jobLogPath(projectPath, jobId), 'utf8').catch(() => null);
  if (raw === null) return [];
  const lines: T[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      lines.push(JSON.parse(line) as T);
    } catch {
      // A truncated last line (e.g. the process died mid-write) must not lose
      // every entry before it — skip it, keep the rest.
    }
  }
  return lines;
}

/**
 * Job ids are `randomUUID()`s. Checked before an id from a URL becomes part of
 * a path: the report route reads jobs the queue no longer knows (it forgets
 * them on restart), so the queue's own 404 cannot stand guard here.
 */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isJobId = (id: string): boolean => JOB_ID.test(id);

const jobRecordPath = (projectPath: string, jobId: string): string =>
  join(lexiDirOf(projectPath), 'logs', `${jobId}.json`);

/**
 * Write `.lexi/logs/<jobId>.json` (`JobRecord`), replacing the previous copy.
 * Small and rewritten only on create and on finish, so unlike the `.jsonl`
 * beside it an atomic whole-file write is the right tool.
 */
export async function writeJobRecord(
  cfg: ServerConfig,
  projectPath: string,
  jobId: string,
  value: unknown,
): Promise<void> {
  await ensureLexiDir(cfg, projectPath);
  const target = await resolveForCreate(jobRecordPath(projectPath, jobId), cfg);
  await mkdir(dirname(target), { recursive: true });
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The ids of every job that has a record under `.lexi/logs/`, in no particular
 * order. Only `<uuid>.json` names count: the `.jsonl` run logs beside them and
 * anything a person dropped into the folder are not records.
 */
export async function listJobRecordIds(projectPath: string): Promise<string[]> {
  const names = await readdir(join(lexiDirOf(projectPath), 'logs')).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isJobId);
}

/** A job's record, or null when it has none (it ran before records existed) or the id is not one. */
export async function readJobRecord<T>(projectPath: string, jobId: string): Promise<T | null> {
  if (!isJobId(jobId)) return null;
  const raw = await readFile(jobRecordPath(projectPath, jobId), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
