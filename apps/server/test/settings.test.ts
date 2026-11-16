// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Health, LlmProbe, Settings } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M8's server half: the machine settings store (FR-6.1, FR-6.4) and the three
 * answers "Test connection" gives (FR-6.3).
 *
 * The guarantee under test that matters most is FR-6.15 — the server contacts
 * the configured endpoint and nothing else. It is proven the only way it can
 * honestly be proven: with two real HTTP servers, where the second one asserts
 * it was never called.
 */

let stateDir: string;
let app: FastifyInstance;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'lexi-settings-'));
  app = await buildApp(testConfig({ stateDir }), { logger: false });
});

afterEach(async () => {
  await app.close();
  await rm(stateDir, { recursive: true, force: true });
});

const get = async (): Promise<Settings> => {
  const res = await app.inject({ method: 'GET', url: '/api/settings', headers: goodHeaders() });
  expect(res.statusCode).toBe(200);
  return res.json<Settings>();
};

const patch = (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'PATCH', url: '/api/settings', headers: goodHeaders(), payload });

const test = (): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: '/api/llm/test', headers: goodHeaders(), payload: {} });

describe('GET/PATCH /api/settings', () => {
  it('answers with the defaults before anything is configured, and with no project open', async () => {
    const settings = await get();
    expect(settings.llm.baseUrl).toBe('');
    expect(settings.llm.model).toBe('');
    expect(settings.llm.adapter).toBe('openai');
    expect(settings.llm.apiKeySet).toBe(false);
    expect(settings.lastProbe).toBeNull();
    // Low temperature, one unit per request: FR-6.4 and FR-6.8's defaults.
    expect(settings.llm.params.temperature).toBe(0.2);
    expect(settings.llm.params.unitsPerRequest).toBe(1);
    // Raw markup: masking is opt-in, because the masked invariants once told
    // the model to write no markup at all and it dropped markup in the text.
    expect(settings.llm.maskPlaceholders).toBe(false);
    // Reasoning off: a UI string is not a question deliberation improves, and
    // a model that loops on one spends the whole budget proving it.
    expect(settings.llm.params.reasoningEffort).toBe('none');
  });

  it('keeps a chosen reasoning effort across a reboot', async () => {
    // `sanitizeParams` warns that a field written by PATCH but never read back
    // reverts to its default on the next boot, silently — which is what
    // `contextWindow` once did. This is that regression, for this field.
    await patch({ params: { reasoningEffort: 'high' } });

    const reborn = await buildApp(testConfig({ stateDir }), { logger: false });
    try {
      const settings = (
        await reborn.inject({ method: 'GET', url: '/api/settings', headers: goodHeaders() })
      ).json<Settings>();
      expect(settings.llm.params.reasoningEffort).toBe('high');
    } finally {
      await reborn.close();
    }
  });

  it('rejects a reasoning effort that is not one of the five', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: goodHeaders(),
      payload: { params: { reasoningEffort: 'maximum' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('gives a settings file written before the field existed the new default', async () => {
    // The reporting user's own file: eight params, no `reasoningEffort`, and a
    // `maxTokens` they raised by hand. The fix has to reach them without their
    // editing anything, and without quietly resetting what they did set.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        llm: {
          adapter: 'openai',
          baseUrl: 'http://192.168.1.50:1234/v1',
          model: 'google/gemma-4-12b-qat',
          apiKey: '',
          params: {
            temperature: 0.2,
            topP: 0.9,
            maxTokens: 10_000,
            seed: 7,
            contextWindow: 64_000,
            requestTimeoutSeconds: 600,
            concurrency: 1,
            unitsPerRequest: 1,
          },
          maskPlaceholders: true,
          fewShotExamples: false,
        },
        theme: 'dark',
        editorMode: 'chips',
      }),
      'utf8',
    );

    const reborn = await buildApp(testConfig({ stateDir }), { logger: false });
    try {
      const settings = (
        await reborn.inject({ method: 'GET', url: '/api/settings', headers: goodHeaders() })
      ).json<Settings>();
      expect(settings.llm.params.reasoningEffort).toBe('none');
      // And nothing they had chosen was clobbered on the way past.
      expect(settings.llm.params.maxTokens).toBe(10_000);
      expect(settings.llm.params.requestTimeoutSeconds).toBe(600);
      expect(settings.llm.model).toBe('google/gemma-4-12b-qat');
      // A stored choice survives the change of default: only new installs go raw.
      expect(settings.llm.maskPlaceholders).toBe(true);
    } finally {
      await reborn.close();
    }
  });

  it('persists to ~/.lexi/settings.json and reads it back on the next boot', async () => {
    await patch({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b-instruct' });
    await patch({ params: { temperature: 0.7, seed: null } });
    // EVERY stored number, not a sample: a field the patch writes and the
    // reader does not copy back reverts to its default on the next boot, and
    // nothing says so.
    await patch({ params: { contextWindow: 32_768, requestTimeoutSeconds: 300 } });
    // Same failure mode is not just for numbers — `editorMode`
    // is the newest field with the same four touch points to get right.
    await patch({ editorMode: 'text' });

    const reborn = await buildApp(testConfig({ stateDir }), { logger: false });
    try {
      const res = await reborn.inject({
        method: 'GET',
        url: '/api/settings',
        headers: goodHeaders(),
      });
      const settings = res.json<Settings>();
      expect(settings.llm.baseUrl).toBe('http://localhost:11434/v1');
      expect(settings.llm.model).toBe('qwen2.5:14b-instruct');
      expect(settings.llm.params.temperature).toBe(0.7);
      expect(settings.llm.params.seed).toBeNull();
      expect(settings.llm.params.contextWindow).toBe(32_768);
      expect(settings.llm.params.requestTimeoutSeconds).toBe(300);
      expect(settings.editorMode).toBe('text');
      // Patched one at a time: the second patch must not have reset the first,
      // nor the untouched parameters.
      expect(settings.llm.params.topP).toBe(0.9);
    } finally {
      await reborn.close();
    }
  });

  it('never sends the API key back to the browser, and stores it 0600', async () => {
    const res = await patch({ apiKey: 'sk-local-dummy-key' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('sk-local-dummy-key');
    expect(res.json<Settings>().llm.apiKeySet).toBe(true);

    const file = join(stateDir, 'settings.json');
    expect(await readFile(file, 'utf8')).toContain('sk-local-dummy-key');
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    // An empty string is the only way to say "remove the key I stored".
    expect((await patch({ apiKey: '' })).json<Settings>().llm.apiKeySet).toBe(false);
  });

  it('knows whether the endpoint stays on this machine', async () => {
    for (const [url, loopback] of [
      ['http://localhost:11434/v1', true],
      ['http://127.0.0.1:1234/v1', true],
      ['http://[::1]:1234/v1', true],
      ['https://api.example.com/v1', false],
    ] as const) {
      await patch({ baseUrl: url });
      expect((await get()).llm.loopback, url).toBe(loopback);
    }
  });

  it('refuses what it cannot honour', async () => {
    // The mistake everybody makes once — and `new URL` accepts it, reading
    // `localhost:` as a scheme, so the message has to be produced deliberately.
    const noScheme = await patch({ baseUrl: 'localhost:11434' });
    expect(noScheme.statusCode).toBe(400);
    const message = noScheme.json<{ error: { message: string } }>().error.message;
    expect(message).toContain('missing its scheme');
    expect(message).toContain('http://localhost:11434/v1');

    expect((await patch({ baseUrl: 'file:///etc/passwd' })).statusCode).toBe(400);
    // Named in the vocabulary, implemented by nothing.
    expect((await patch({ adapter: 'ollama' })).statusCode).toBe(400);
    expect((await patch({ params: { temperature: 9 } })).statusCode).toBe(400);
    expect((await patch({ params: { concurrency: 0 } })).statusCode).toBe(400);
    // `.strict()`: a key we do not recognise is refused, not dropped in silence.
    expect((await patch({ baseUrlTypo: 'http://localhost:1234' })).statusCode).toBe(400);

    // And none of it was stored.
    expect((await get()).llm.baseUrl).toBe('');
  });

  it('keeps a corrupt settings file from stopping the server', async () => {
    await patch({ baseUrl: 'http://localhost:11434/v1' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(stateDir, 'settings.json'), '{ this is not json', 'utf8');

    const reborn = await buildApp(testConfig({ stateDir }), { logger: false });
    try {
      const res = await reborn.inject({
        method: 'GET',
        url: '/api/settings',
        headers: goodHeaders(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<Settings>().llm.baseUrl).toBe('');
    } finally {
      await reborn.close();
    }
  });

  it('drops out-of-range values from a hand-edited file rather than using them', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        llm: {
          adapter: 'telepathy',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen',
          apiKey: '',
          params: {
            temperature: 400,
            concurrency: 99,
            unitsPerRequest: 'lots',
            seed: null,
            reasoningEffort: 'maximum',
          },
          maskPlaceholders: 'yes',
        },
        theme: 'aubergine',
        editorMode: 'wireframe',
      }),
      'utf8',
    );

    const reborn = await buildApp(testConfig({ stateDir }), { logger: false });
    try {
      const settings = (
        await reborn.inject({ method: 'GET', url: '/api/settings', headers: goodHeaders() })
      ).json<Settings>();
      expect(settings.llm.adapter).toBe('openai');
      expect(settings.llm.params.temperature).toBe(2); // clamped to the limit
      expect(settings.llm.params.concurrency).toBe(8);
      expect(settings.llm.params.unitsPerRequest).toBe(1); // back to the default
      expect(settings.llm.params.reasoningEffort).toBe('none'); // not a value we know
      expect(settings.llm.maskPlaceholders).toBe(false); // back to the default
      expect(settings.theme).toBe('system');
      expect(settings.editorMode).toBe('chips');
      // The fields that were fine survived.
      expect(settings.llm.model).toBe('qwen');
    } finally {
      await reborn.close();
    }
  });
});

/* -- the endpoint, against real servers ------------------------------------ */

interface FakeServer {
  readonly origin: string;
  readonly hits: string[];
  close(): Promise<void>;
}

type Handler = (path: string) => {
  status: number;
  body: string;
  location?: string;
  /** Answer this late, so a deadline has something to expire against. */
  delayMs?: number;
};

async function fakeServer(handler: Handler): Promise<FakeServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const answer = handler(req.url ?? '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (answer.location !== undefined) headers['location'] = answer.location;
    const reply = (): void => {
      res.writeHead(answer.status, headers);
      res.end(answer.body);
    };
    if (answer.delayMs === undefined) reply();
    else setTimeout(reply, answer.delayMs).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const OPENAI_LIKE: Handler = (path) => {
  if (path.endsWith('/models')) {
    return { status: 200, body: JSON.stringify({ data: [{ id: 'qwen2.5:14b' }, { id: 'phi4' }] }) };
  }
  if (path.endsWith('/chat/completions')) {
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 21, completion_tokens: 1 },
      }),
    };
  }
  return { status: 404, body: '{}' };
};

