// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import {
  LocateRecentRequestSchema,
  phraseOriginScope,
  type RecentProject,
  type RecentsResponse,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { readLexiJson } from '../lib/lexi-dir.js';
import { resolveWithinRoots } from '../lib/paths.js';
import {
  clearRecents,
  forgetRecent,
  readRecents,
  relocateRecent,
  type StoredRecent,
} from '../lib/recents.js';

/**
 * `~/.lexi/recents.json`, as S1's recent list (FR-1.7) and S17's launch menu.
 *
 * `exists` and `origin` are read from the folder each time the list is served
 * rather than stored: a folder that was moved, or a checkout's
 * `.lexi/phrase.json` that was deleted, is what the menu has to show now.
 */
export function registerRecents(app: FastifyInstance, cfg: ServerConfig): void {
  app.get('/api/recents', async (): Promise<RecentsResponse> => ({
    recents: await served(await readRecents(cfg)),
  }));

  /** "Clear recent projects". 204 whether or not there was anything to clear. */
  app.delete('/api/recents', async (_req, reply): Promise<void> => {
    await clearRecents(cfg);
    reply.code(204);
  });

  app.delete('/api/recents/:id', async (req, reply): Promise<void> => {
    const { id } = req.params as { id: string };
    if (!(await forgetRecent(cfg, id))) throw notFound('no such recent project');
    reply.code(204);
  });

  /**
   * S17's "Locate…": the folder moved, the user picked its new place. The new
   * path is jailed and must be a folder that exists; the answer is the whole
   * list, so the menu can redraw in one step.
   */
  app.post('/api/recents/:id/locate', async (req): Promise<RecentsResponse> => {
    const { id } = req.params as { id: string };
    const { path } = LocateRecentRequestSchema.parse(req.body);
    const root = await resolveWithinRoots(path, cfg);
    if (!(await isDirectory(root))) throw badRequest('That is not a folder.');
    const next = await relocateRecent(cfg, id, root);
    if (next === null) throw notFound('no such recent project');
    return { recents: await served(next) };
  });
}

async function served(stored: readonly StoredRecent[]): Promise<RecentProject[]> {
  return Promise.all(
    stored.map(async (entry): Promise<RecentProject> => {
      const exists = typeof entry.path === 'string' && (await isDirectory(entry.path));
      // `scope`, or the single `tag` of a file written before scopes existed.
      const scope = exists
        ? phraseOriginScope(await readLexiJson<unknown>(entry.path, 'phrase.json'))
        : null;
      return {
        ...entry,
        exists,
        ...(scope === null
          ? {}
          : { origin: { kind: 'phrase', tags: scope.kind === 'all' ? [] : scope.tags } }),
      };
    }),
  );
}

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
