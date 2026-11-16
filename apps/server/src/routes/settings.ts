// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { SettingsPatchSchema, URLLESS_ADAPTERS, type LlmProbe, type Settings } from '@lexi/shared';

import { badRequest } from '../lib/http-error.js';
import { LlmError, parseBaseUrl, probeEndpoint } from '../services/llm-client.js';
import type { SettingsService } from '../services/settings-service.js';

/**
 * S7 — the settings screen (FR-6.1 … FR-6.4).
 *
 * Ungated on purpose: these are machine settings, and configuring the endpoint
 * is something a user does before opening anything. The project half of S7
 * (`writeState`, `escapePolicy`, rule severities) is `PATCH /api/project` and
 * stays there — one field, one owner.
 */
export function registerSettings(app: FastifyInstance, settings: SettingsService): void {
  app.get('/api/settings', async (): Promise<Settings> => settings.toDto());

  app.patch('/api/settings', async (req): Promise<Settings> => {
    const patch = SettingsPatchSchema.parse(req.body);

    // Validated here rather than in the schema because `''` is legal — it means
    // "not configured" — while `localhost:11434` (no scheme) is the mistake
    // everybody makes once and deserves the sentence that says so.
    if (patch.baseUrl !== undefined && patch.baseUrl.trim() !== '') {
      try {
        parseBaseUrl(patch.baseUrl);
      } catch (error) {
        throw badRequest(error instanceof LlmError ? error.message : 'Invalid base URL');
      }
    }

    // The vocabulary carries `ollama` so the adapter seam and S7's second card
    // are real, but nothing implements it. Storing it would produce a
    // project that cannot translate and a settings screen that looks fine.
    if (patch.adapter === 'ollama') {
      throw badRequest(
        "The Ollama-native adapter is not implemented in this version. Use the OpenAI-compatible adapter against Ollama's /v1 endpoint.",
      );
    }

    await settings.patch(patch);
    return settings.toDto();
  });

  /**
   * "Test connection" (FR-6.3).
   *
   * Probes exactly what is stored, and takes no body. Testing an unsaved form
   * would let the screen report a green result for one endpoint while a
   * different one is what every later request uses — the single most confusing
   * thing this screen could do. The client patches, then tests.
   */
  app.post('/api/llm/test', async (): Promise<LlmProbe> => {
    const endpoint = settings.endpoint;
    if (endpoint.baseUrl.trim() === '' && !URLLESS_ADAPTERS.includes(endpoint.adapter)) {
      throw badRequest('No endpoint is configured.');
    }

    const result = await probeEndpoint(endpoint, {
      ...settings.params,
      // The probe's own values; the stored ones belong to translation.
      temperature: 0,
      maxTokens: 16,
    });

    const probe: LlmProbe = {
      ok: result.ok,
      endpoint: result.endpoint,
      model: endpoint.model,
      steps: result.steps,
      models: result.models,
      at: new Date().toISOString(),
    };
    settings.recordProbe(probe);
    return probe;
  });
}
