// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  LLM_COMPLETION_TIMEOUT_MS,
  LLM_PROBE_TIMEOUT_MS,
  type LlmAdapter,
  type LlmParams,
} from '@lexi/shared';

import { CopilotLlmClient } from './copilot-client.js';

/**
 * The one door to the outside world.
 *
 * FR-6.15 is a hard guarantee — "no network request to any host other than the
 * configured LLM endpoint" — and the whole reason the LLM calls are proxied
 * through this process rather than made from the page. A guarantee
 * only holds if there is exactly one place it can be broken, so **every
 * outbound request in the server goes through `llmFetch`**, which refuses any
 * URL whose origin is not the configured endpoint's. ESLint forbids `fetch`
 * everywhere else under `apps/server/src`.
 *
 * Three things the check has to cover, and only the first is obvious:
 *
 * 1. The URL we build. Trivially ours, but asserted anyway — the assertion is
 *    what makes a future caller that passes an absolute URL fail loudly.
 * 2. **Redirects.** `redirect: 'manual'` is not a nicety: a 302 from the
 *    configured endpoint to `evil.com` would otherwise be followed
 *    automatically, carrying the prompt — the product's most sensitive payload
 *    — to a host the user never configured. A 3xx is refused, not followed.
 * 3. The protocol. `file:` and `data:` parse perfectly well as URLs.
 */

export interface LlmEndpoint {
  readonly adapter: LlmAdapter;
  readonly baseUrl: string;
  readonly model: string;
  /** Never leaves the server. Many local servers accept any non-empty string. */
  readonly apiKey: string;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatResult {
  readonly text: string;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** Of `completionTokens`, the part spent thinking. Null where unreported. */
  readonly reasoningTokens: number | null;
  /** `stop`, `length`, … — the difference between "done" and "ran out". */
  readonly finishReason: string | null;
  /** The raw body, for the run log M11 writes to `.lexi/logs/` (FR-6.14). */
  readonly raw: string;
}

/** Everything that can go wrong outbound, with a sentence a user can act on. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'network' | 'http' | 'protocol' | 'refused',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Parse and normalise a base URL, or explain why it cannot be used. */
export function parseBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (trimmed === '') throw new LlmError('No endpoint is configured.', 'config');

  // The scheme is checked BEFORE parsing, and by string rather than by
  // `url.protocol`, because `new URL('localhost:11434')` succeeds: it reads
  // `localhost:` as the scheme. Parsing first therefore reports the single most
  // common mistake on this screen — pasting a bare host:port — as "only http
  // and https are allowed, not localhost:", which sends the user looking for a
  // protocol setting that does not exist.
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new LlmError(
      `"${trimmed}" is missing its scheme. It should look like http://localhost:11434/v1`,
      'config',
    );
  }
  try {
    return new URL(trimmed);
  } catch {
    throw new LlmError(
      `"${trimmed}" is not a URL. It should look like http://localhost:11434/v1`,
      'config',
    );
  }
}

/**
 * Fetch `path` under the configured endpoint. The only `fetch` in the server.
 *
 * `path` is always a literal in this module — it is never built from user input
 * — but it is still resolved and re-checked, because the check is the contract
 * and not a formality.
 */
export async function llmFetch(
  endpoint: LlmEndpoint,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
  timeoutMs: number,
): Promise<Response> {
  const base = parseBaseUrl(endpoint.baseUrl);
  // Trailing slashes on the base would otherwise produce `/v1//models`, which
  // some servers 404. The path always starts with one.
  const url = new URL(base.href.replace(/\/+$/, '') + path);

  if (url.origin !== base.origin) {
    throw new LlmError(
      `Refused: ${url.origin} is not the configured endpoint ${base.origin} (FR-6.15).`,
      'refused',
    );
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (endpoint.apiKey !== '') headers['authorization'] = `Bearer ${endpoint.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      // See note 2 above. Not negotiable.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new LlmError(
      timedOut
        ? `${url.origin} did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
            `A local model that needs longer is normal — raise "Response timeout" in Settings.`
        : `Could not reach ${url.origin}: ${reason}`,
      'network',
    );
  }

  // A manual redirect surfaces either as the 3xx itself or, per the fetch spec's
  // opaque-redirect filtering, as status 0. Both mean the same thing here.
  if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
    throw new LlmError(
      `Refused: ${url.origin} redirected the request. Lexi never follows a redirect off the configured endpoint (FR-6.15).`,
      'refused',
    );
  }
  return response;
}

/**
 * The adapter seam (FR-6.2).
 *
 * Two implementations ship: the OpenAI-compatible `/v1/chat/completions`
 * shape, which covers Ollama, LM Studio, llama.cpp server, vLLM, LocalAI and
 * Jan, and GitHub Copilot through its SDK (`copilot-client.ts`). Ollama's
 * native `/api/chat` is out of the MVP and exists here only as a
 * name, so that adding it later touches this file and nothing else.
 */
