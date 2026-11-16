// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  PromptPreviewRequestSchema,
  TranslateUnitRequestSchema,
  URLLESS_ADAPTERS,
  type PromptPreviewResponse,
  type TranslateUnitResponse,
} from '@lexi/shared';

import { notFound } from '../lib/http-error.js';
import { buildPrompt, translateUnit } from '../services/translate.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';
import type { SettingsService } from '../services/settings-service.js';

/**
 * S5 — the composed prompt, and the first real translation (M9).
 *
 * Both routes go through `services/translate.ts`, which goes through
 * `services/prompt.ts`. That chain is the point: the text the preview shows and
 * the text the request carries come from the same call, so they cannot drift.
 * A preview assembled anywhere else would be a claim about the prompt rather
 * than the prompt.
 */
export function registerPrompt(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  settings: SettingsService,
): void {
  app.post('/api/prompt/preview', async (req): Promise<PromptPreviewResponse> => {
    const body = PromptPreviewRequestSchema.parse(req.body ?? {});
    const project = projects.current;
    if (!project) throw notFound('no project is open');

    const { prompt, style } = await buildPrompt(
      { cfg, projects, settings },
      {
        rowId: body.rowId,
        locale: body.locale,
        placeholderStyle: body.placeholderStyle,
        instruction: body.instruction,
      },
    );

    const endpoint = settings.endpoint;
    return {
      rowId: body.rowId,
      unitId: projects.index?.byRowId.get(body.rowId)?.unitId ?? body.rowId,
      locale: body.locale,
      sourceLocale: project.sourceLocale,
      placeholderStyle: style,
      blocks: [...prompt.blocks],
      totals: prompt.totals,
      schema: prompt.schema,
      placeholders: [...prompt.placeholders],
      terminology: {
        matched: [...prompt.terminology.matched],
        total: prompt.terminology.total,
      },
      model: endpoint.model,
      params: settings.params,
      // Said here rather than discovered by the user when the run fails: the
      // preview is reachable with nothing configured, and it should be — seeing
      // the prompt is how somebody decides whether to configure anything.
      blocked:
        endpoint.baseUrl.trim() === '' && !URLLESS_ADAPTERS.includes(endpoint.adapter)
          ? 'No endpoint is configured. Set one in Settings before running.'
          : endpoint.model.trim() === ''
            ? 'No model is configured. Set one in Settings before running.'
            : '',
    };
  });

  app.post('/api/translate/unit', async (req): Promise<TranslateUnitResponse> => {
    const body = TranslateUnitRequestSchema.parse(req.body ?? {});
    if (!projects.current) throw notFound('no project is open');
    return translateUnit({ cfg, projects, settings }, body);
  });
}
