// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { EventBus } from '../lib/event-bus.js';
import type { ProjectService } from './project-service.js';

/**
 * FR-1.5 — notice that the files changed underneath us, and offer a reload.
 *
 * The case this exists for is `git pull`, and the case it must NOT fire on is
 * our own save. Both arrive as the same inotify/FSEvents notification, so the
 * watcher cannot tell them apart by watching harder. It tells them apart by
 * READING: a path is only announced when the bytes on disk differ from the
 * `raw` this process is holding. After a save the document has already been
 * reloaded (`reloadDocument`), so the comparison matches and nothing is
 * announced — no timing window, no suppression list, no race with a slow disk.
 *
 * That also absorbs the two nuisances a mtime-based watcher trips over: an
 * editor that writes a file byte-identically, and the duplicate events every
 * platform emits for a single save (macOS reliably sends two).
 *
 * Only files the project actually opened are considered. A watch on the project
 * root sees `node_modules`, `.git` and build output too, and on a large repo
 * that is most of the traffic.
 */

/** Long enough to coalesce a `git pull`'s burst, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

export interface FileWatcherDeps {
  readonly projects: ProjectService;
  readonly bus: EventBus;
  readonly onError?: (error: unknown) => void;
  readonly debounceMs?: number;
}

export class FileWatcher {
  #watcher: FSWatcher | undefined;
  #root: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** Paths seen since the last flush. A burst of twenty events is one check. */
  readonly #touched = new Set<string>();

  constructor(private readonly deps: FileWatcherDeps) {}

  get watching(): string | undefined {
    return this.#root;
  }

  /**
   * Watch `root` recursively. Replaces any previous watch, so opening a second
   * project does not leave the first one's descriptors behind.
   *
   * `recursive` is supported on macOS and Windows natively and on Linux from
   * Node 20; the engines field already requires 22. A platform that throws
   * anyway degrades to no watcher rather than to a broken server — the reload
   * banner is a convenience, and `POST /api/files/reload` stays reachable by
   * hand.
   */
  watchProject(root: string): void {
    this.stop();
    try {
      this.#watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename === null) return;
        this.#touch(resolve(root, filename.toString()));
      });
      this.#watcher.on('error', (error) => this.deps.onError?.(error));
      this.#root = root;
    } catch (error) {
      this.deps.onError?.(error);
      this.#watcher = undefined;
      this.#root = undefined;
    }
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#touched.clear();
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#root = undefined;
  }

  #touch(path: string): void {
    // Cheap rejection before the debounce, so a `npm install` under the project
    // root costs one Map lookup per event and nothing else.
    if (!this.deps.projects.current?.documents.has(path)) return;
    this.#touched.add(path);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#flush();
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
    // A watcher must never be the reason the process stays alive.
    this.#timer.unref?.();
  }

  async #flush(): Promise<void> {
    const paths = [...this.#touched];
    this.#touched.clear();

    const changed: string[] = [];
    for (const path of paths) {
      const doc = this.deps.projects.current?.documents.get(path);
      if (doc === undefined) continue;
      try {
        // Compared as text, not by mtime or size: this is the whole mechanism
        // by which our own writes stay silent.
        if ((await readFile(path, 'utf8')) !== doc.raw) changed.push(path);
      } catch {
        // Gone or unreadable — a `git checkout` of a branch without this locale,
        // say. That is a change the user should hear about; the reload route
        // decides what it can actually do about it.
        changed.push(path);
      }
    }

    if (changed.length > 0) {
      this.deps.bus.publish({ type: 'file-changed', paths: changed.sort() });
    }
  }
}
