// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { isLlmConfigured, type Health } from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';
import type { SettingsService } from '../services/settings-service.js';

/**
 * `GET /api/health` — also the readiness probe scripts/dev.mjs polls before it
 * starts `ng serve`, so the first proxied request never races the boot.
 *
 * `llm` is the LAST PROBE RESULT, never a live call: health is on the boot path
 * and must stay fast, and an endpoint that is down would otherwise make the
 * whole app take a connection timeout to start. `model` is what is configured,
 * which is why it can be non-null while `reachable` is false — "configured but
 * not tested" is the normal state, and S1's environment panel says so.
 */
export function registerHealth(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  settings: SettingsService,
): void {
  app.get('/api/health', async (): Promise<Health> => {
    const endpoint = settings.endpoint;
    return {
      version: cfg.version,
      projectOpen: projects.isOpen,
      llm: {
        reachable: settings.lastProbe?.ok ?? false,
        model: isLlmConfigured(endpoint) ? endpoint.model : null,
      },
    };
  });
}
