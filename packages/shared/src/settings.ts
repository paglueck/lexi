// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import {
  DEFAULT_LLM_PARAMS,
  EDITOR_MODES,
  LLM_ADAPTERS,
  LLM_PARAM_LIMITS,
  LLM_REASONING_EFFORTS,
  LLM_PROBE_STEPS,
  THEME_MODES,
} from './constants.js';
import { PhraseTokenSchema } from './phrase.js';

/**
 * `GET/PATCH /api/settings` and `POST /api/llm/test` — S7 (FR-6.1 … FR-6.4).
 *
 * **These are machine settings, not project settings.** They live in
 * `~/.lexi/settings.json` rather than in the project's `.lexi/`, for two
 * reasons that both bite immediately if ignored: Marek and Priya will not be
 * running the same inference server, so a committed base URL is wrong for
 * everybody but its author; and `/settings` is the one working
 * route with no project guard, so a settings store that needed an open project
 * could not answer the first question a new user asks.
 *
 * What a team genuinely shares — `writeState`, `escapePolicy`, rule severities
 * — is already in `.lexi/project.json` and stays there. S7 shows both; the page
 * knows which endpoint each field belongs to.
 */

const {
  temperature,
  topP,
  maxTokens,
  contextWindow,
  requestTimeoutSeconds,
  concurrency,
  unitsPerRequest,
} = LLM_PARAM_LIMITS;

/**
 * The generation parameters, shared by the DTO and the patch.
 *
 * `seed` is nullable rather than optional: "no seed" is a real choice a user
 * makes (and the honest default for a server that ignores it), while an absent
 * key in a patch means "leave it alone". Conflating the two would make the
 * field impossible to clear.
 */
export const LlmParamsSchema = z.object({
  temperature: z.number().min(temperature.min).max(temperature.max),
  topP: z.number().min(topP.min).max(topP.max),
  maxTokens: z.number().int().min(maxTokens.min).max(maxTokens.max),
  /**
   * The model's context window, which no OpenAI-compatible endpoint reports.
   *
   * It is therefore a user-declared fact rather than a discovered one, and it
   * exists so FR-5.4's token meter has something to measure against — a style
   * guide that will not fit is the failure the meter is there to prevent.
   */
  contextWindow: z.number().int().min(contextWindow.min).max(contextWindow.max),
  /**
   * How long one request to the model may take.
   *
   * A setting rather than a constant because the honest answer depends on the
   * machine: a 27B model on CPU, or one the server still has to load into VRAM,
   * takes minutes where a small quantized model takes a second. The 30 s that
   * used to be hard-coded is a plausible number for exactly one setup and wrong
   * for every other, and the failure it causes — "Could not reach …" after a
   * long wait — reads as a broken endpoint rather than as a deadline.
   *
   * In SECONDS, unlike every other duration in this codebase, because this file
   * is one a user edits by hand.
   */
  requestTimeoutSeconds: z
    .number()
    .int()
    .min(requestTimeoutSeconds.min)
    .max(requestTimeoutSeconds.max),
  seed: z.number().int().nullable(),
  /**
   * How much the model may think before it answers.
   *
   * A vocabulary rather than a boolean because `reasoning_effort` is a scale on
   * the servers that implement it, and because `'server'` — send the field at
   * all — has to be expressible. It is the sentinel: every other value goes on
   * the wire verbatim, `'server'` is dropped from the request body the way an
   * absent `seed` is, so an endpoint that has never heard of reasoning is not
   * handed a key it might reject.
   */
  reasoningEffort: z.enum(LLM_REASONING_EFFORTS),
  concurrency: z.number().int().min(concurrency.min).max(concurrency.max),
  unitsPerRequest: z.number().int().min(unitsPerRequest.min).max(unitsPerRequest.max),
});
export type LlmParams = z.infer<typeof LlmParamsSchema>;

/**
 * The endpoint as the client sees it.
 *
 * **The API key is never sent to the browser.** `apiKeySet` says whether one is
 * stored, which is all the field needs in order to render, and the key itself
 * only ever travels inbound. It is a dummy on most local servers — and that is
 * exactly the habit that puts a real one in the box eventually.
 */
