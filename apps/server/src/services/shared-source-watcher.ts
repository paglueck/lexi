// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { TERMBASE_FILE, type SharedSourceKind } from '@lexi/shared';

import type { EventBus } from '../lib/event-bus.js';
import { readSharedSources } from '../lib/shared-sources.js';
import type { ProjectService } from './project-service.js';
import { readTermBase, sameTerms } from './termbase.js';

/**
 * Keep a linked style guide folder and Term Base in step with the shared
 * repository they come from — after a `git pull` there, or a save from another
 * project that links the same folder.
 *
 * Style guides need nothing kept in memory: every prompt reads them fresh. The
 * Term Base does — the validator's copy (`projects.setGlossary`) — and both
 * pages need to hear that the files moved under them. So this watches the
 * linked folders and publishes `shared-source-changed`.
 *
 * The same rule as `FileWatcher`: announce only what reads DIFFERENTLY from
 * what this process last saw, never merely what was touched. For the Term Base
 * that is the in-memory glossary, which the term routes update on every save;
 * for the guides it is a snapshot that `remember()` refreshes after a write
 * here. Either way our own saves stay silent.
 *
 * Not recursive, and not a project-root watch: the project's own `.lexi/` is
 * not linked and needs none of this.
 */

/** Long enough to coalesce a `git pull`'s burst, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

export interface SharedSourceWatcherDeps {
  readonly projects: ProjectService;
  readonly bus: EventBus;
  readonly onError?: (error: unknown) => void;
  readonly debounceMs?: number;
}

export class SharedSourceWatcher {
  readonly #watchers: FSWatcher[] = [];
  readonly #timers = new Map<SharedSourceKind, NodeJS.Timeout>();
  #projectPath: string | undefined;
  #guidesDir: string | undefined;
  /** `name → text` of every `.md` in the linked guide folder, as last seen. */
  #guides = new Map<string, string>();

  constructor(private readonly deps: SharedSourceWatcherDeps) {}

  /**
   * Watch whatever `projectPath` links right now, replacing any previous
   * watch. Called when a project opens and whenever its links change.
   */
  async watchProject(projectPath: string): Promise<void> {
    this.stop();
    this.#projectPath = projectPath;
    const links = await readSharedSources(projectPath);

    if (links.termbase !== null) {
      this.#watch(links.termbase, 'termbase', (name) => name === TERMBASE_FILE);
    }
    if (links.styleguides !== null) {
      this.#guidesDir = links.styleguides;
      this.#guides = await snapshotGuides(links.styleguides);
      this.#watch(links.styleguides, 'styleguides', (name) => name.endsWith('.md'));
    }
  }

  /** Re-read the guide snapshot after a write made here, so it does not echo. */
  async remember(): Promise<void> {
    if (this.#guidesDir !== undefined) this.#guides = await snapshotGuides(this.#guidesDir);
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const watcher of this.#watchers.splice(0)) watcher.close();
    this.#projectPath = undefined;
    this.#guidesDir = undefined;
    this.#guides = new Map();
  }

  /**
   * A folder that cannot be watched — missing, or a platform that refuses —
   * degrades to no watcher. The pages still read the files on every request;
   * only the push is lost.
   */
  #watch(dir: string, kind: SharedSourceKind, relevant: (name: string) => boolean): void {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // Some platforms omit the name; then any event may be the one.
        if (filename !== null && !relevant(filename.toString())) return;
        this.#schedule(kind);
      });
      watcher.on('error', (error) => this.deps.onError?.(error));
      this.#watchers.push(watcher);
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  #schedule(kind: SharedSourceKind): void {
    clearTimeout(this.#timers.get(kind));
    const timer = setTimeout(() => {
      this.#timers.delete(kind);
      void this.#flush(kind).catch((error: unknown) => this.deps.onError?.(error));
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
    // A watcher must never be the reason the process stays alive.
    timer.unref?.();
    this.#timers.set(kind, timer);
  }

  async #flush(kind: SharedSourceKind): Promise<void> {
    const projectPath = this.#projectPath;
    // The project was closed or replaced while the timer ran.
    if (projectPath === undefined || this.deps.projects.current?.path !== projectPath) return;

    if (kind === 'termbase') {
      const terms = await readTermBase(projectPath);
      const current = this.deps.projects.current.glossary ?? [];
      if (sameTerms(current, terms)) return;
      this.deps.projects.setGlossary(terms);
    } else {
      if (this.#guidesDir === undefined) return;
      const next = await snapshotGuides(this.#guidesDir);
      if (sameGuides(this.#guides, next)) return;
      this.#guides = next;
    }
    this.deps.bus.publish({ type: 'shared-source-changed', source: kind });
  }
}

async function snapshotGuides(dir: string): Promise<Map<string, string>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const guides = new Map<string, string>();
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => null);
    if (text !== null) guides.set(name, text);
  }
  return guides;
}

function sameGuides(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, text] of a) if (b.get(name) !== text) return false;
  return true;
}
