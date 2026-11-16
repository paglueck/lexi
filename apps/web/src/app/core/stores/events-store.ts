// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  JOB_LOCALE_STATUSES,
  JOB_LOG_OUTCOMES,
  JOB_STATUSES,
  PHRASE_CHECKOUT_STEPS,
  PHRASE_CHECKOUT_STEP_STATES,
  type PhraseCheckoutStep,
} from '@lexi/shared/constants';
import type { LexiEvent, RunLogEntry, SharedSourceKind, UpdateState } from '@lexi/shared';

import { readLexiToken } from '../lexi-token.js';
import { ProjectApi } from '../api/project-api.js';
import { ProjectStore } from './project-store.js';
import { SaveStore } from './save-store.js';

/**
 * The app's ONE connection to `GET /api/events`.
 *
 * One for the whole app rather than one per screen, matching the server's
 * multiplexed bus: HTTP/1.1 allows about six connections per origin, and a
 * per-component EventSource would spend them on nothing.
 *
 * Frames are NARROWED BY HAND rather than with `LexiEventSchema`. Importing the
 * schema would pull zod into the browser bundle, which docs/architecture.md keeps out of it —
 * the client takes its runtime values from `@lexi/shared/constants` and its
 * shapes as types only. The checks below are the parts this store actually
 * reads, and nothing more: a frame that does not match is dropped, because it
 * comes from a server version that is not this one and guessing at it would be
 * worse than ignoring it.
 */
@Injectable({ providedIn: 'root' })
export class EventsStore {
  readonly #project = inject(ProjectStore);
  readonly #save = inject(SaveStore);
  readonly #api = inject(ProjectApi);

