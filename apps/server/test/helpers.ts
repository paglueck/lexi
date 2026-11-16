// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';

export const TEST_TOKEN = 'test-token-0123456789';
export const TEST_PORT = 4317;

export interface TestConfigOverrides {
  readonly port?: number;
  readonly devMode?: boolean;
  readonly bootToken?: string;
  readonly roots?: readonly string[];
  readonly publicDir?: string;
  readonly heartbeatMs?: number;
  readonly stateDir?: string;
  readonly projectPath?: string;
}

export function testConfig(over: TestConfigOverrides = {}): ServerConfig {
  return {
    host: '127.0.0.1',
    port: over.port ?? TEST_PORT,
    devMode: over.devMode ?? false,
    bootToken: over.bootToken ?? TEST_TOKEN,
    roots: over.roots ?? [],
    publicDir: over.publicDir ?? '/nonexistent-public-dir',
    // Never the real ~/.lexi: a test that writes there pollutes the machine.
    stateDir: over.stateDir ?? '/nonexistent-state-dir',
    projectPath: over.projectPath,
    version: '0.0.0-test',
    heartbeatMs: over.heartbeatMs ?? 50,
    serverId: 'test-server',
  };
}

export function buildTestApp(over: TestConfigOverrides = {}): Promise<FastifyInstance> {
  return buildApp(testConfig(over), { logger: false });
}

/** The header set a same-origin browser request from our own SPA would carry. */
export function goodHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${TEST_PORT}`,
    'sec-fetch-site': 'same-origin',
    'x-lexi-token': TEST_TOKEN,
    ...extra,
  };
}

/**
 * A port that was free a moment ago. Inherently racy, but the SSE tests need a
 * real socket AND the Host allowlist is built from cfg.port, so listening on
 * port 0 and discovering the port afterwards is not an option.
 */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => (port === 0 ? rej(new Error('no port')) : res(port)));
    });
  });
}

export interface SseFrame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

/** Reads SSE frames off a live response until `want` have arrived or time runs out. */
export async function readFrames(
  body: ReadableStream<Uint8Array>,
  want: number,
  timeoutMs = 4000,
): Promise<Array<SseFrame & { at: number }>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: Array<SseFrame & { at: number }> = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (frames.length < want && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const fields = raw.split('\n');
        const data = fields.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        if (data.length > 0) {
          frames.push({
            at: Date.now(),
            id: fields
              .find((l) => l.startsWith('id:'))
              ?.slice(3)
              .trim(),
            event: fields
              .find((l) => l.startsWith('event:'))
              ?.slice(6)
              .trim(),
            data: data.join('\n'),
          });
        }
        sep = buf.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}
