// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { LxModalService } from '../ui/modal.js';
import { ProjectApi } from './api/project-api.js';
import { EventsStore } from './stores/events-store.js';
import { ProjectStore } from './stores/project-store.js';
import { SaveStore } from './stores/save-store.js';

/**
 * What the title bar's project menu can do — reload, re-scan, switch.
 *
 * A service rather than three methods on the menu component, because all three
 * are the same shape: check what would be lost, ask if anything would, then
 * touch the api, the router and three stores. A component that did that would
 * be mostly not-a-component, and the question worth testing — "does switching
 * close before it navigates" — would only be reachable through a fixture.
 *
 * The confirmation is a PENDING SIGNAL rather than an awaited dialog, which is
 * the shape `TranslateStore` already uses for FR-6.10's overwrite question. It
 * keeps the decision in one place the template renders and a test can read,
 * instead of a promise suspended inside a method.
 */

/** Kept as data so the confirm text can name what is about to run. */
export type ProjectAction = 'reload' | 'rescan' | 'remap' | 'switch' | 'open';

export interface PendingConfirm {
  readonly action: ProjectAction;
  /** Drafts written but not saved. Never zero — at zero nothing is asked. */
  readonly unsavedCount: number;
  /** `open` only: the folder that was picked. */
  readonly path?: string;
}

@Injectable({ providedIn: 'root' })
export class ProjectActions {
  readonly #api = inject(ProjectApi);
  readonly #project = inject(ProjectStore);
  readonly #save = inject(SaveStore);
  readonly #events = inject(EventsStore);
  readonly #router = inject(Router);
  readonly #modal = inject(LxModalService);

  readonly #pending = signal<PendingConfirm | null>(null);
  readonly #busy = signal<ProjectAction | null>(null);

  readonly pendingConfirm = this.#pending.asReadonly();
  readonly busy = this.#busy.asReadonly();
  readonly canAct = computed(() => this.#project.isOpen() && this.#busy() === null);

  readonly #openError = signal<string | null>(null);
  /** Why the last open failed, in a sentence; null after a success. */
  readonly openError = this.#openError.asReadonly();

  readonly #recentsChangedAt = signal(0);
  /** Bumped when the recent list was cleared, so a screen showing it reloads. */
  readonly recentsChangedAt = this.#recentsChangedAt.asReadonly();

  /**
   * ⌘O and S17's "Open a project…": the folder picker, then `openPath`. The
   * picker is the in-app one — there is no native dialog for a page served
   * over localhost (see `LxFolderPicker`).
   */
  async openFolder(): Promise<void> {
    const { LxFolderPicker } = await import('../features/start/folder-picker.js');
    const ref = this.#modal.open<InstanceType<typeof LxFolderPicker>, string>(LxFolderPicker);
    ref.closed.subscribe((path) => {
      if (path) void this.openPath(path);
    });
  }

  /**
   * Open a folder: straight away when it has been set up before, otherwise
   * scan and go to the wizard. Asks first when that would drop unsaved drafts
   * of the project that is open now.
   */
  async openPath(path: string): Promise<void> {
    const unsavedCount = this.#save.unsavedCount();
    if (this.#project.isOpen() && unsavedCount > 0) {
      this.#pending.set({ action: 'open', unsavedCount, path });
      return;
    }
    await this.#runOpen(path);
  }

  /** "Clear recent projects" — the list, never the folders. */
  async clearRecents(): Promise<void> {
    await this.#api.clearRecents();
    this.#recentsChangedAt.set(Date.now());
  }

  reloadFromDisk(): Promise<void> {
    return this.#guard('reload');
  }

  rescan(): Promise<void> {
    return this.#guard('rescan');
  }

  /** Back to the wizard, prefilled with the saved mapping. */
  remap(): Promise<void> {
    return this.#guard('remap');
  }

  switchProject(): Promise<void> {
    return this.#guard('switch');
  }

  /** The user said yes. Same action, without the question. */
  async confirmPending(): Promise<void> {
    const pending = this.#pending();
    if (pending === null) return;
    this.#pending.set(null);
    if (pending.action === 'open') await this.#runOpen(pending.path ?? '');
    else await this.#run(pending.action);
  }

  dismissConfirm(): void {
    this.#pending.set(null);
  }

  /**
   * Ask first if anything would be lost, otherwise just go.
   *
   * All three discard unsaved drafts: reload re-reads the files the dirty
   * buffer was written against, and the other two drop the buffer outright. The
   * count is in the question because a number is what makes it a warning rather
   * than a formality — the same reason the reload banner puts it in its text.
   */
  async #guard(action: ProjectAction): Promise<void> {
    const unsavedCount = this.#save.unsavedCount();
    if (unsavedCount > 0) {
      this.#pending.set({ action, unsavedCount });
      return;
    }
    await this.#run(action);
  }

