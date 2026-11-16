// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import type { UpdateStatus } from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { EventBus } from '../lib/event-bus.js';
import { conflict, notFound } from '../lib/http-error.js';
import type { Updater } from '../lib/updater.js';

/**
 * `/api/update` — the desktop updater, forwarded.
 *
 * Without an updater (the CLI, the browser, the tests) `GET` still answers,
 * with `supported: false`, so the client can ask unconditionally and simply
 * show nothing; the three actions are 404s.
 *
 * `check` waits for its answer, because the start-up dialog has nothing to
 * show until it has one. `download` and `install` do not: a download takes as
 * long as it takes, and its progress travels over SSE as `update` events.
 */
export function registerUpdate(
  app: FastifyInstance,
  cfg: ServerConfig,
  bus: EventBus,
  updater: Updater | undefined,
): void {
  const status = (): UpdateStatus => ({
    supported: updater !== undefined,
    currentVersion: cfg.version,
    mode: updater?.mode ?? 'auto',
    state: updater?.state() ?? { phase: 'idle' },
  });

  app.get('/api/update', async (): Promise<UpdateStatus> => status());

  if (updater === undefined) {
    app.post('/api/update/:action', async () => {
      throw notFound('updates are only available in the desktop app');
    });
    return;
  }

  const unsubscribe = updater.onChange((state) => bus.publish({ type: 'update', state }));
  app.addHook('onClose', async () => unsubscribe());

  app.post('/api/update/check', async (): Promise<UpdateStatus> => {
    const phase = updater.state().phase;
    // A second check while one runs, or while a download is under way, would
    // only reset what the first one found.
    if (phase === 'downloading' || phase === 'ready') return status();
    await updater.check();
    return status();
  });

  app.post('/api/update/download', async (_req, reply): Promise<UpdateStatus> => {
    const phase = updater.state().phase;
    if (phase === 'downloading' || phase === 'ready') return status();
    if (phase !== 'available') throw conflict('there is no update to download');
    // Not awaited: progress and the end of it arrive over SSE.
    void updater.download();
    reply.code(202);
    return status();
  });

  app.post('/api/update/install', async (_req, reply): Promise<UpdateStatus> => {
    if (updater.state().phase !== 'ready') throw conflict('the update has not been downloaded yet');
    // After the reply, so the client hears that the install began before the
    // process it is talking to goes away.
    reply.raw.once('finish', () => updater.install());
    reply.code(202);
    return status();
  });
}
