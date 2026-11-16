// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { UpdateState, UpdateStatus } from '@lexi/shared';

import { UpdateApi } from '../api/update-api.js';
import { EventsStore } from './events-store.js';

/**
 * The desktop updater's state, for the start-up dialog and Settings → Updates.
 *
 * Fed from two directions: the HTTP answers to this store's own calls, and the
 * `update` events `EventsStore` publishes as `updateFrame` — a download's
 * progress and its end only ever arrive the second way.
 *
 * Only ever loaded lazily (the start-up check and Settings both import it on
 * demand), which keeps the CLI's initial bundle free of it.
 *
 * Skipping an update is not remembered anywhere. It closes the dialog for this
 * run, and the next start asks again.
 */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  readonly #api = inject(UpdateApi);
  readonly #events = inject(EventsStore);

  readonly #status = signal<UpdateStatus | null>(null);
  readonly status = this.#status.asReadonly();
  /** False until loaded, and in the CLI or browser for good. */
  readonly supported = computed(() => this.#status()?.supported ?? false);
  readonly state = computed<UpdateState>(() => this.#status()?.state ?? { phase: 'idle' });
  readonly mode = computed(() => this.#status()?.mode ?? 'auto');
  readonly currentVersion = computed(() => this.#status()?.currentVersion ?? '');

  constructor() {
    effect(() => {
      const state = parseUpdateState(this.#events.updateFrame());
      if (state !== null) untracked(() => this.apply(state));
    });
  }

  /** Never throws: a server that cannot answer simply has no updater to offer. */
  async load(): Promise<UpdateStatus | null> {
    try {
      this.#status.set(await this.#api.status());
    } catch {
      this.#status.set(null);
    }
    return this.#status();
  }

  async check(): Promise<UpdateState> {
    this.apply({ phase: 'checking' });
    try {
      this.#status.set(await this.#api.check());
    } catch {
      this.apply({ phase: 'error', message: 'Lexi could not ask for updates.' });
    }
    return this.state();
  }

  async download(): Promise<void> {
    try {
      const status = await this.#api.download();
      // Progress frames can overtake this answer; only an unchanged state
      // takes it, so the bar never jumps back to 0 %.
      if (this.state().phase === 'available') this.#status.set(status);
    } catch {
      this.apply({ phase: 'error', message: 'The download could not be started.' });
    }
  }

  async install(): Promise<void> {
    try {
      await this.#api.install();
    } catch {
      this.apply({ phase: 'error', message: 'The update could not be installed.' });
    }
  }

  /** A state from an `update` event, or one this store sets itself. */
  apply(state: UpdateState): void {
    this.#status.update((status) => (status === null ? status : { ...status, state }));
  }
}

/**
 * An `update` frame's state, narrowed by hand like every frame in
 * `EventsStore` (no zod in the browser). Null when it does not match.
 */
export function parseUpdateState(value: unknown): UpdateState | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  const version = s['version'];
  const notes = s['releaseNotes'];
  switch (s['phase']) {
    case 'idle':
    case 'checking':
    case 'none':
      return { phase: s['phase'] };
    case 'available':
    case 'ready':
      return typeof version === 'string' && (notes === null || typeof notes === 'string')
        ? { phase: s['phase'], version, releaseNotes: notes }
        : null;
    case 'downloading':
      return typeof version === 'string' && typeof s['percent'] === 'number'
        ? { phase: 'downloading', version, percent: s['percent'] }
        : null;
    case 'error':
      return typeof s['message'] === 'string' ? { phase: 'error', message: s['message'] } : null;
    default:
      return null;
  }
}
