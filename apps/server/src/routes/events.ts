// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';

import type { ServerConfig } from '../config.js';
import { EventBus } from '../lib/event-bus.js';

export function registerEvents(app: FastifyInstance, cfg: ServerConfig): EventBus {
  const bus = new EventBus({ heartbeatMs: cfg.heartbeatMs, serverId: cfg.serverId });

  app.get('/api/events', (req, reply) => {
    // Tell Fastify to stop managing this response; its lifecycle hooks would
    // otherwise try to finish a stream that is meant to stay open.
    reply.hijack();
    const res = reply.raw;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // `no-transform` and `x-accel-buffering` are the two that intermediaries
      // actually honour.
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    // Without this, Nagle coalesces a 20-byte heartbeat with whatever comes
    // next — up to 40 ms of invented latency on an otherwise idle stream.
    req.raw.socket?.setNoDelay(true);

    const id = bus.add(res);
    req.raw.on('close', () => bus.remove(id));
  });

  // preClose, not onClose: this must run BEFORE the server stops accepting and
  // starts waiting for in-flight requests to finish. An open SSE stream is by
  // definition never idle, so closing it later means Ctrl-C hangs for the full
  // grace period and appears to do nothing.
  app.addHook('preClose', async () => {
    bus.closeAll();
  });

  return bus;
}
