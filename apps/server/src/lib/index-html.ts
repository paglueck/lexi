// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServerConfig } from '../config.js';

/**
 * The placeholder the Angular build ships in index.html.
 *
 * An explicit token rather than a heuristic <head> insertion: the replacement is
 * deterministic and testable, and a missing placeholder becomes a loud boot
 * error instead of a silent storm of 403s an hour into debugging.
 */
export const TOKEN_PLACEHOLDER = '__LEXI_TOKEN__';

export interface IndexHtml {
  readonly html: string;
  /** CSP for this exact document, with the inline theme script pinned by hash. */
  readonly csp: string;
}

let cached: IndexHtml | undefined;

/** Extracts every inline <script> body so the CSP can pin them by hash. */
function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1] ?? '')
    .filter((body) => body.trim() !== '')
    .map((body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

function buildCsp(hashes: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // Angular injects component styles as <style> elements at runtime. Pinning
    // those needs ngCspNonce, which is an M13 job.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Not boilerplate: every LLM call goes through the server, so the SPA has no
    // legitimate reason to reach any other host. This is the browser-side half
    // of NFR-2 / FR-6.15.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    // 'self', NOT 'none': index.html ships <base href="/">, and blocking it
    // makes every relative asset resolve against the current path instead — so
    // a deep route like /dev/kitchen-sink asks for /dev/main-<hash>.js, gets a
    // 404, and renders a blank page. 'self' still refuses an injected <base>
    // pointing anywhere else.
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

export async function indexHtml(cfg: ServerConfig): Promise<IndexHtml> {
  if (cached !== undefined) return cached;

  const raw = await readFile(join(cfg.publicDir, 'index.html'), 'utf8');
  if (!raw.includes(TOKEN_PLACEHOLDER)) {
    throw new Error(
      `${cfg.publicDir}/index.html contains no ${TOKEN_PLACEHOLDER} placeholder — rebuild apps/web.`,
    );
  }

  // Hash the script BEFORE substitution; the token is in a meta tag, not the
  // script, so the hash is stable across restarts either way.
  const csp = buildCsp(inlineScriptHashes(raw));
  cached = { html: raw.replaceAll(TOKEN_PLACEHOLDER, cfg.bootToken), csp };
  return cached;
}

/** Test seam — the cache is process-wide and the token changes per process. */
export function resetIndexHtmlCache(): void {
  cached = undefined;
}
