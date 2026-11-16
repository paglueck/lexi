// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { assertFullIcu } from '@lexi/xliff';

import { buildApp } from './app.js';
import { resolveConfig, type ServerOptions } from './config.js';

export { DEFAULT_PORT, type ServerConfig, type ServerOptions } from './config.js';
export type { Updater } from './lib/updater.js';

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Boot order matters.
 *
 * `assertFullIcu()` runs first and hard-exits: a Node built without full ICU
 * computes the wrong CLDR plural categories, which would surface in M9 as
 * silently wrong translations rather than as an error. Failing at boot is the
 * cheap version of that bug.
 */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  try {
    assertFullIcu();
  } catch {
    process.stderr.write(
      'This build of Node was compiled without full ICU, so plural rules for\n' +
        'non-English locales would be wrong. Install a full-icu Node build, or\n' +
        'run with --icu-data-dir pointing at ICU data.\n',
    );
    process.exit(1);
  }

  const cfg = await resolveConfig(options);

  if (cfg.devMode) {
    process.stderr.write(
      'LEXI_DEV=1 — relaxed origin checks are active. Never run this way outside development.\n',
    );
  }

  // Awaited before `listen`, so the SPA's first probe already sees the project
  // and lands on the dashboard rather than flashing the start screen.
  const app = await buildApp(cfg, { restoreLastProject: true, updater: options.updater });
  await app.listen({ host: cfg.host, port: cfg.port });

  const url = `http://${cfg.host}:${cfg.port}/`;
  return {
    url,
    port: cfg.port,
    close: async () => {
      await app.close();
    },
  };
}
