// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  TERMBASE_FILE,
  type SharedSourceKind,
  type SharedSourceState,
  type SharedSourcesResponse,
} from '@lexi/shared';

import { badRequest, conflict } from './http-error.js';
import { lexiDirOf, readLexiJson, writeLexiJson } from './lexi-dir.js';
import { resolveWithinRoots } from './paths.js';
import type { ServerConfig } from '../config.js';

/**
 * Shared style guides and Term Base — a folder outside `.lexi/` that REPLACES
 * the project's own copy while it is linked (see `@lexi/shared`'s
 * `shared-sources.ts` for the wire half).
 *
 * The link is kept in `.lexi/settings.local.json`: an absolute path is true of
 * one machine only, and that file is already in the `.gitignore` Lexi writes.
 * Committing it would hand every teammate a path into somebody else's home.
 *
 * Read on every call rather than cached, for the same reason the files it
 * points at are: a user who edits it by hand sees the change on the next
 * request, and there is no second copy to fall out of step.
 */

export const LOCAL_SETTINGS_FILE = 'settings.local.json';

/** The project-local default the links replace. */
export const STYLEGUIDE_DIR = 'styleguides';

export type SharedSources = Record<SharedSourceKind, string | null>;

const NONE: SharedSources = { styleguides: null, termbase: null };

interface LocalSettingsFile {
  version?: number;
  sharedSources?: Partial<Record<SharedSourceKind, unknown>>;
  [key: string]: unknown;
}

/**
 * The links, or none. A path that is not an absolute string is dropped rather
 * than trusted: the file is hand-editable, and a relative path here would be
 * resolved against whatever the server's working directory happens to be.
 */
export async function readSharedSources(projectPath: string): Promise<SharedSources> {
  const file = await readLexiJson<LocalSettingsFile>(projectPath, LOCAL_SETTINGS_FILE);
  const stored = file?.sharedSources;
  if (typeof stored !== 'object' || stored === null) return NONE;
  const pick = (value: unknown): string | null =>
    typeof value === 'string' && isAbsolute(value) ? value : null;
  return { styleguides: pick(stored.styleguides), termbase: pick(stored.termbase) };
}

/**
 * Prove a folder may be linked: absolute, inside the jail, and a directory.
 * Returns the realpath, which is what gets stored — a symlink swapped out
 * later cannot then walk the link somewhere the user never chose.
 */
export async function resolveSharedFolder(input: string, cfg: ServerConfig): Promise<string> {
  const real = await resolveWithinRoots(input, cfg);
  const isDir = await stat(real)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!isDir) throw badRequest(`"${input}" is not a folder.`);
  return real;
}

/**
 * Change one or both links. An absent key keeps the current link, `null`
 * removes it. Every other key of `settings.local.json` is preserved: the file
 * is also the documented place for a user's own machine-local notes.
 */
export async function writeSharedSources(
  cfg: ServerConfig,
  projectPath: string,
  patch: { readonly [K in SharedSourceKind]?: string | null | undefined },
): Promise<SharedSources> {
  const next = { ...(await readSharedSources(projectPath)) };
  for (const kind of ['styleguides', 'termbase'] as const) {
    const value = patch[kind];
    if (value === undefined) continue;
    next[kind] = value === null ? null : await resolveSharedFolder(value, cfg);
  }

  const file = (await readLexiJson<LocalSettingsFile>(projectPath, LOCAL_SETTINGS_FILE)) ?? {};
  await writeLexiJson(cfg, projectPath, LOCAL_SETTINGS_FILE, {
    ...file,
    version: 1,
    sharedSources: next,
  });
  return next;
}

/** Where the style guides are read from and written to right now. */
export async function styleGuideDirOf(projectPath: string): Promise<string> {
  const { styleguides } = await readSharedSources(projectPath);
  return styleguides ?? join(lexiDirOf(projectPath), STYLEGUIDE_DIR);
}

/** Where the Term Base is read from and written to right now. */
export async function termBaseFileOf(projectPath: string): Promise<string> {
  const { termbase } = await readSharedSources(projectPath);
  return join(termbase ?? lexiDirOf(projectPath), TERMBASE_FILE);
}

/** Whether a linked folder is there. Not linked counts as available. */
export async function sourceState(path: string | null): Promise<SharedSourceState> {
  if (path === null) return { path: null, available: true };
  const available = await stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
  return { path, available };
}

/**
 * Refuse a write into a linked folder that is not there. Creating it would
 * plant an empty Term Base or guide folder where the shared repository should
 * be checked out — the next `git clone` into that path would then fail, and
 * the user's edit would be in neither place they expect.
 */
export async function requireLinkedFolder(path: string): Promise<void> {
  if (!(await sourceState(path)).available) {
    throw conflict(`The shared folder "${path}" is missing. Check it out again or unlink it.`);
  }
}

export async function sharedSourcesResponse(projectPath: string): Promise<SharedSourcesResponse> {
  const links = await readSharedSources(projectPath);
  return {
    styleguides: await sourceState(links.styleguides),
    termbase: await sourceState(links.termbase),
  };
}
