// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

/**
 * `GET /api/health`.
 *
 * `llm.model` is null until an endpoint is configured (M8); `llm.reachable` is
 * the last probe result, never a live call, so the health check stays fast.
 */
export const HealthSchema = z.object({
  version: z.string(),
  projectOpen: z.boolean(),
  llm: z.object({
    reachable: z.boolean(),
    model: z.string().nullable(),
  }),
});
export type Health = z.infer<typeof HealthSchema>;