export const LlmSettingsSchema = z.object({
  adapter: z.enum(LLM_ADAPTERS),
  /** Empty until the user configures one. `''` is "not configured", not a bad URL. */
  baseUrl: z.string(),
  model: z.string(),
  apiKeySet: z.boolean(),
  /** Whether `baseUrl` stays on this machine — drives S7's privacy callout. */
  loopback: z.boolean(),
  params: LlmParamsSchema,
  /** FR-PH-7 / Appendix A: mask `<x/>` as `[[n]]` before sending. */
  maskPlaceholders: z.boolean(),
  /** FR-6.13, off by default and unimplemented until phase 2. */
  fewShotExamples: z.boolean(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

/** One line of the "Test connection" callout (FR-6.3). */
export const LlmProbeResultSchema = z.object({
  step: z.enum(LLM_PROBE_STEPS),
  ok: z.boolean(),
  /** A sentence a user can act on: the failing URL, the status, the parse error. */
  detail: z.string(),
  latencyMs: z.number().nullable(),
});
export type LlmProbeResult = z.infer<typeof LlmProbeResultSchema>;

export const LlmProbeSchema = z.object({
  /**
   * Reached it, and it completed.
   *
   * The model-list step is reported but does not gate this: a server with no
   * `/v1/models` route is perfectly usable — llama.cpp's is the common example
   * — and a red callout over a working endpoint would be a lie.
   */
  ok: z.boolean(),
  /** The origin actually contacted, so the callout can name it (FR-6.15). */
  endpoint: z.string(),
  model: z.string(),
  steps: z.array(LlmProbeResultSchema),
  /** What the server offers, where it offers a list at all. */
  models: z.array(z.string()),
  at: z.string(),
});
export type LlmProbe = z.infer<typeof LlmProbeSchema>;

export const SettingsSchema = z.object({
  llm: LlmSettingsSchema,
  theme: z.enum(THEME_MODES),
  /**
   * `LxSegmentEditor`'s rendering mode — a personal, per-browser preference
   * like `theme`, not a project setting. `'text'` is the fallback if chip
   * editing misbehaves in this browser.
   */
  editorMode: z.enum(EDITOR_MODES),
  /**
   * The last probe, or null if none has run in this process.
   *
   * Deliberately not persisted: a green result from yesterday says nothing
   * about whether LM Studio is running now, and S1's environment panel reading
   * "reachable" over a dead endpoint is worse than reading "unknown".
   */
  lastProbe: LlmProbeSchema.nullable(),
  /**
   * Saved Phrase Strings access tokens, without their secrets — like the LLM
   * key a secret never travels to the browser. Machine-wide, because a token
   * belongs to a person, not to a repository. Managed through
   * `/api/phrase/tokens`, not through the settings patch.
   */
  phrase: z.object({ tokens: z.array(PhraseTokenSchema) }),
  /** S17: the launch menu, and where the last checkout went. */
  launch: z.object({
    /** Off reopens the last project directly at start. */
    showMenu: z.boolean(),
    /** Parent folder of the last Phrase checkout; null before the first one. */
    lastParentDir: z.string().nullable(),
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Everything a user can change on S7's model pane. All optional.
 *
 * `.strict()` for the same reason M6's segment schemas are:
 * silently dropping a key we do not recognise is indistinguishable, from the
 * client's side, from having saved it.
 */
export const SettingsPatchSchema = z
  .object({
    adapter: z.enum(LLM_ADAPTERS).optional(),
    /** Validated as a URL by the route, not here: `''` clears it. */
    baseUrl: z.string().max(2048).optional(),
    model: z.string().max(256).optional(),
    /** Inbound only. `''` deletes the stored key. */
    apiKey: z.string().max(4096).optional(),
    params: LlmParamsSchema.partial().optional(),
    maskPlaceholders: z.boolean().optional(),
    fewShotExamples: z.boolean().optional(),
    theme: z.enum(THEME_MODES).optional(),
    editorMode: z.enum(EDITOR_MODES).optional(),
    showLaunchMenu: z.boolean().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** `POST /api/llm/test` takes no body: it probes exactly what is stored. */
export const LlmTestRequestSchema = z.object({}).strict().optional();

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  adapter: 'openai',
  baseUrl: '',
  model: '',
  apiKeySet: false,
  loopback: false,
  params: { ...DEFAULT_LLM_PARAMS },
  // Raw by default: masking is opt-in, because a model told to write no markup
  // also drops markup that is part of the source text itself.
  maskPlaceholders: false,
  fewShotExamples: false,
};
