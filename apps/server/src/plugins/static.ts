// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.js';
import { indexHtml } from '../lib/index-html.js';
import { sendError } from './errors.js';

/**
 * Serves the built SPA and injects the boot token into index.html.
 *
 * Also owns the 404 handler, because the SPA fallback and the JSON error
 * envelope are the same decision and Fastify allows only one such handler.
 */
export async function registerStatic(app: FastifyInstance, cfg: ServerConfig): Promise<void> {
  const present = existsSync(`${cfg.publicDir}/index.html`);

  if (present) {
    await app.register(fastifyStatic, {
      root: cfg.publicDir,
      // Critical. With the default, @fastify/static answers GET / with the raw
      // file off disk and the injector never runs — so the SPA boots with the
      // literal placeholder and every API call 403s.
      index: false,
      wildcard: false,
      cacheControl: true,
      maxAge: '1y',
      immutable: true,
    });

    app.get('/', serveIndex);
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === 'GET' && present && !isApi(req.url) && acceptsHtml(req)) {
      return serveIndex(req, reply);
    }
    return sendError(reply, 404, 'not_found', `No route for ${req.method} ${req.url}`);
  });

  async function serveIndex(_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const { html, csp } = await indexHtml(cfg);
    return (
      reply
        .type('text/html; charset=utf-8')
        // The token changes every process, so this document must never be cached.
        .header('cache-control', 'no-store')
        .header('content-security-policy', csp)
        .send(html)
    );
  }
}

const isApi = (url: string): boolean => url === '/api' || url.startsWith('/api/');

function acceptsHtml(req: FastifyRequest): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}