describe('POST /api/llm/test', () => {
  it('refuses to probe before an endpoint is configured', async () => {
    const res = await test();
    expect(res.statusCode).toBe(400);
  });

  it('reports reachability, the model list and a trivial completion separately', async () => {
    const server = await fakeServer(OPENAI_LIKE);
    try {
      await patch({ baseUrl: `${server.origin}/v1`, model: 'qwen2.5:14b' });
      const res = await test();
      expect(res.statusCode).toBe(200);

      const probe = res.json<LlmProbe>();
      expect(probe.ok).toBe(true);
      expect(probe.endpoint).toBe(server.origin);
      expect(probe.models).toEqual(['qwen2.5:14b', 'phi4']);
      expect(probe.steps.map((s) => [s.step, s.ok])).toEqual([
        ['reachable', true],
        ['models', true],
        ['completion', true],
      ]);
      expect(probe.steps[2]?.detail).toContain('ok');

      // Health reports the last probe rather than calling out again (FR-6.3).
      const health = (
        await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() })
      ).json<Health>();
      expect(health.llm).toEqual({ reachable: true, model: 'qwen2.5:14b' });
      expect((await get()).lastProbe?.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('stays green when the server offers no model list — llama.cpp is the common case', async () => {
    const server = await fakeServer((path) =>
      path.endsWith('/chat/completions')
        ? OPENAI_LIKE(path)
        : { status: 404, body: '{"error":"not found"}' },
    );
    try {
      await patch({ baseUrl: `${server.origin}/v1`, model: 'local' });
      const probe = (await test()).json<LlmProbe>();
      expect(probe.steps.map((s) => [s.step, s.ok])).toEqual([
        ['reachable', true],
        ['models', false],
        ['completion', true],
      ]);
      // The list is informational; it must not paint a working endpoint red.
      expect(probe.ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('separates "not there" from "there, but it cannot complete"', async () => {
    const dead = await fakeServer(OPENAI_LIKE);
    const origin = dead.origin;
    await dead.close();

    await patch({ baseUrl: `${origin}/v1`, model: 'qwen' });
    const unreachable = (await test()).json<LlmProbe>();
    expect(unreachable.ok).toBe(false);
    expect(unreachable.steps[0]).toMatchObject({ step: 'reachable', ok: false });
    // The steps after a fatal one are omitted, not reported as failures of
    // something that was never attempted.
    expect(unreachable.steps.some((s) => s.step === 'completion')).toBe(false);

    const broken = await fakeServer((path) =>
      path.endsWith('/models')
        ? OPENAI_LIKE(path)
        : { status: 500, body: '{"error":"model failed to load"}' },
    );
    try {
      await patch({ baseUrl: `${broken.origin}/v1`, model: 'qwen' });
      const probe = (await test()).json<LlmProbe>();
      expect(probe.ok).toBe(false);
      expect(probe.steps.map((s) => [s.step, s.ok])).toEqual([
        ['reachable', true],
        ['models', true],
        ['completion', false],
      ]);
      expect(probe.steps[2]?.detail).toContain('model failed to load');
    } finally {
      await broken.close();
    }
  });

  it('clears the last probe when the endpoint changes underneath it', async () => {
    const server = await fakeServer(OPENAI_LIKE);
    try {
      await patch({ baseUrl: `${server.origin}/v1`, model: 'qwen2.5:14b' });
      expect((await test()).json<LlmProbe>().ok).toBe(true);

      await patch({ model: 'some-other-model' });
      expect((await get()).lastProbe).toBeNull();
      // And health stops claiming a model it has never reached.
      const health = (
        await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() })
      ).json<Health>();
      expect(health.llm).toEqual({ reachable: false, model: 'some-other-model' });
    } finally {
      await server.close();
    }
  });
});

/**
 * FR-6.15, the promise the whole proxy exists to make enforceable.
 *
 * A redirect is the interesting case because it is the one that needs no bug on
 * our side: the configured endpoint answers `302 Location: http://elsewhere/`
 * and `fetch` follows it by default, carrying the prompt — the most sensitive
 * payload in the product — to a host the user never configured. So the second
 * server here exists to assert it was never called.
 */
describe('FR-6.15 — nothing but the configured endpoint', () => {
  it('refuses a redirect off the configured host, and the other host never hears from us', async () => {
    const elsewhere = await fakeServer(OPENAI_LIKE);
    const redirector = await fakeServer(() => ({
      status: 302,
      body: '',
      location: `${elsewhere.origin}/v1/models`,
    }));

    try {
      await patch({ baseUrl: `${redirector.origin}/v1`, model: 'qwen' });
      const probe = (await test()).json<LlmProbe>();

      expect(probe.ok).toBe(false);
      expect(probe.steps[0]?.detail).toContain('redirected');
      expect(probe.steps[0]?.detail).toContain('FR-6.15');
      expect(redirector.hits.length).toBeGreaterThan(0);
      expect(elsewhere.hits).toEqual([]);
    } finally {
      await redirector.close();
      await elsewhere.close();
    }
  });

  /**
   * The deadline for a completion is the user's, not a constant.
   *
   * A 27B model on CPU — or any model the server still has to load into VRAM —
   * takes minutes, and the 30 s that used to be hard-coded made every such
   * setup look like a broken endpoint. Reported from use.
   */
  it('honours the configured response timeout, and says so when it expires', async () => {
    const slow = await fakeServer((path) =>
      path.endsWith('/chat/completions')
        ? { ...OPENAI_LIKE(path), delayMs: 3_000 }
        : OPENAI_LIKE(path),
    );
    try {
      await patch({
        baseUrl: `${slow.origin}/v1`,
        model: 'qwen',
        params: { requestTimeoutSeconds: 1 },
      });

      const probe = (await test()).json<LlmProbe>();
      const completion = probe.steps.find((s) => s.step === 'completion');
      expect(completion?.ok).toBe(false);
      expect(completion?.detail).toContain('did not answer within 1 s');
      // And the message points at the setting rather than at the endpoint.
      expect(completion?.detail).toContain('Response timeout');
      // Reachability is NOT governed by it: the server answered /models at once.
      expect(probe.steps[0]).toMatchObject({ step: 'reachable', ok: true });
    } finally {
      await slow.close();
    }
  });

  it('gives a slow model the time it was granted', async () => {
    const slow = await fakeServer((path) =>
      path.endsWith('/chat/completions')
        ? { ...OPENAI_LIKE(path), delayMs: 1_200 }
        : OPENAI_LIKE(path),
    );
    try {
      // Longer than the answer takes, and far longer than the old constant's
      // reachability multiple would have allowed at this setting.
      await patch({
        baseUrl: `${slow.origin}/v1`,
        model: 'qwen',
        params: { requestTimeoutSeconds: 30 },
      });
      const probe = (await test()).json<LlmProbe>();
      expect(probe.ok).toBe(true);
      expect(probe.steps.find((s) => s.step === 'completion')?.ok).toBe(true);
    } finally {
      await slow.close();
    }
  });

  it('refuses a timeout outside its bounds rather than storing a useless one', async () => {
    expect((await patch({ params: { requestTimeoutSeconds: 0 } })).statusCode).toBe(400);
    expect((await patch({ params: { requestTimeoutSeconds: 99_999 } })).statusCode).toBe(400);
  });

  it('is the only outbound call in the server: nothing is contacted until one is configured', async () => {
    const server = await fakeServer(OPENAI_LIKE);
    try {
      // Everything a client does on a fresh boot, with an endpoint configured
      // but never tested: not one of these may talk to it.
      await patch({ baseUrl: `${server.origin}/v1`, model: 'qwen' });
      await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() });
      await app.inject({ method: 'GET', url: '/api/settings', headers: goodHeaders() });
      await app.inject({ method: 'GET', url: '/api/recents', headers: goodHeaders() });
      expect(server.hits).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
