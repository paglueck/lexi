// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import type { ServerConfig } from '../config.js';
import { HttpError } from './http-error.js';

export class JailError extends HttpError {
  constructor(message: string, status = 403) {
    super(status, status === 404 ? 'not_found' : 'forbidden', message);
    this.name = 'JailError';
  }
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Containment via `path.relative`, never `startsWith`.
 *
 * `'/Users/patrickEVIL'.startsWith('/Users/patrick')` is true. `relative` gets
 * the separator boundary right in one line, on every platform.
 */
export function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * APFS and NTFS resolve `/users/patrick/x` happily, and `realpath` does not
 * normalise case. Without this the jail is inconsistent rather than insecure —
 * but an inconsistent jail is a support ticket.
 */
function containsCaseFolded(root: string, target: string): boolean {
  if (!CASE_INSENSITIVE_FS) return false;
  return contains(root.toLowerCase(), target.toLowerCase());
}

export function isWithinRoots(roots: readonly string[], real: string): boolean {
  return roots.some((r) => contains(r, real) || containsCaseFolded(r, real));
}

/**
 * Resolve a caller-supplied path and prove it is inside a granted root.
 *
 * There is deliberately no `allowOutside` escape hatch. It would be consent
 * theatre: anything able to reach this code already holds the boot token. The
 * real grant happens out of band — the home directory, plus any path typed on
 * the command line — and that is what makes it consent at all. M4 must not
 * quietly add a query parameter here.
 */
export async function resolveWithinRoots(input: string, cfg: ServerConfig): Promise<string> {
  if (input.includes('\0')) throw new JailError('invalid path');
  if (!isAbsolute(input)) throw new JailError('path must be absolute');

  const normalised = resolve(input);
  if (process.platform === 'win32' && parse(normalised).root.startsWith('\\\\')) {
    throw new JailError('UNC paths are not allowed');
  }

  let real: string;
  try {
    // Realpath, so a symlink cannot walk out of the jail. The roots were
    // realpath'd at boot for the same reason, in the other direction.
    real = await realpath(normalised);
  } catch {
    throw new JailError('not found', 404);
  }

  if (!isWithinRoots(cfg.roots, real)) throw new JailError('outside the allowed roots');
  return real;
}

/**
 * Prove a path is inside the jail even though it does not exist yet.
 *
 * `resolveWithinRoots` realpaths, and realpath throws on a missing file — which
 * is correct for browsing but useless for creating. `.lexi/project.json` never
 * exists the first time we write it, and neither does `~/.lexi/recents.json`.
 *
 * So: walk up to the nearest ancestor that DOES exist, realpath and jail-check
 * that, then re-attach the missing tail. The symlink guarantee is unchanged —
 * a symlink can only exist in the part we realpath'd, and the tail we append is
 * made of path segments we are about to create ourselves.
 *
 * A `..` in the tail would defeat that, and cannot occur: `resolve()` collapses
 * every `..` before the walk begins, so the tail is only ever literal segments.
 */
export async function resolveForCreate(input: string, cfg: ServerConfig): Promise<string> {
  if (input.includes('\0')) throw new JailError('invalid path');
  if (!isAbsolute(input)) throw new JailError('path must be absolute');

  const normalised = resolve(input);
  if (process.platform === 'win32' && parse(normalised).root.startsWith('\\\\')) {
    throw new JailError('UNC paths are not allowed');
  }

  const tail: string[] = [];
  let probe = normalised;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!isWithinRoots(cfg.roots, real)) throw new JailError('outside the allowed roots');
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      if (error instanceof JailError) throw error;
      const parent = dirname(probe);
      // Reached the filesystem root without finding anything that exists.
      if (parent === probe) throw new JailError('outside the allowed roots');
      tail.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}
