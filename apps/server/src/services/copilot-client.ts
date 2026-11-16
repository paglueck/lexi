// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CopilotClient, type ModelInfo } from '@github/copilot-sdk';
import { LLM_COMPLETION_TIMEOUT_MS } from '@lexi/shared';

import {
  LlmError,
  type ChatMessage,
  type ChatParams,
  type ChatResult,
  type LlmClient,
  type LlmEndpoint,
} from './llm-client.js';

/**
 * GitHub Copilot as a translation backend, through the official Copilot SDK.
 *
 * The SDK drives a bundled Copilot CLI over JSON-RPC, and that CLI is an
 * agent: it has tools, reads the working directory and keeps session history.
 * None of that belongs in a translation request, so every session is cut back
 * to a plain completion:
 *
 * - the client runs in `mode: 'empty'`, which turns every ambient feature off
 *   and makes tools opt-in — and we opt into none (`availableTools: []`);
 * - the system prompt is **replaced**, not appended to, so the model sees
 *   exactly what the prompt preview shows and not Copilot's coding-agent prompt;
 * - every permission request is rejected, as a second lock on the first;
 * - the credential is a GitHub token from Settings, never the CLI's login;
 * - each request gets its own session, which is deleted afterwards so that a
 *   job of a thousand strings does not leave a thousand entries in the user's
 *   Copilot history.
 *
 * What the SDK does not offer is sampling control: temperature, top_p, seed
 * and max tokens have no equivalent and are ignored here. S7 says so.
 *
 * The network side is the SDK's, not `llmFetch`'s — it talks to GitHub from
 * its own subprocess. Choosing this adapter is the user choosing GitHub as the
 * endpoint, and S7's privacy note names it.
 */
export class CopilotLlmClient implements LlmClient {
  constructor(private readonly endpoint: LlmEndpoint) {}

  async listModels(): Promise<string[]> {
    const models = await this.#models();
    return models.filter((m) => m.policy?.state !== 'disabled').map((m) => m.id);
  }

