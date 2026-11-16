// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  SHARED_SOURCE_KINDS,
  SharedSourcesPutRequestSchema,
  type SharedSourcesResponse,
} from '@lexi/shared';

import { notFound } from '../lib/http-error.js';
import { sharedSourcesResponse, writeSharedSources } from '../lib/shared-sources.js';
import type { EventBus } from '../lib/event-bus.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';
import type { SharedSourceWatcher } from '../services/shared-source-watcher.js';
import { loadTermBase } from '../services/termbase.js';

/**
 * Link the project's style guides or Term Base to a shared folder, or unlink
 * them (`lib/shared-sources.ts`).
 *
 * A change takes effect in full before the response: the validator's glossary
 * is reloaded from wherever the Term Base now lives, the watcher follows the
 * new folders, and both pages hear `shared-source-changed` — a second tab
 * would otherwise go on showing terms from a file that is no longer the one.
 */
export function registerSharedSources(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
  watcher?: SharedSourceWatcher,
): void {
  const open = () => {
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    return project;
  };

  app.get('/api/shared-sources', async (): Promise<SharedSourcesResponse> => {
    const project = open();
    return sharedSourcesResponse(project.path);
  });

  app.put('/api/shared-sources', async (req): Promise<SharedSourcesResponse> => {
    const project = open();
    const body = SharedSourcesPutRequestSchema.parse(req.body ?? {});
    await writeSharedSources(cfg, project.path, body);

    projects.setGlossary(await loadTermBase(cfg, project.path));
    await watcher?.watchProject(project.path);
    for (const source of SHARED_SOURCE_KINDS) {
      if (body[source] !== undefined) bus.publish({ type: 'shared-source-changed', source });
    }
    return sharedSourcesResponse(project.path);
  });
}
