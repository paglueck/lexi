#!/usr/bin/env node
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `npm run dev` — the Fastify server and `ng serve`, together.
 *
 * Not `concurrently`, for one reason a dependency would not give us: it polls
 * /api/health and only starts ng serve once the server answers, so the first
 * proxied request can never race the boot. It is also the single place the dev
 * token and LEXI_DEV are set, which keeps that pairing from drifting.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PORT = Number(process.env.LEXI_PORT ?? 4317);
const TOKEN = 'dev-token';
const READY_TIMEOUT_MS = 30_000;

const COLOR = {
  server: '\u001b[36m',
  web: '\u001b[35m',
  dim: '\u001b[2m',
  off: '\u001b[0m',
};
const useColor = process.stdout.isTTY;
const tint = (c, s) => (useColor ? `${c}${s}${COLOR.off}` : s);

const children = [];
let shuttingDown = false;

function run(name, args, env) {
  const child = spawn('npm', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  children.push(child);

  const label = tint(COLOR[name], name.padEnd(6));
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      process.stdout.write(`${label} ${tint(COLOR.dim, '|')} ${line}\n`);
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${label} ${tint(COLOR.dim, '|')} exited (${signal ?? code})\n`);
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(code), 400).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(0));

async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
        headers: { 'X-Lexi-Token': TOKEN },
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// LEXI_DEV relaxes the origin checks for localhost:4200 and fixes the token, so
// the SPA served by Vite (which never sees the server's injection) can still
// authenticate. Both are set here and nowhere else.
run('server', ['-w', '@lexi/server', 'run', 'dev'], {
  LEXI_DEV: '1',
  LEXI_TOKEN: TOKEN,
  LEXI_PORT: String(PORT),
});

if (await waitForServer()) {
  process.stdout.write(
    `${tint(COLOR.server, 'server')} ${tint(COLOR.dim, '|')} ready on :${PORT}\n`,
  );
  run('web', ['-w', '@lexi/web', 'run', 'start'], {});
} else {
  process.stderr.write(`server did not become ready within ${READY_TIMEOUT_MS} ms\n`);
  shutdown(1);
}
