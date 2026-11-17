// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { Dialog } from '@angular/cdk/dialog';
import { filter, map, startWith } from 'rxjs';
import type { Health } from '@lexi/shared';

import { HistoryActions, historyChord } from './core/history-actions.js';
import { ProjectActions } from './core/project-actions.js';
import { ChromeStore } from './core/stores/chrome-store.js';
import { EventsStore } from './core/stores/events-store.js';
import { JobsStore } from './core/stores/jobs-store.js';
import { ProjectStore } from './core/stores/project-store.js';
import { SaveStore } from './core/stores/save-store.js';
import { LxCommandPalette } from './ui/command-palette.js';
import { LxModalService } from './ui/modal.js';
import { LxReloadBanner } from './ui/chrome/reload-banner.js';
import { LxStatusBar } from './ui/chrome/status-bar.js';
import { LxToastHost } from './ui/toast.js';
import { LxTitleBar, type ChromeMode } from './ui/chrome/title-bar.js';

@Component({
  selector: 'lx-root',
  imports: [RouterOutlet, LxTitleBar, LxStatusBar, LxReloadBanner, LxToastHost],
  host: {
    '(document:keydown)': 'onGlobalKey($event)',
  },
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly #router = inject(Router);
  readonly #route = inject(ActivatedRoute);
  readonly #http = inject(HttpClient);
  readonly #project = inject(ProjectStore);
  readonly #save = inject(SaveStore);
  readonly #chrome = inject(ChromeStore);
  readonly #events = inject(EventsStore);
  readonly #jobs = inject(JobsStore);
  readonly #dialog = inject(Dialog);
  readonly #modal = inject(LxModalService);
  readonly #history = inject(HistoryActions);
  readonly #injector = inject(Injector);

  /** Which of the three title-bar variants the current route wants. */
  protected readonly chromeMode = computed<ChromeMode>(() => this.#routeData()?.chrome ?? 'full');
  /** What the minimal bar says after "Lexi", e.g. S18's "Check out from Phrase". */
  protected readonly chromeLabel = computed(() => this.#routeData()?.chromeLabel ?? '');

  readonly #routeData = toSignal(
    this.#router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      startWith(null),
      map(() => {
        let r = this.#route;
        while (r.firstChild) r = r.firstChild;
        return r.snapshot.data as { chrome?: ChromeMode; chromeLabel?: string } | undefined;
      }),
    ),
    { initialValue: undefined },
  );

  constructor() {
    // One stream for the whole app, opened once at boot: the save indicator, the
    // dashboard's last-save footer and the reload banner all read from it, and
    // opening it per screen would spend the origin's connection budget on
    // duplicates of the same events.
    this.#events.connect();

    // The title bar's "N running" indicator (S8) has to be right without
    // anyone having opened the Jobs screen, so the list is loaded here rather
    // than only from `JobsPage`'s own `refresh()`. Once loaded, SSE keeps it
    // current — this fires once per project, not on a poll.
    //
    // Keyed on the open project's PATH, not on \`isOpen\`: switching straight
    // from project A to B never flips \`isOpen\` to false, and the server
    // restores a project's finished jobs when it is opened, so the list would
    // keep A's jobs until something else refreshed it.
    const openPath = computed(() => this.#project.project()?.path ?? null);
    effect(() => {
      if (openPath() !== null) untracked(() => void this.#jobs.refresh());
    });

    // The desktop app looks for an update on every start, behind a dialog that
    // holds the app until the check has answered. Elsewhere the server says
    // `supported: false` and nothing opens. A lazy chunk either way, so the
    // initial bundle carries none of it. The chunk can arrive after the shell
    // is gone (a test's teardown), and a destroyed injector throws on get().
    let destroyed = false;
    inject(DestroyRef).onDestroy(() => (destroyed = true));
    void import('./features/update/update-dialog.js').then((m) =>
      destroyed ? undefined : m.checkForUpdatesAtStartup(this.#injector),
    );

    this.#http.get<Health>('/api/health').subscribe({
      // Only clears a stale project; the guards load the real one. The shell
      // must render even if the server is not up yet, so this is informational.
      next: (health) => this.#project.applyHealth(health),
      error: () => undefined,
    });

    // Dev-only fixtures so the populated chrome can be reviewed against the
    // mock before M4 can actually open a project.
    if (new URLSearchParams(location.search).get('fixtures') === '1') {
      this.#project.seedFixture('northwind-web', 'en-GB');
      this.#save.setUnsaved(12);
      this.#chrome.setLeft([{ text: '1,284 of 4,812 rows' }, { text: 'Row 1 selected' }]);
    }

    this.#router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.#chrome.reset());
  }

  /**
   * The two chords the status bar has advertised since M12 (`⌘K`) and the
   * debt table has been waiting on since M8 (`⌘,`): the palette, and a direct
   * jump to Settings so the gear icon is not the only route there.
   *
   * Deliberately NOT gated by the grid's `isTypingTarget` guard — modifier
   * chords are expected to fire while editing text (unlike Focus mode's bare
   * `a`/`r`/`s`, which would otherwise hijack ordinary typing).
   */
  protected onGlobalKey(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;

    if (event.key.toLowerCase() === 'k') {
      event.preventDefault();
      // Never stack a second palette on top of itself, or on top of another
      // modal that is mid-decision (e.g. a bulk-approve confirmation).
      if (this.#dialog.openDialogs.length === 0) this.#modal.open(LxCommandPalette);
      return;
    }
    if (event.key === ',') {
      event.preventDefault();
      void this.#router.navigateByUrl('/settings');
      return;
    }

    // S17's two ways in that work from anywhere: ⌘⇧P checks out a Phrase tag,
    // ⌘O opens a folder. Not under a modal, whose decision comes first.
    const key = event.key.toLowerCase();
    if (key === 'p' && event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (this.#dialog.openDialogs.length === 0)
        void this.#router.navigateByUrl('/phrase/checkout');
      return;
    }
    if (key === 'o' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (this.#dialog.openDialogs.length === 0)
        void this.#injector.get(ProjectActions).openFolder();
      return;
    }

    // ⌘Z / ⌘⇧Z: undo unsaved work. The exception to the note above — in a text
    // field these chords are the field's own text undo (`historyChord`). Never
    // under a modal either, where the page behind is not what is in view.
    const chord = historyChord(event);
    if (chord !== null && this.#dialog.openDialogs.length === 0) {
      event.preventDefault();
      void (chord === 'redo' ? this.#history.redo() : this.#history.undo());
    }
  }
}