export interface LlmClient {
  /** `[]` where the server offers no list. Throws only on a real failure. */
  listModels(): Promise<string[]>;
  chat(messages: readonly ChatMessage[], params: ChatParams): Promise<ChatResult>;
}

export type ChatParams = Pick<
  LlmParams,
  'temperature' | 'topP' | 'maxTokens' | 'seed' | 'reasoningEffort' | 'requestTimeoutSeconds'
> & {
  /** Overrides the configured deadline. Only the probe uses it. */
  readonly timeoutMs?: number;
};

export function createLlmClient(endpoint: LlmEndpoint): LlmClient {
  if (endpoint.adapter === 'ollama') {
    throw new LlmError(
      'The Ollama-native adapter is not implemented. Its OpenAI-compatible endpoint (/v1) works today.',
      'config',
    );
  }
  if (endpoint.adapter === 'copilot') return new CopilotLlmClient(endpoint);
  return new OpenAiCompatibleClient(endpoint);
}

/**
 * "Test connection" (FR-6.3), as three separately reported answers.
 *
 * Reachability, the model list and a trivial completion fail for three
 * different reasons and have three different fixes — a wrong port, a server
 * that answers but has no such model, and a model that loads but cannot
 * complete — while all three look identical to a user who only sees "nothing
 * happened". So each step reports its own line, and the steps after a fatal one
 * are omitted rather than reported as failures they never got to attempt.
 *
 * **The model list is informational and does not gate `ok`.** A server with no
 * `/v1/models` route is perfectly usable; llama.cpp's server is the common
 * example. What gates `ok` is: did we reach it, and did it complete.
 */
export async function probeEndpoint(
  endpoint: LlmEndpoint,
  params: ChatParams,
): Promise<{ ok: boolean; steps: ProbeStep[]; models: string[]; endpoint: string }> {
  const steps: ProbeStep[] = [];
  const origin = endpoint.adapter === 'copilot' ? 'GitHub Copilot' : originOf(endpoint.baseUrl);

  let client: LlmClient;
  try {
    client = createLlmClient(endpoint);
  } catch (error) {
    steps.push({ step: 'reachable', ok: false, detail: messageOf(error), latencyMs: null });
    return { ok: false, steps, models: [], endpoint: origin };
  }

  // Step 1 and step 2 share one request: reachability is "the server answered
  // at all", whatever it answered, so a 404 from /models still proves it is
  // there. Splitting them into two round trips would prove nothing more.
  let models: string[] = [];
  const started = performance.now();
  try {
    models = await client.listModels();
    const latencyMs = Math.round(performance.now() - started);
    steps.push({ step: 'reachable', ok: true, detail: `${origin} answered.`, latencyMs });
    steps.push({
      step: 'models',
      ok: true,
      detail:
        models.length === 0
          ? 'The server offers a model list, and it is empty.'
          : `${models.length} model${models.length === 1 ? '' : 's'} available.`,
      latencyMs: null,
    });
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const kind = error instanceof LlmError ? error.kind : 'network';
    // An HTTP or protocol answer still proves the server is there; only a
    // network failure or a refusal means it is not.
    const reached = kind === 'http' || kind === 'protocol';
    steps.push({
      step: 'reachable',
      ok: reached,
      detail: reached ? `${origin} answered.` : messageOf(error),
      latencyMs: reached ? latencyMs : null,
    });
    steps.push({ step: 'models', ok: false, detail: messageOf(error), latencyMs: null });
    if (!reached) return { ok: false, steps, models, endpoint: origin };
  }

  try {
    // The user's own deadline, not a multiple of the reachability one: a
    // machine that needs two minutes to answer needs them here too, and a
    // "Test connection" that fails where a translation would succeed is worse
    // than no test at all.
    const result = await client.chat(TRIVIAL_COMPLETION, {
      ...params,
      maxTokens: 16,
      temperature: 0,
    });
    steps.push({
      step: 'completion',
      ok: true,
      detail: `Trivial completion in ${result.latencyMs} ms — ${excerpt(result.text)}`,
      latencyMs: result.latencyMs,
    });
    return { ok: true, steps, models, endpoint: origin };
  } catch (error) {
    steps.push({ step: 'completion', ok: false, detail: messageOf(error), latencyMs: null });
    return { ok: false, steps, models, endpoint: origin };
  }
}

interface ProbeStep {
  readonly step: 'reachable' | 'models' | 'completion';
  readonly ok: boolean;
  readonly detail: string;
  readonly latencyMs: number | null;
}

/**
 * Deliberately not a translation. The point is to prove the model answers at
 * all; asking it to translate would confuse "the endpoint works" with "the
 * model is any good", which is what the run log and the edit rate are for.
 */
const TRIVIAL_COMPLETION: readonly ChatMessage[] = [
  { role: 'system', content: 'You answer with one word and nothing else.' },
  { role: 'user', content: 'Reply with the single word: ok' },
];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The origin, or the raw string when it does not parse — for the message. */
function originOf(baseUrl: string): string {
  try {
    return parseBaseUrl(baseUrl).origin;
  } catch {
    return baseUrl.trim();
  }
}