  async chat(messages: readonly ChatMessage[], params: ChatParams): Promise<ChatResult> {
    const model = this.endpoint.model.trim();
    if (model === '') throw new LlmError('No model is configured.', 'config');

    const client = await this.#client();
    const effort = await this.#reasoningEffort(model, params);
    const { system, prompt } = flatten(messages);
    const timeoutMs = timeoutOf(params);

    const started = performance.now();
    let session;
    try {
      session = await client.createSession({
        clientName: 'lexi',
        model,
        ...(effort === null ? {} : { reasoningEffort: effort }),
        availableTools: [],
        systemMessage: { mode: 'replace', content: system },
        infiniteSessions: { enabled: false },
        onPermissionRequest: () => ({ kind: 'reject' }),
      });
    } catch (error) {
      throw toLlmError(error, model);
    }

    const usage: UsageSample[] = [];
    session.on('assistant.usage', (event) => usage.push(event.data));

    try {
      const reply = await session.sendAndWait({ prompt }, timeoutMs);
      const latencyMs = Math.round(performance.now() - started);
      const text = reply?.data.content ?? '';
      const last = usage.at(-1);
      return {
        text,
        latencyMs,
        promptTokens: sumOrNull(usage, 'inputTokens'),
        completionTokens: sumOrNull(usage, 'outputTokens'),
        reasoningTokens: sumOrNull(usage, 'reasoningTokens'),
        finishReason: last?.finishReason ?? (reply === undefined ? null : 'stop'),
        raw: JSON.stringify({ model: last?.model ?? model, content: text, usage }),
      };
    } catch (error) {
      if (isTimeout(error)) {
        await session.abort().catch(() => undefined);
        throw new LlmError(
          `GitHub Copilot did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
            `Raise "Response timeout" in Settings, or pick a faster model.`,
          'network',
        );
      }
      throw toLlmError(error, model);
    } finally {
      const id = session.sessionId;
      await session.disconnect().catch(() => undefined);
      await client.deleteSession(id).catch(() => undefined);
    }
  }

  async #client(): Promise<CopilotClient> {
    return runtime.acquire(this.endpoint.apiKey);
  }

  async #models(): Promise<ModelInfo[]> {
    const client = await this.#client();
    try {
      return await client.listModels();
    } catch (error) {
      throw toLlmError(error, null);
    }
  }

  /**
   * Lexi's reasoning setting, in the SDK's vocabulary — or null for "say
   * nothing". The SDK has no "off": `none` and `server` both leave the model at
   * its default. It is also only sent to a model that declares the level,
   * because the runtime rejects the session otherwise.
   */
  async #reasoningEffort(model: string, params: ChatParams): Promise<ReasoningEffort | null> {
    const wanted = params.reasoningEffort;
    if (wanted === 'server' || wanted === 'none') return null;
    const info = (await this.#models().catch(() => [])).find((m) => m.id === model);
    return info?.supportedReasoningEfforts?.includes(wanted) === true ? wanted : null;
  }
}

/** Not exported by the SDK's index; the session option is where it lives. */
type ReasoningEffort = NonNullable<ModelInfo['defaultReasoningEffort']>;

type UsageSample = {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly finishReason?: string;
};

/**
 * One long-lived SDK client for the whole process.
 *
 * Starting it spawns the Copilot runtime, which is far too slow to do per
 * request. It is keyed by the token: a changed or removed token in Settings
 * replaces the client, because the credential is fixed when it starts.
 *
 * A GitHub token is required. The Copilot CLI's own login (`copilot login`)
 * is deliberately not used: it proved unreliable to pick up from here, and a
 * token in Settings is one credential, stated in one place.
 */
class CopilotRuntime {
  #client: CopilotClient | null = null;
  #starting: Promise<CopilotClient> | null = null;
  #token = '';

  async acquire(token: string): Promise<CopilotClient> {
    if (token.trim() === '') {
      await this.stop();
      throw new LlmError(MISSING_TOKEN, 'config');
    }
    if (this.#starting !== null && token === this.#token) return this.#starting;
    await this.stop();
    this.#token = token;
    this.#starting = this.#start(token);
    return this.#starting;
  }

  async #start(token: string): Promise<CopilotClient> {
    const client = new CopilotClient({
      mode: 'empty',
      // Lexi's own, not the user's ~/.copilot: nothing the Copilot CLI has
      // stored there is ours to pick up. `empty` mode insists on a directory.
      baseDirectory: join(homedir(), '.lexi', 'copilot'),
      // Nowhere near the project: nothing in it is the model's business.
      workingDirectory: tmpdir(),
      logLevel: 'error',
      gitHubToken: token,
      useLoggedInUser: false,
    });
    try {
      await client.start();
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw new LlmError(REJECTED_TOKEN, 'config');
      }
      this.#client = client;
      return client;
    } catch (error) {
      this.#starting = null;
      await client.forceStop().catch(() => undefined);
      throw error instanceof LlmError ? error : toLlmError(error, null);
    }
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#starting = null;
    if (client !== null) await client.stop().catch(() => undefined);
  }
}

const MISSING_TOKEN =
  'GitHub Copilot needs a GitHub token. Create a fine-grained token with the "Copilot Requests" permission and paste it into the GitHub token field in Settings.';
const REJECTED_TOKEN =
  'GitHub did not accept the token. It needs the "Copilot Requests" permission, and your account needs a Copilot seat.';

const runtime = new CopilotRuntime();

/** For the server's `onClose`: the runtime is a child process. */
export const stopCopilot = (): Promise<void> => runtime.stop();

/**
 * Lexi's chat turns as one system prompt and one user prompt.
 *
 * A Copilot session takes the system prompt at creation and then user turns;
 * there is no way to hand it an assistant turn it did not produce. The only
 * multi-turn exchange Lexi sends is the strict retry — system, user, the
 * model's unusable answer, and a correction — so everything after the system
 * prompt becomes one transcript the model can read top to bottom.
 */
export function flatten(messages: readonly ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1) return { system, prompt: turns[0]!.content };
  const prompt = turns
    .map((m) => `${m.role === 'user' ? 'USER' : 'YOUR PREVIOUS ANSWER'}:\n${m.content}`)
    .join('\n\n');
  return { system, prompt };
}

const timeoutOf = (params: ChatParams): number =>
  params.timeoutMs ??
  (params.requestTimeoutSeconds > 0
    ? params.requestTimeoutSeconds * 1000
    : LLM_COMPLETION_TIMEOUT_MS);

function sumOrNull(usage: readonly UsageSample[], key: keyof UsageSample): number | null {
  const values = usage.map((u) => u[key]).filter((v): v is number => typeof v === 'number');
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && /timeout|timed out/i.test(error.message);

/** An SDK or runtime failure, as a sentence S7 can show. */
export function toLlmError(error: unknown, model: string | null): LlmError {
  if (error instanceof LlmError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not authenticated|unauthori[sz]ed|401/i.test(message)) {
    return new LlmError(REJECTED_TOKEN, 'config');
  }
  if (/policy|not enabled|forbidden|403|not available|not supported/i.test(message)) {
    return new LlmError(
      model === null
        ? `GitHub Copilot refused the request: ${message}. Your organization may not allow Copilot CLI/SDK use.`
        : `GitHub Copilot refused "${model}": ${message}. The model may be disabled for your plan or organization — pick another from the list.`,
      'refused',
    );
  }
  if (/ENOENT|spawn|EACCES/.test(message)) {
    return new LlmError(`The Copilot runtime could not be started: ${message}`, 'network');
  }
  return new LlmError(`GitHub Copilot: ${message}`, 'protocol');
}
