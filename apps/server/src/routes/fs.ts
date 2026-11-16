// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  FsBrowseQuerySchema,
  type FsBrowseResponse,
  type FsEntry,
  type FsRootsResponse,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { isWithinRoots, resolveWithinRoots } from '../lib/paths.js';

const XLIFF_EXT = /\.(xlf|xliff)$/i;

function entryKind(d: { isDirectory(): boolean; isSymbolicLink(): boolean }): FsEntry['kind'] {
  if (d.isSymbolicLink()) return 'symlink';
  return d.isDirectory() ? 'dir' : 'file';
}

export function registerFs(app: FastifyInstance, cfg: ServerConfig): void {
  app.get('/api/fs/roots', async (): Promise<FsRootsResponse> => ({
    roots: cfg.roots.map((path) => ({ path, label: basename(path) || path })),
  }));

  app.get('/api/fs/browse', async (req): Promise<FsBrowseResponse> => {
    const { path } = FsBrowseQuerySchema.parse(req.query);
    const dir = await resolveWithinRoots(path, cfg);

    // `withFileTypes` reports a symlink AS a symlink — it is listed but not
    // followed. Opening it triggers a fresh browse, which realpaths and
    // re-checks, so the jail is enforced per navigation rather than per listing.
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: FsEntry[] = dirents
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => ({
        name: d.name,
        path: join(dir, d.name),
        kind: entryKind(d),
        isXliff: !d.isDirectory() && XLIFF_EXT.test(d.name),
      }))
      .sort((a, b) => {
        if (a.kind === 'dir' && b.kind !== 'dir') return -1;
        if (a.kind !== 'dir' && b.kind === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });

    const up = dirname(dir);
    const parent = up !== dir && isWithinRoots(cfg.roots, up) ? up : null;

    return { path: dir, parent, entries };
  });
}