class OpenAiCompatibleClient implements LlmClient {
  constructor(private readonly endpoint: LlmEndpoint) {}

  async listModels(): Promise<string[]> {
    const response = await llmFetch(
      this.endpoint,
      '/models',
      { method: 'GET' },
      LLM_PROBE_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new LlmError(
        `${response.status} ${response.statusText || 'error'} from /models — this server does not offer a model list.`,
        'http',
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new LlmError('/models answered, but not with an OpenAI-shaped list.', 'protocol');
    }
    return data
      .map((entry) => (entry as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string');
  }

  async chat(messages: readonly ChatMessage[], params: ChatParams): Promise<ChatResult> {
    if (this.endpoint.model.trim() === '') {
      throw new LlmError('No model is configured.', 'config');
    }

    const payload = {
      model: this.endpoint.model,
      messages,
      temperature: params.temperature,
      top_p: params.topP,
      max_tokens: params.maxTokens,
      // Omitted rather than sent as null: a server that does not know the field
      // is likelier to reject an explicit null than to ignore a missing key.
      ...(params.seed === null ? {} : { seed: params.seed }),
      // Same bargain, one value further: `'server'` means "do not raise the
      // subject", so the key never appears. Every other value is the user's
      // explicit answer and goes on the wire.
      ...(params.reasoningEffort === 'server' ? {} : { reasoning_effort: params.reasoningEffort }),
      stream: false,
    };

    const started = performance.now();
    const response = await llmFetch(
      this.endpoint,
      '/chat/completions',
      { method: 'POST', body: JSON.stringify(payload) },
      timeoutOf(params),
    );
    const raw = await response.text();
    const latencyMs = Math.round(performance.now() - started);

    if (!response.ok) {
      throw new LlmError(
        `${response.status} ${response.statusText || 'error'} — ${excerpt(raw)}`,
        'http',
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new LlmError(`The response was not JSON — ${excerpt(raw)}`, 'protocol');
    }

    const text = contentOf(body);
    if (text === null) {
      throw new LlmError(`No message content in the response — ${excerpt(raw)}`, 'protocol');
    }

    const usage = (body as { usage?: Record<string, unknown> }).usage;
    const completionTokens = intOrNull(usage?.['completion_tokens']);
    const reasoningTokens = intOrNull(
      (usage?.['completion_tokens_details'] as Record<string, unknown> | undefined)?.[
        'reasoning_tokens'
      ],
    );
    const finishReason = finishReasonOf(body);

    /**
     * The answer that is empty because the thinking never stopped.
     *
     * A reasoning model bills its deliberation to the same budget as the answer
     * but returns it somewhere `content` does not look — `reasoning_content` on
     * an OpenAI-compatible server. Run out of budget mid-thought and the reply
     * is a perfectly well-formed completion whose content is the empty string.
     *
     * Without this, that case falls through to the empty-answer handling in
     * `translateUnit`, which guesses at the context window and sends the user to
     * a setting that had nothing to do with it. `finish_reason` is the one field
     * that distinguishes "the model had nothing to say" from "the model was
     * still talking when the budget ran out", so it is worth a sentence of its
     * own — naming the tokens, and the two settings that actually move.
     */
    if (text.trim() === '' && finishReason === 'length') {
      const spent = reasoningTokens ?? completionTokens ?? params.maxTokens;
      throw new LlmError(
        `The model spent all ${spent} tokens thinking and never answered. ` +
          `Set "Reasoning" to Off in Settings, or raise "Max tokens".`,
        'protocol',
      );
    }

    return {
      text,
      latencyMs,
      promptTokens: intOrNull(usage?.['prompt_tokens']),
      completionTokens,
      reasoningTokens,
      finishReason,
      raw,
    };
  }
}

/** `choices[0].finish_reason`, or null where the server omits it. */
function finishReasonOf(body: unknown): string | null {
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const reason = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * The deadline for one completion, in milliseconds.
 *
 * The constant is a fallback for a caller with no settings to read, not a
 * policy: how long a local model may take is the user's to declare, because it
 * depends on the model, the hardware and whether the server still has to load
 * the weights.
 */
const timeoutOf = (params: ChatParams): number =>
  params.timeoutMs ??
  (params.requestTimeoutSeconds > 0
    ? params.requestTimeoutSeconds * 1000
    : LLM_COMPLETION_TIMEOUT_MS);

/** `choices[0].message.content`, tolerating the servers that answer `text`. */
function contentOf(body: unknown): string | null {
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  if (typeof first.message?.content === 'string') return first.message.content;
  if (typeof first.text === 'string') return first.text;
  return null;
}

const intOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

/** Enough of a body to recognise it, never enough to fill the callout. */
const excerpt = (raw: string): string => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat || '(empty body)';
};
