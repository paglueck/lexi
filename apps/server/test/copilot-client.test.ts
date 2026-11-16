// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_PARAMS, type Health, type LlmProbe, type Settings } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { CopilotLlmClient, flatten, stopCopilot } from '../src/services/copilot-client.js';
import { LlmError, type ChatParams, type LlmEndpoint } from '../src/services/llm-client.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * The GitHub Copilot adapter, against a fake SDK.
 *
 * The real SDK spawns the Copilot runtime and needs a Copilot seat, so what is
 * proven here is Lexi's half of the contract: what goes into a session (a
 * replaced system prompt, no tools, the chosen model), what comes back out of
 * it, and that every session is cleaned up — including after a failure.
 */

const sdk = vi.hoisted(() => {
  const state = {
    authenticated: true,
    models: [] as unknown[],
    reply: 'ok' as string | Error,
    usage: [] as unknown[],
    clientOptions: [] as unknown[],
    sessionConfigs: [] as Record<string, unknown>[],
    prompts: [] as unknown[],
    deleted: [] as string[],
    disconnected: 0,
    aborted: 0,
    stopped: 0,
  };

  class FakeSession {
    readonly sessionId = `s${state.sessionConfigs.length - 1}`;
    #usage: ((e: { data: unknown }) => void) | null = null;
    on(type: string, handler: (e: { data: unknown }) => void): void {
      if (type === 'assistant.usage') this.#usage = handler;
    }
    async sendAndWait(options: unknown, timeout: number): Promise<unknown> {
      state.prompts.push({ options, timeout });
      for (const data of state.usage) this.#usage?.({ data });
      if (state.reply instanceof Error) throw state.reply;
      return { data: { content: state.reply } };
    }
    async abort(): Promise<void> {
      state.aborted += 1;
    }
    async disconnect(): Promise<void> {
      state.disconnected += 1;
    }
  }

  class CopilotClient {
    constructor(options: unknown) {
      state.clientOptions.push(options);
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {
      state.stopped += 1;
    }
    async forceStop(): Promise<void> {}
    async getAuthStatus(): Promise<unknown> {
      return { isAuthenticated: state.authenticated };
    }
    async listModels(): Promise<unknown[]> {
      return state.models;
    }
    async createSession(config: Record<string, unknown>): Promise<FakeSession> {
      state.sessionConfigs.push(config);
      return new FakeSession();
    }
    async deleteSession(id: string): Promise<void> {
      state.deleted.push(id);
    }
  }

  return { state, CopilotClient };
});

vi.mock('@github/copilot-sdk', () => ({ CopilotClient: sdk.CopilotClient }));

const endpoint = (over: Partial<LlmEndpoint> = {}): LlmEndpoint => ({
  adapter: 'copilot',
  baseUrl: '',
  model: 'gpt-5-mini',
  apiKey: 'github_pat_test',
  ...over,
});

const params = (over: Partial<ChatParams> = {}): ChatParams => ({ ...DEFAULT_LLM_PARAMS, ...over });

const model = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  id,
  name: id,
  capabilities: { supports: { vision: false, reasoningEffort: false }, limits: {} },
  ...extra,
});

beforeEach(async () => {
  await stopCopilot();
  Object.assign(sdk.state, {
    authenticated: true,
    models: [model('gpt-5-mini'), model('claude-sonnet-4.6')],
    reply: '{"translation":"Speichern"}',
    usage: [],
    clientOptions: [],
    sessionConfigs: [],
    prompts: [],
    deleted: [],
    disconnected: 0,
    aborted: 0,
    stopped: 0,
  });
});

