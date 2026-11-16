// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The security matrix: every check in docs/architecture.md (security model),
 * including the Host allowlist, the measure that actually stops DNS rebinding.
 *
 * `app.inject()` rather than a live socket, because it forges `Host`, `Origin`
 * and `Sec-Fetch-Site` freely where curl cannot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, goodHeaders, TEST_PORT, TEST_TOKEN } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('the happy path', () => {
  it('allows a same-origin request carrying the boot token', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectOpen: false });
  });
});

describe('measure 0 — Host allowlist (DNS rebinding)', () => {
  /**
   * A rebound page sends `Sec-Fetch-Site: same-origin` and, on a GET, no
   * `Origin` header at all, so measures 2 and 3 both pass. Only the Host does not.
   */
  it('rejects a foreign Host even when every other signal looks same-origin', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        host: 'evil.com:4317',
        'sec-fetch-site': 'same-origin',
        'x-lexi-token': TEST_TOKEN,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('protects non-API paths too, so the token is never served to a rebound page', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.com:4317' } });
    // 403, not the 404 an unregistered route would give: the hook ran first.
    expect(res.statusCode).toBe(403);
  });

  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts %s on the configured port', async (h) => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: goodHeaders({ host: `${h}:${TEST_PORT}` }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects the right hostname on the wrong port', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: goodHeaders({ host: '127.0.0.1:9999' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a missing Host header', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'sec-fetch-site': 'same-origin', 'x-lexi-token': TEST_TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('measure 2 — Sec-Fetch-Site', () => {
  it.each(['cross-site', 'same-site', 'none'])('rejects %s', async (sfs) => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: goodHeaders({ 'sec-fetch-site': sfs }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows the header to be absent — a non-browser client, which the token covers', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: `127.0.0.1:${TEST_PORT}`, 'x-lexi-token': TEST_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('measure 3 — Origin', () => {
  it('rejects a forged Origin', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: goodHeaders({ origin: 'http://evil.com' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts our own Origin', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: goodHeaders({ origin: `http://127.0.0.1:${TEST_PORT}` }),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('measure 4 — the boot token', () => {
  it('rejects a missing token', async () => {
    app = await buildTestApp();
    const headers = goodHeaders();
    delete (headers as Record<string, string | undefined>)['x-lexi-token'];
    const res = await app.inject({ method: 'GET', url: '/api/health', headers });
    expect(res.statusCode).toBe(403);
  });

  it.each([['wrong-token'], [''], [TEST_TOKEN + 'x'], [TEST_TOKEN.slice(0, -1)]])(
    'rejects the wrong token %j',
    async (bad) => {
      app = await buildTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: goodHeaders({ 'x-lexi-token': bad }),
      });
      expect(res.statusCode).toBe(403);
    },
  );

  it('does not require a token for non-API paths', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: `127.0.0.1:${TEST_PORT}` },
    });
    // 404 because no static plugin is registered in this build — but NOT 403,
    // which is the point: a document navigation cannot carry the header, and
    // the token lives inside the document it is about to fetch.
    expect(res.statusCode).toBe(404);
  });
});

describe('response hardening headers', () => {
  it('sets nosniff, no-referrer and same-origin CORP', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: goodHeaders() });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('dev mode', () => {
  it('accepts the ng serve origin and host only when devMode is on', async () => {
    app = await buildTestApp({ devMode: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: {
        host: `127.0.0.1:${TEST_PORT}`,
        origin: 'http://localhost:4200',
        'sec-fetch-site': 'cross-site',
        'x-lexi-token': TEST_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still requires the token in dev mode', async () => {
    app = await buildTestApp({ devMode: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: `127.0.0.1:${TEST_PORT}`, origin: 'http://localhost:4200' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects the ng serve origin in production mode', async () => {
    app = await buildTestApp({ devMode: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: goodHeaders({ origin: 'http://localhost:4200' }),
    });
    expect(res.statusCode).toBe(403);
  });
});
