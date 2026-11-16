// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.js';
import { tokenEquals } from '../lib/token.js';
import { sendError } from './errors.js';

/** `EventSource` cannot set headers, so this one route takes the token in the query. */
export const SSE_PATH = '/api/events';

const DEV_ORIGIN_PORT = 4200;

function deny(reply: FastifyReply, why: string): FastifyReply {
  return sendError(reply, 403, 'forbidden', why);
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * All five checks, in one `onRequest` hook registered before every route.
 *
 * The one most easily forgotten is the Host allowlist, and it is
 * the measure that actually defeats DNS rebinding: when `evil.com` re-resolves
 * to 127.0.0.1 the browser believes it is same-origin, so it sends
 * `Sec-Fetch-Site: same-origin` and — on a GET — no `Origin` header at all.
 * Checks 2 and 3 both pass. `Host: evil.com:4317` does not. It is also the only
 * check that covers index.html itself, which is where the token is handed out.
 */
export function registerSecurity(app: FastifyInstance, cfg: ServerConfig): void {
  const hosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);
  const origins = new Set([
    `http://127.0.0.1:${cfg.port}`,
    `http://localhost:${cfg.port}`,
    `http://[::1]:${cfg.port}`,
  ]);
  if (cfg.devMode) {
    hosts.add(`localhost:${DEV_ORIGIN_PORT}`).add(`127.0.0.1:${DEV_ORIGIN_PORT}`);
    origins.add(`http://localhost:${DEV_ORIGIN_PORT}`).add(`http://127.0.0.1:${DEV_ORIGIN_PORT}`);
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');

    // (0) Host — every request, index.html included.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return deny(reply, 'bad host');

    const path = pathOf(req.url);
    // Static assets and the SPA fallback stop here: a document navigation cannot
    // carry X-Lexi-Token, and the token lives inside the document it fetches.
    if (path !== '/api' && !path.startsWith('/api/')) return undefined;

    // Preflights are only possible at all in dev (ng serve on another port).
    if (cfg.devMode && req.method === 'OPTIONS') return undefined;

    // (2) Sec-Fetch-Site. Absent means a non-browser client, which (4) covers.
    const sfs = req.headers['sec-fetch-site'];
    if (typeof sfs === 'string' && sfs !== 'same-origin' && !cfg.devMode) {
      return deny(reply, 'cross-site request');
    }

    // (3) Origin, when present, must be ours.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !origins.has(origin.toLowerCase())) {
      return deny(reply, 'bad origin');
    }

    // (4) The boot token.
    const supplied =
      path === SSE_PATH
        ? new URL(req.url, 'http://lexi.invalid').searchParams.get('token')
        : req.headers['x-lexi-token'];
    if (!tokenEquals(cfg.bootToken, supplied)) return deny(reply, 'bad or missing token');

    return undefined;
  });
}
