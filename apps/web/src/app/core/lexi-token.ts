// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The per-process boot token that authorises every /api call.
 *
 * The server replaces the placeholder in index.html on every `GET /`. Under
 * `ng serve` Vite serves index.html verbatim, so the literal placeholder
 * survives — which is exactly how we detect dev and fall back to the fixed
 * token that scripts/dev.mjs gives the server.
 *
 * This fails closed in production: there the token is random, so a stale
 * 'dev-token' would simply be rejected.
 */
const PLACEHOLDER = '__LEXI_TOKEN__';
const DEV_TOKEN = 'dev-token';

export function readLexiToken(doc: Document = document): string {
  const meta = doc.querySelector('meta[name="lexi-token"]')?.getAttribute('content') ?? '';
  return meta === PLACEHOLDER || meta === '' ? DEV_TOKEN : meta;
}

export const LEXI_TOKEN_HEADER = 'X-Lexi-Token';