  readonly #state = signal<'idle' | 'connecting' | 'open' | 'error'>('idle');
  /**
   * Absolute paths the server has reported as changed on disk and that have not
   * been reloaded yet. A set, because `git pull` followed by `git stash pop`
   * reports the same file twice and the banner counts files, not events.
   */
  readonly #changed = signal<readonly string[]>([]);
  readonly #reloading = signal(false);
  /** The server process id from `hello`. A new one means it restarted. */
  readonly #serverId = signal<string | null>(null);
  /**
   * Bumped after every successful reload.
   *
   * The signal the grid watches, rather than a call from here into `UnitsStore`:
   * a reload has to invalidate an id list that is only meaningful to the grid,
   * and this store must not have to know that the grid exists. It is a fact
   * being published, not a command.
   */
  readonly #reloadedAt = signal(0);
  /**
   * Job frames not yet drained by `JobsStore` (`drainJobFrames`).
   *
   * A QUEUE, not a single slot — the first version held only the latest
   * frame, on the reasoning that "a fact being published" needs nowhere to
   * accumulate. That reasoning misses how Angular effects actually run:
   * `job-log` and `job-progress` are published back to back on the server
   * (`job-queue.ts`'s worker loop has no `await` between them), so they
   * routinely arrive in the SAME task on the client. Two synchronous
   * `signal.set()` calls before an effect's next flush do not run the effect
   * twice — Angular coalesces them, and the effect sees only the LAST value.
   * A single-slot signal therefore silently drops whichever frame lost the
   * race, which is exactly the reported bug: the job card's progress numbers
   * stopped updating while the run log (fed by the surviving frame type)
   * kept working. Queueing every frame and draining the whole queue in one
   * effect run keeps every frame, at the cost of one level of indirection.
   */
  readonly #jobFrames = signal<readonly JobFrame[]>([]);
  /**
   * When a linked style guide folder or Term Base last changed on disk
   * (`shared-source-changed`), per source. A timestamp the pages watch, for
   * the reason `reloadedAt` is one: this store publishes the fact and each
   * page decides what reloading means for it — the style guide editor must
   * not throw away an unsaved buffer.
   */
  readonly #sharedChangedAt = signal<Readonly<Record<SharedSourceKind, number>>>({
    styleguides: 0,
    termbase: 0,
  });

  readonly state = this.#state.asReadonly();
  readonly changedPaths = this.#changed.asReadonly();
  readonly reloading = this.#reloading.asReadonly();
  readonly serverId = this.#serverId.asReadonly();
  readonly reloadedAt = this.#reloadedAt.asReadonly();
  /** Non-empty whenever there is something for `drainJobFrames` to take. */
  readonly jobFrames = this.#jobFrames.asReadonly();
  readonly sharedChangedAt = this.#sharedChangedAt.asReadonly();

  /**
   * Where each file of a running Phrase push is, by its position in the push.
   * A map rather than a single slot for the reason `#jobFrames` is a queue:
   * two frames in one task must not cost the first one.
   */
  readonly #phrasePush = signal<ReadonlyMap<number, PhrasePushFrame>>(new Map());
  readonly phrasePush = this.#phrasePush.asReadonly();

  /**
   * The desktop updater's latest state, for `UpdateStore` to pick up.
   *
   * A single slot, unlike the job queue: each state replaces the one before,
   * so two in one task only ever need the second. Published rather than handed
   * to the store directly so the store — and everything update-related — can
   * stay out of the initial bundle. `unknown` because it is not narrowed here:
   * `parseUpdateState` in the store does that.
   */
  readonly #updateFrame = signal<unknown>(null);
  readonly updateFrame = this.#updateFrame.asReadonly();

  /** Called as a push starts, so a previous push's stages are not shown. */
  clearPhrasePush(): void {
    this.#phrasePush.set(new Map());
  }

  /**
   * The latest frame of each of a Phrase checkout's six log rows (S18), keyed
   * by step — a map for the same reason as `phrasePush`.
   */
  readonly #phraseCheckout = signal<ReadonlyMap<PhraseCheckoutStep, PhraseCheckoutFrame>>(
    new Map(),
  );
  readonly phraseCheckout = this.#phraseCheckout.asReadonly();

  /** Called as a checkout starts, so a previous run's rows are not shown. */
  clearPhraseCheckout(): void {
    this.#phraseCheckout.set(new Map());
  }
  readonly hasChanges = computed(() => this.#changed().length > 0);

  /** The banner's text: paths relative to the project root, which is what a human reads. */
  readonly changedRelative = computed<readonly string[]>(() => {
    const root = this.#project.project()?.path;
    return this.#changed().map((p) =>
      root !== undefined && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p,
    );
  });

  #source: EventSource | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
  }

  /**
   * Idempotent, because the shell calls it at boot and a reconnect after a
   * server restart must not stack a second stream on the first.
   */
  connect(): void {
    if (this.#source !== undefined) return;
    // EventSource cannot set headers, which is why this one endpoint takes the
    // boot token as a query parameter.
    const source = new EventSource(`/api/events?token=${encodeURIComponent(readLexiToken())}`);
    this.#source = source;
    this.#state.set('connecting');

    source.addEventListener('open', () => this.#state.set('open'));
    // Not fatal: EventSource reconnects on its own after the server's `retry`.
    source.addEventListener('error', () => this.#state.set('error'));

    for (const type of [
      'hello',
      'file-changed',
      'save-complete',
      'job-progress',
      'job-state',
      'job-locale-state',
      'job-removed',
      'job-log',
      'phrase-push-progress',
      'phrase-checkout-progress',
      'shared-source-changed',
      'update',
    ] as const) {
      source.addEventListener(type, (ev) => this.#handle((ev as MessageEvent<string>).data));
    }
  }

  disconnect(): void {
    this.#source?.close();
    this.#source = undefined;
    this.#state.set('idle');
  }

  /**
   * Take the changes (FR-1.5).
   *
   * The project is refetched afterwards rather than patched, because a reload
   * rebuilds the row model server-side and every figure on the dashboard is
   * derived from it. `dropped` is returned to the caller so the banner can say
   * what it cost — this method deliberately does not decide that itself.
   */
  /**
   * Re-read files from disk, and put everything that derives from them back.
   *
   * `paths` defaults to the ones the watcher saw change, which is the banner's
   * case. The project menu passes every file in the project instead — "reload"
   * asked for deliberately means "I changed something you were not watching",
   * and the watcher is a convenience that may not be running at all
   * (`file-watcher.ts` degrades to no watcher rather than to a broken server).
   * Both go through this one body so the banner and the menu cannot drift
   * about what reloading leaves behind.
   */
  async reload(
    paths: readonly string[] = this.#changed(),
  ): Promise<{ reloaded: number; dropped: number; failed: number }> {
    if (paths.length === 0) return { reloaded: 0, dropped: 0, failed: 0 };

    this.#reloading.set(true);
    try {
      const res = await this.#api.reloadFiles(paths);
      // Only the paths that actually came back are cleared: one that failed is
      // still out of date, and the banner should keep saying so.
      const done = new Set(res.reloaded);
      this.#changed.update((list) => list.filter((p) => !done.has(p)));
      this.#save.setUnsaved(res.unsavedCount);
      await this.#project.refresh();
      if (res.reloaded.length > 0) this.#reloadedAt.set(Date.now());
      return { reloaded: res.reloaded.length, dropped: res.dropped, failed: res.failed.length };
    } finally {
      this.#reloading.set(false);
    }
  }

  /** Forget the changes without reloading — the banner's dismiss. */
  dismiss(): void {
    this.#changed.set([]);
  }

  /**
   * Take every queued job frame, in arrival order, and empty the queue.
   *
   * An atomic read-then-clear rather than two separate signal accesses: a
   * frame that arrived between the read and the clear would otherwise be
   * silently discarded by the clear.
   */
  drainJobFrames(): readonly JobFrame[] {
    const frames = this.#jobFrames();
    if (frames.length > 0) this.#jobFrames.set([]);
    return frames;
  }

  #handle(raw: string): void {
    const event = parseEvent(raw);
    if (event === null) return;

    switch (event.type) {
      case 'hello':
        this.#serverId.set(event.serverId);
        break;

      case 'file-changed':
        this.#changed.update((list) => [...new Set([...list, ...event.paths])].sort());
        break;

      case 'save-complete':
        // The title bar's indicator and the dashboard's footer, from the same
        // event — so a save started in another tab moves both here too.
        this.#save.markSaved(event.at);
        this.#save.setWritten(event.written.length);
        void this.#project.refresh();
        break;

      case 'job-progress':
      case 'job-state':
      case 'job-locale-state':
      case 'job-removed':
      case 'job-log':
        this.#jobFrames.update((list) => [...list, event]);
        break;

      case 'phrase-push-progress':
        this.#phrasePush.update((map) => new Map(map).set(event.index, event));
        break;

      case 'phrase-checkout-progress':
        this.#phraseCheckout.update((map) => new Map(map).set(event.step, event));
        break;

      case 'shared-source-changed':
        this.#sharedChangedAt.update((at) => ({ ...at, [event.source]: Date.now() }));
        break;

      case 'update':
        this.#updateFrame.set(event.state);
        break;

      default:
        break;
    }
  }
}

export type PhrasePushFrame = Extract<LexiEvent, { type: 'phrase-push-progress' }>;
export type PhraseCheckoutFrame = Extract<LexiEvent, { type: 'phrase-checkout-progress' }>;
const PHRASE_STAGES = ['uploading', 'processing', 'done', 'failed'] as const;

/** The M11 job frames, narrowed out of `LexiEvent` rather than duplicated. */
export type JobFrame = Extract<
  LexiEvent,
  { type: 'job-progress' | 'job-state' | 'job-locale-state' | 'job-removed' | 'job-log' }
>;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/**
 * One SSE frame, or null.
 *
 * Exported for the spec: this is the only place in the client where data
 * crosses a boundary without a schema behind it, so the malformed cases are
 * worth asserting rather than assuming.
 */
export function parseEvent(raw: string): LexiEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;

  switch (frame['type']) {
    case 'hello':
      return typeof frame['serverId'] === 'string' && typeof frame['at'] === 'number'
        ? { type: 'hello', serverId: frame['serverId'], at: frame['at'] }
        : null;

    case 'file-changed':
      return isStringArray(frame['paths']) ? { type: 'file-changed', paths: frame['paths'] } : null;

    case 'save-complete':
      return isStringArray(frame['written']) && typeof frame['at'] === 'string'
        ? { type: 'save-complete', written: frame['written'], at: frame['at'] }
        : null;

    case 'job-progress':
      return typeof frame['jobId'] === 'string' &&
        typeof frame['locale'] === 'string' &&
        (typeof frame['jobAvgMsPerUnit'] === 'number' || frame['jobAvgMsPerUnit'] === null) &&
        typeof frame['currentIndex'] === 'number' &&
        (typeof frame['currentRowId'] === 'string' || frame['currentRowId'] === null) &&
        typeof frame['accepted'] === 'number' &&
        typeof frame['rejected'] === 'number' &&
        typeof frame['skipped'] === 'number' &&
        typeof frame['failed'] === 'number' &&
        (typeof frame['avgMsPerUnit'] === 'number' || frame['avgMsPerUnit'] === null)
        ? {
            type: 'job-progress',
            jobId: frame['jobId'],
            locale: frame['locale'],
            jobAvgMsPerUnit: frame['jobAvgMsPerUnit'],
            currentIndex: frame['currentIndex'],
            currentRowId: frame['currentRowId'],
            accepted: frame['accepted'],
            rejected: frame['rejected'],
            skipped: frame['skipped'],
            failed: frame['failed'],
            avgMsPerUnit: frame['avgMsPerUnit'],
          }
        : null;

    case 'job-state':
      return typeof frame['jobId'] === 'string' &&
        typeof frame['status'] === 'string' &&
        (JOB_STATUSES as readonly string[]).includes(frame['status']) &&
        isNullableString(frame['startedAt']) &&
        isNullableString(frame['finishedAt'])
        ? {
            type: 'job-state',
            jobId: frame['jobId'],
            status: frame['status'] as (typeof JOB_STATUSES)[number],
            startedAt: frame['startedAt'] as string | null,
            finishedAt: frame['finishedAt'] as string | null,
          }
        : null;

    case 'job-locale-state':
      return typeof frame['jobId'] === 'string' &&
        typeof frame['locale'] === 'string' &&
        typeof frame['status'] === 'string' &&
        (JOB_LOCALE_STATUSES as readonly string[]).includes(frame['status']) &&
        isNullableString(frame['startedAt']) &&
        isNullableString(frame['finishedAt'])
        ? {
            type: 'job-locale-state',
            jobId: frame['jobId'],
            locale: frame['locale'],
            status: frame['status'] as (typeof JOB_LOCALE_STATUSES)[number],
            startedAt: frame['startedAt'] as string | null,
            finishedAt: frame['finishedAt'] as string | null,
          }
        : null;

    case 'job-removed':
      return typeof frame['jobId'] === 'string'
        ? { type: 'job-removed', jobId: frame['jobId'] }
        : null;

    case 'job-log': {
      const entry = frame['entry'];
      // The entry's own fields (`run`, `rejection`, `findings`) are trusted as
      // written by this same server version rather than re-validated leaf by
      // leaf — the check here is enough to route the frame safely, which is
      // all this store does with it.
      if (typeof frame['jobId'] !== 'string' || typeof entry !== 'object' || entry === null)
        return null;
      const rec = entry as Record<string, unknown>;
      if (
        typeof rec['seq'] !== 'number' ||
        typeof rec['rowId'] !== 'string' ||
        typeof rec['outcome'] !== 'string' ||
        !(JOB_LOG_OUTCOMES as readonly string[]).includes(rec['outcome'])
      ) {
        return null;
      }
      return { type: 'job-log', jobId: frame['jobId'], entry: entry as RunLogEntry };
    }

    case 'phrase-push-progress':
      return typeof frame['index'] === 'number' &&
        typeof frame['total'] === 'number' &&
        typeof frame['relPath'] === 'string' &&
        typeof frame['localeId'] === 'string' &&
        typeof frame['stage'] === 'string' &&
        (PHRASE_STAGES as readonly string[]).includes(frame['stage'])
        ? {
            type: 'phrase-push-progress',
            index: frame['index'],
            total: frame['total'],
            relPath: frame['relPath'],
            localeId: frame['localeId'],
            stage: frame['stage'] as PhrasePushFrame['stage'],
          }
        : null;

    case 'phrase-checkout-progress':
      return typeof frame['step'] === 'string' &&
        (PHRASE_CHECKOUT_STEPS as readonly string[]).includes(frame['step']) &&
        typeof frame['state'] === 'string' &&
        (PHRASE_CHECKOUT_STEP_STATES as readonly string[]).includes(frame['state']) &&
        typeof frame['detail'] === 'string'
        ? {
            type: 'phrase-checkout-progress',
            step: frame['step'] as PhraseCheckoutFrame['step'],
            state: frame['state'] as PhraseCheckoutFrame['state'],
            detail: frame['detail'],
          }
        : null;

    case 'shared-source-changed':
      return frame['source'] === 'styleguides' || frame['source'] === 'termbase'
        ? { type: 'shared-source-changed', source: frame['source'] }
        : null;

    case 'update': {
      // Routed on its shape alone; `UpdateStore` narrows the state itself, so
      // the check lives in the lazy chunk rather than in the initial bundle.
      const state = frame['state'];
      return typeof state === 'object' && state !== null
        ? { type: 'update', state: state as UpdateState }
        : null;
    }

    default:
      return null;
  }
}
