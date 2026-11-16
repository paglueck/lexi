// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Updater } from './lib/updater.js';

/** Options a caller (bin/lexi.mjs, a test, src/dev.ts) may supply. */
export interface ServerOptions {
  readonly port?: number | undefined;
  /** Injected rather than read from package.json, so it works identically under
   *  the esbuild bundle, under tsx and under vitest with no bundler cooperation. */
  readonly version?: string | undefined;
  /** `lexi [path]` — granted as an fs root in addition to the home directory. */
  readonly projectPath?: string | undefined;
  readonly publicDir?: string | undefined;
  /** Where `recents.json` lives. Overridden in tests so they never touch ~/.lexi. */
  readonly stateDir?: string | undefined;
  /** The desktop shell's updater. Absent everywhere else, which hides updates in the UI. */
  readonly updater?: Updater | undefined;
}

export interface ServerConfig {
  /** Never `0.0.0.0`, never the platform default. Asserted in the tests. */
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Only ever true when LEXI_DEV=1. Relaxes the origin checks; never in production. */
  readonly devMode: boolean;
  /** Random per process unless LEXI_DEV supplies a fixed one. Defeats DNS rebinding. */
  readonly bootToken: string;
  /** Absolute, realpath'd, deduped. The fs jail's only grant. */
  readonly roots: readonly string[];
  readonly publicDir: string;
  /**
   * Lexi's own state directory, `~/.lexi` — the home of `recents.json`, and the
   * one thing we write outside the project being edited. A field rather than a
   * call to `homedir()` at the point of use, so tests get a temp directory
   * instead of scribbling in the developer's real home.
   */
  readonly stateDir: string;
  /** `lexi [path]` as given, so S1 can offer it. Not the same as opening it. */
  readonly projectPath: string | undefined;
  readonly version: string;
  readonly heartbeatMs: number;
  /** Identifies this process on the SSE stream, so a client can tell a restart from a reconnect. */
  readonly serverId: string;
}

export const DEFAULT_PORT = 4317;
const DEFAULT_HEARTBEAT_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Realpath every root once, at boot.
 *
 * Two reasons, and skipping either breaks the jail: on macOS `/tmp` is really
 * `/private/tmp`, so an un-realpath'd root rejects legitimate paths; and a root
 * that is itself reached through a symlink would never contain the realpath'd
 * targets it is checked against.
 */
async function resolveRoots(projectPath: string | undefined): Promise<readonly string[]> {
  const candidates = [homedir(), ...(projectPath === undefined ? [] : [projectPath])];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const real = await realpath(resolve(candidate));
      if (!out.includes(real)) out.push(real);
    } catch {
      // A root that does not exist simply grants nothing.
    }
  }
  return out;
}

export async function resolveConfig(options: ServerOptions = {}): Promise<ServerConfig> {
  const devMode = process.env['LEXI_DEV'] === '1';
  return {
    host: '127.0.0.1',
    port: options.port ?? envInt('LEXI_PORT', DEFAULT_PORT),
    devMode,
    // Production never sets LEXI_TOKEN; scripts/dev.mjs always does, because
    // under `ng serve` Vite serves index.html and no injection happens.
    bootToken: process.env['LEXI_TOKEN'] ?? randomBytes(32).toString('base64url'),
    roots: await resolveRoots(options.projectPath),
    publicDir: options.publicDir ?? fileURLToPath(new URL('../public', import.meta.url)),
    stateDir: options.stateDir ?? join(homedir(), '.lexi'),
    projectPath: options.projectPath,
    version: options.version ?? '0.0.0-dev',
    heartbeatMs: envInt('LEXI_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS),
    serverId: randomBytes(8).toString('hex'),
  };
}
