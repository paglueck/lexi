// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Port selection shared by the CLI (bin/lexi.mjs) and the desktop shell
 * (apps/desktop/main.mjs). Nothing here exits the process: each caller decides
 * how a failure is shown, a stderr line for one and a dialog for the other.
 */
import { createServer } from 'node:net';

export const DEFAULT_PORT = 4317;
export const PORT_SCAN_LIMIT = 10;

export function isFree(p) {
  return new Promise((res) => {
    const probe = createServer();
    probe.once('error', () => res(false));
    probe.listen(p, '127.0.0.1', () => probe.close(() => res(true)));
  });
}

/** Is something on this port already a Lexi? */
export async function lexiOn(p) {
  try {
    const ctrl = AbortSignal.timeout(700);
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: ctrl });
    // 403 counts: a running Lexi refuses an unauthenticated call, which is
    // exactly the behaviour that identifies it.
    return res.status === 403 || res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Pick a port at or after `wanted`.
 *
 * Resolves to `{ port }` for a free port, or `{ running: port }` when the wanted
 * port is taken by a Lexi and `attach` is set. Rejects with a user-facing
 * message otherwise.
 *
 * `attach: false` is for callers that cannot use someone else's instance: the
 * desktop shell has no way to learn another process's token, so it always
 * starts its own server.
 */
export async function choosePort(wanted, { explicit = false, attach = true } = {}) {
  if (await isFree(wanted)) return { port: wanted };

  if (explicit) throw new Error(`Port ${wanted} is already in use.`);

  // The difference between a tool people re-run casually and one they fight:
  // if Lexi is already up on the default port, just point them at it.
  if (attach && (await lexiOn(wanted))) return { running: wanted };

  for (let p = wanted + 1; p <= wanted + PORT_SCAN_LIMIT; p++) {
    if (await isFree(p)) return { port: p };
  }
  throw new Error(
    `Ports ${wanted}-${wanted + PORT_SCAN_LIMIT} are all in use. Pass --port explicitly.`,
  );
}
