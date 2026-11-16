// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Static serving and boot-token injection.
 *
 * The failure this guards against is specific and expensive: with
 * @fastify/static's default `index` option, GET / is answered off disk, the
 * injector never runs, and the SPA boots holding the literal placeholder — so
 * every API call 403s and nothing says why.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { resetIndexHtmlCache, TOKEN_PLACEHOLDER } from '../src/lib/index-html.js';
import { goodHeaders, testConfig, TEST_PORT, TEST_TOKEN } from './helpers.js';

const INDEX = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta name="lexi-token" content="${TOKEN_PLACEHOLDER}">
<script>document.documentElement.setAttribute('data-theme','dark');</script>
</head>
<body><lx-root></lx-root></body>
</html>
`;

let dir: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  resetIndexHtmlCache();
  dir = await realpath(await mkdtemp(join(tmpdir(), 'lexi-public-')));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function withIndex(html = INDEX): Promise<FastifyInstance> {
  await writeFile(join(dir, 'index.html'), html);
  await mkdir(join(dir, 'fonts'), { recursive: true });
  await writeFile(join(dir, 'fonts', 'x.woff2'), 'not-really-a-font');
  return buildApp(testConfig({ publicDir: dir }), { logger: false });
}

const hostOnly = { host: `127.0.0.1:${TEST_PORT}`, accept: 'text/html' };

describe('GET /', () => {
  it('substitutes the boot token and leaves no placeholder behind', async () => {
    app = await withIndex();
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`content="${TEST_TOKEN}"`);
    expect(res.body).not.toContain(TOKEN_PLACEHOLDER);
  });

  it('is served without a token header — the token lives inside the document', async () => {
    app = await withIndex();
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });
    expect(res.statusCode).toBe(200);
  });

  it('is never cached, because the token changes every process', async () => {
    app = await withIndex();
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('pins the inline theme script by hash and forbids outbound connections', async () => {
    app = await withIndex();
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });
    const csp = String(res.headers['content-security-policy']);

    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    // The browser-side half of NFR-2 / FR-6.15.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("allows <base href> — base-uri 'none' would blank every deep route", async () => {
    app = await withIndex();
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });
    const csp = String(res.headers['content-security-policy']);

    // Angular ships <base href="/">. Blocking it makes relative assets resolve
    // against the current path, so /dev/kitchen-sink requests /dev/main-*.js.
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain("base-uri 'none'");
  });

  it('fails loudly when the build shipped no placeholder', async () => {
    app = await withIndex('<!doctype html><html><head></head><body></body></html>');
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'internal' } });
  });
});

describe('the SPA fallback', () => {
  it('serves index.html for a client-side route', async () => {
    app = await withIndex();
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: hostOnly });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('lx-root');
  });

  it('does NOT swallow unknown /api routes', async () => {
    app = await withIndex();
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: goodHeaders({ accept: 'text/html' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('does not answer a non-HTML request with HTML', async () => {
    app = await withIndex();
    const res = await app.inject({
      method: 'GET',
      url: '/missing.woff2',
      headers: { host: `127.0.0.1:${TEST_PORT}`, accept: 'font/woff2' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('serves a real asset', async () => {
    app = await withIndex();
    const res = await app.inject({
      method: 'GET',
      url: '/fonts/x.woff2',
      headers: { host: `127.0.0.1:${TEST_PORT}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('with no build present', () => {
  it('404s rather than crashing at boot', async () => {
    app = await buildApp(testConfig({ publicDir: join(dir, 'nope') }), { logger: false });
    const res = await app.inject({ method: 'GET', url: '/', headers: hostOnly });
    expect(res.statusCode).toBe(404);
  });
});