  async #run(action: ProjectAction): Promise<void> {
    this.#busy.set(action);
    try {
      if (action === 'reload') await this.#reload();
      else if (action === 'rescan') await this.#rescan();
      else if (action === 'remap') await this.#remap();
      else await this.#switch();
    } finally {
      this.#busy.set(null);
    }
  }

  /**
   * Locale mapping and source locale are asked once per project, not on every
   * open: a folder with a `.lexi/project.json` opens with it.
   *
   * The scan result is fetched again in the wizard rather than carried across
   * the navigation: the server caches it, and a component that reads its own
   * data is far easier to reason about than one that depends on router state
   * having been populated.
   */
  async #runOpen(path: string): Promise<void> {
    if (path === '') return;
    this.#busy.set('open');
    this.#openError.set(null);
    try {
      const resumed = await this.#api.resume(path);
      if (!resumed.needsSetup) {
        this.#project.set(resumed.project);
        this.#save.setUnsaved(0);
        await this.#router.navigate(['/dashboard']);
        return;
      }

      const scan = await this.#api.scan(path);
      if (scan.files.length === 0) {
        this.#openError.set(`No .xlf files found under ${path}.`);
        return;
      }
      await this.#router.navigate(['/setup'], { queryParams: { path: scan.root } });
    } catch {
      this.#openError.set(`Could not open ${path}. Is it still there?`);
    } finally {
      this.#busy.set(null);
    }
  }

  /** Every file in the project, not only the ones the watcher flagged. */
  async #reload(): Promise<void> {
    const paths = this.#project.files().map((f) => f.path);
    await this.#events.reload(paths);
  }

  /**
   * Re-scan the folder and open what it found.
   *
   * The mapping is rebuilt from the SCAN rather than from the open project,
   * which is the whole point: a locale file added since the project was opened
   * is in the scan and not in the project, and re-opening with the old mapping
   * would carefully reproduce the state the user asked to escape. The wizard is
   * not involved — FR-1.3's confirmed mapping is already in `.lexi/project.json`
   * and locale detection answers the rest.
   */
  async #rescan(): Promise<void> {
    const open = this.#project.project();
    if (open === null) return;

    const scanned = await this.#api.scan(open.path);
    // A locale the user confirmed in the wizard wins over detection.
    const saved = new Map(
      (scanned.saved?.mapping ?? []).map((m) => [`${m.relPath}#${m.fileIndex}`, m.locale]),
    );
    const reopened = await this.#api.open({
      path: open.path,
      sourceLocale: open.sourceLocale,
      mapping: scanned.files.flatMap((f) => {
        const locale = saved.get(`${f.relPath}#${f.fileIndex}`) ?? f.locale;
        // `fixTargetLanguage` is never `true`: rewriting a file's
        // `target-language` is the wizard's explicit amber action (FR-1.2b), and
        // a re-scan is not the place to edit somebody's files as a side effect
        // of looking at them.
        return locale === null
          ? []
          : [{ path: f.path, fileIndex: f.fileIndex, locale, fixTargetLanguage: false }];
      }),
    });
    this.#project.set(reopened);
    this.#save.setUnsaved(0);
  }

  /**
   * The wizard again, for a mapping or source locale that has to change. It
   * re-opens the project when confirmed, so pending drafts are asked about
   * first like the other two that rebuild the project.
   */
  async #remap(): Promise<void> {
    const open = this.#project.project();
    if (open === null) return;
    await this.#router.navigate(['/setup'], { queryParams: { path: open.path } });
  }

  /**
   * Close, then go to the start screen — in that order, and not the reverse.
   *
   * `startGuard` sends anyone with a project open back to the dashboard, so
   * navigating first would bounce straight off it. Closing first is what makes
   * the start screen reachable at all.
   */
  async #switch(): Promise<void> {
    await this.#api.close();
    this.#project.clear();
    this.#save.setUnsaved(0);
    await this.#router.navigate(['/start']);
  }
}