describe('CopilotLlmClient', () => {
  it('runs one tool-less session with the system prompt replaced, and deletes it', async () => {
    sdk.state.usage = [
      { model: 'gpt-5-mini', inputTokens: 120, outputTokens: 9, finishReason: 'stop' },
    ];
    const client = new CopilotLlmClient(endpoint());

    const result = await client.chat(
      [
        { role: 'system', content: 'You translate.' },
        { role: 'user', content: 'Save' },
      ],
      params({ requestTimeoutSeconds: 30 }),
    );

    expect(result.text).toBe('{"translation":"Speichern"}');
    expect(result.promptTokens).toBe(120);
    expect(result.completionTokens).toBe(9);
    expect(result.finishReason).toBe('stop');

    const config = sdk.state.sessionConfigs[0]!;
    expect(config['model']).toBe('gpt-5-mini');
    expect(config['availableTools']).toEqual([]);
    expect(config['systemMessage']).toEqual({ mode: 'replace', content: 'You translate.' });
    expect(config['reasoningEffort']).toBeUndefined();
    expect(sdk.state.prompts).toEqual([{ options: { prompt: 'Save' }, timeout: 30_000 }]);
    expect(sdk.state.disconnected).toBe(1);
    expect(sdk.state.deleted).toEqual(['s0']);
  });

  it('starts the runtime once, in empty mode, with the token and never the CLI login', async () => {
    const client = new CopilotLlmClient(endpoint());
    await client.listModels();
    await client.chat([{ role: 'user', content: 'x' }], params());
    expect(sdk.state.clientOptions).toHaveLength(1);
    expect(sdk.state.clientOptions[0]).toMatchObject({
      mode: 'empty',
      gitHubToken: 'github_pat_test',
      useLoggedInUser: false,
    });

    // A new token replaces the runtime: the credential is fixed at start.
    await new CopilotLlmClient(endpoint({ apiKey: 'ghp_x' })).listModels();
    expect(sdk.state.stopped).toBe(1);
    expect(sdk.state.clientOptions[1]).toMatchObject({ gitHubToken: 'ghp_x' });
  });

  it('lists the models the policy allows', async () => {
    sdk.state.models = [
      model('gpt-5-mini', { policy: { state: 'enabled', terms: '' } }),
      model('o-banned', { policy: { state: 'disabled', terms: '' } }),
      model('claude-sonnet-4.6'),
    ];
    expect(await new CopilotLlmClient(endpoint()).listModels()).toEqual([
      'gpt-5-mini',
      'claude-sonnet-4.6',
    ]);
  });

  it('sends a reasoning effort only to a model that declares it', async () => {
    sdk.state.models = [model('gpt-5-mini', { supportedReasoningEfforts: ['low', 'medium'] })];
    await new CopilotLlmClient(endpoint()).chat(
      [{ role: 'user', content: 'x' }],
      params({ reasoningEffort: 'low' }),
    );
    await new CopilotLlmClient(endpoint()).chat(
      [{ role: 'user', content: 'x' }],
      params({ reasoningEffort: 'high' }),
    );
    await new CopilotLlmClient(endpoint()).chat(
      [{ role: 'user', content: 'x' }],
      params({ reasoningEffort: 'none' }),
    );
    expect(sdk.state.sessionConfigs.map((c) => c['reasoningEffort'])).toEqual([
      'low',
      undefined,
      undefined,
    ]);
  });

  it('requires a token, and does not start the runtime without one', async () => {
    const error = await new CopilotLlmClient(endpoint({ apiKey: '' }))
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('config');
    expect((error as LlmError).message).toMatch(/needs a GitHub token/);
    expect(sdk.state.clientOptions).toHaveLength(0);
  });

  it('explains a rejected token instead of failing obscurely', async () => {
    sdk.state.authenticated = false;
    const error = await new CopilotLlmClient(endpoint()).listModels().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('config');
    expect((error as LlmError).message).toMatch(/did not accept the token/);
  });

  it('turns a timeout into the settings hint, and still cleans up', async () => {
    sdk.state.reply = new Error('Timeout after 1000ms waiting for session.idle');
    const error = await new CopilotLlmClient(endpoint())
      .chat([{ role: 'user', content: 'x' }], params({ requestTimeoutSeconds: 1 }))
      .catch((e: unknown) => e);
    expect((error as LlmError).kind).toBe('network');
    expect((error as LlmError).message).toMatch(/Response timeout/);
    expect(sdk.state.aborted).toBe(1);
    expect(sdk.state.deleted).toEqual(['s0']);
  });

  it('refuses to run with no model', async () => {
    await expect(
      new CopilotLlmClient(endpoint({ model: '' })).chat(
        [{ role: 'user', content: 'x' }],
        params(),
      ),
    ).rejects.toThrow('No model is configured.');
  });
});

describe('flatten', () => {
  it('passes a single user turn through untouched', () => {
    expect(
      flatten([
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ]),
    ).toEqual({ system: 'S', prompt: 'U' });
  });

  it('turns the strict retry into one readable transcript', () => {
    const { system, prompt } = flatten([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Save' },
      { role: 'assistant', content: 'Speichern' },
      { role: 'user', content: 'Answer with JSON only.' },
    ]);
    expect(system).toBe('S');
    expect(prompt).toBe(
      'USER:\nSave\n\nYOUR PREVIOUS ANSWER:\nSpeichern\n\nUSER:\nAnswer with JSON only.',
    );
  });
});

describe('settings with the copilot adapter', () => {
  let stateDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'lexi-copilot-'));
    app = await buildApp(testConfig({ stateDir }), { logger: false });
  });

  afterEach(async () => {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const patch = async (body: Record<string, unknown>): Promise<Settings> => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: goodHeaders(),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    return res.json<Settings>();
  };

  it('is configured without a base URL, and never returns the token', async () => {
    const settings = await patch({ adapter: 'copilot', model: 'gpt-5-mini', apiKey: 'ghp_secret' });
    expect(settings.llm.adapter).toBe('copilot');
    expect(JSON.stringify(settings)).not.toContain('ghp_secret');

    const health = await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() });
    expect(health.json<Health>().llm.model).toBe('gpt-5-mini');
  });

  it('tests the connection with no base URL', async () => {
    await patch({ adapter: 'copilot', model: 'gpt-5-mini', apiKey: 'github_pat_test' });
    const res = await app.inject({ method: 'POST', url: '/api/llm/test', headers: goodHeaders() });
    expect(res.statusCode).toBe(200);
    const probe = res.json<LlmProbe>();
    expect(probe.ok).toBe(true);
    expect(probe.endpoint).toBe('GitHub Copilot');
    expect(probe.steps.map((s) => [s.step, s.ok])).toEqual([
      ['reachable', true],
      ['models', true],
      ['completion', true],
    ]);
    expect(probe.models).toEqual(['gpt-5-mini', 'claude-sonnet-4.6']);
  });

  it('reports a missing token on the first step', async () => {
    await patch({ adapter: 'copilot', model: 'gpt-5-mini' });
    const res = await app.inject({ method: 'POST', url: '/api/llm/test', headers: goodHeaders() });
    const probe = res.json<LlmProbe>();
    expect(probe.ok).toBe(false);
    expect(probe.steps[0]).toMatchObject({ step: 'reachable', ok: false });
    expect(probe.steps[0]!.detail).toMatch(/needs a GitHub token/);
  });
});
