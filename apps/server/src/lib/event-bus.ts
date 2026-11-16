// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import type { LexiEvent } from '@lexi/shared';

/** Drop a client whose socket has this much unflushed data queued. */
const BACKPRESSURE_LIMIT_BYTES = 1_000_000;

/**
 * Padding sent once per connection.
 *
 * Any intermediary that waits for a buffer to fill before forwarding will hold
 * the first real event indefinitely. 2 KB of comment defeats that for one write
 * per connection, so it is sent unconditionally.
 */
const ANTI_BUFFERING_PADDING = `: ${' '.repeat(2048)}\n\n`;

export interface EventBusOptions {
  readonly heartbeatMs: number;
  readonly serverId: string;
}

/**
 * ONE multiplexed SSE stream for the whole app, not one per job: HTTP/1.1 caps
 * around six connections per origin, and M11 alone would want more than that.
 */
export class EventBus {
  readonly #clients = new Map<number, ServerResponse>();
  #nextId = 1;
  #seq = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: EventBusOptions) {}

  get size(): number {
    return this.#clients.size;
  }

  add(res: ServerResponse): number {
    const id = this.#nextId++;
    this.#clients.set(id, res);

    res.write(`retry: 2000\n\n`);
    res.write(ANTI_BUFFERING_PADDING);
    this.#write(res, { type: 'hello', serverId: this.opts.serverId, at: Date.now() });

    this.#timer ??= setInterval(() => {
      this.publish({ type: 'heartbeat', at: Date.now() });
    }, this.opts.heartbeatMs).unref();

    return id;
  }

  remove(id: number): void {
    this.#clients.delete(id);
    this.#stopTimerIfIdle();
  }

  publish(event: LexiEvent): void {
    for (const [id, res] of this.#clients) {
      if (res.writableEnded || res.destroyed) {
        this.#clients.delete(id);
        continue;
      }
      this.#write(res, event);
      // A suspended tab stops draining. Without a cap, a chatty job broadcast
      // grows the socket buffer until the process dies. Dropping is correct:
      // EventSource reconnects on its own after `retry`.
      if (res.writableLength > BACKPRESSURE_LIMIT_BYTES) {
        res.destroy();
        this.#clients.delete(id);
      }
    }
    this.#stopTimerIfIdle();
  }

  /** Ends every stream. MUST run before `app.close()` — see the preClose hook. */
  closeAll(): void {
    for (const res of this.#clients.values()) {
      if (!res.writableEnded) res.end();
    }
    this.#clients.clear();
    this.#stopTimerIfIdle();
  }

  #write(res: ServerResponse, event: LexiEvent): void {
    // `id:` on every frame from the start. Adding it later would mean the first
    // Last-Event-ID replay implementation has no history to replay.
    res.write(`id: ${++this.#seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  #stopTimerIfIdle(): void {
    if (this.#clients.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
