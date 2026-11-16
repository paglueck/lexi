// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Development entry point — `tsx watch src/dev.ts`.
 *
 * Kept separate from main.ts so main.ts stays a pure module: bin/lexi.mjs
 * imports `startServer` from the esbuild bundle and must not trigger a listen
 * as an import side effect.
 */
import { startServer } from './main.js';

const server = await startServer();
process.stdout.write(`Lexi server listening on ${server.url}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
