// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { RouterLink } from '@angular/router';
import type { RecentProject } from '@lexi/shared';

import { ProjectApi } from '../../core/api/project-api.js';
import { count, relative, shortPath } from '../../core/format-time.js';
import { isTypingTarget } from '../../core/is-typing-target.js';
import { ProjectActions } from '../../core/project-actions.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import {
  LxButton,
  LxModalService,
  LxStackedBar,
  LxToggle,
  type BarSegment,
} from '../../ui/index.js';
import { LxFolderPicker } from './folder-picker.js';

/** S17 shows at most this many rows under Recent. */
const RECENT_ROWS = 8;

/**
 * S17 — the launch menu (replaces S1's start screen).
 *
 * Three ways in: continue with the last project (↵), check out a tag from
 * Phrase (⌘⇧P), or open a folder (⌘O). The last two work from anywhere in the
 * app; ↵ only here. Opening goes through `ProjectActions.openPath`, the one
 * place that decides "known project → editor, new folder → wizard".
 *
 * The server shows this at start while "Show this menu at launch" is on; off,
 * it reopens the last project itself and `startGuard` sends the user on.
 */
@Component({
  selector: 'lx-start-page',
  imports: [LxButton, LxStackedBar, LxToggle, RouterLink],
  host: {
    '(document:keydown.enter)': 'onEnter($event)',
  },
  templateUrl: './start-page.html',
  styleUrl: './start-page.css',
})
export class StartPage {
  readonly #api = inject(ProjectApi);
  readonly #modal = inject(LxModalService);
  readonly #dialog = inject(Dialog);
  protected readonly actions = inject(ProjectActions);
  protected readonly project = inject(ProjectStore);
  protected readonly settings = inject(SettingsStore);

  protected readonly recents = signal<readonly RecentProject[]>([]);
  protected readonly recentsFailed = signal(false);
  protected readonly error = signal<string | null>(null);

  /** recents[0], newest first; null on a first run. */
  protected readonly last = computed<RecentProject | null>(() => this.recents()[0] ?? null);
  /** The rest, below the Continue card. */
  protected readonly rest = computed(() => this.recents().slice(1, RECENT_ROWS + 1));

  protected readonly busy = computed(() => this.actions.busy() === 'open');
  protected readonly showMenu = computed(() => this.settings.settings()?.launch.showMenu ?? true);

  protected readonly count = count;

  constructor() {
    void this.settings.load();
    // Loads once, and again whenever the list was cleared from the menu or palette.
    effect(() => {
      this.actions.recentsChangedAt();
      untracked(() => void this.#load());
    });
  }

  /** "Phrase · all keys", "Phrase · {tag}" or "Phrase · {n} tags". */
  protected phraseBadge(tags: readonly string[]): string {
    if (tags.length === 0) return 'Phrase · all keys';
    return tags.length === 1 ? `Phrase · ${tags[0]}` : `Phrase · ${tags.length} tags`;
  }

  protected open(path: string): void {
    void this.actions.openPath(path);
  }

  /** ↵ and the Continue card. Not for a folder that is gone. */
  protected continue(): void {
    const last = this.last();
    if (last === null || !last.exists || this.busy()) return;
    this.open(last.path);
  }

  protected openFolder(): void {
    void this.actions.openFolder();
  }

  /**
   * ↵ anywhere on the page — except where Enter already means something: a
   * text field, a focused button or link, the toggle, or an open dialog.
   */
  protected onEnter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.metaKey || key.ctrlKey || key.altKey || key.shiftKey) return;
    if (isTypingTarget(event.target) || this.#dialog.openDialogs.length > 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, [role="switch"]')) return;
    event.preventDefault();
    this.continue();
  }

  /** "Locate…": the folder moved; point the entry at where it is now. */
  protected locate(recent: RecentProject): void {
    const ref = this.#modal.open<LxFolderPicker, string>(LxFolderPicker, {
      data: { title: `Locate ${recent.name}`, subtitle: 'Choose the folder it moved to' },
    });
    ref.closed.subscribe((path) => {
      if (!path) return;
      this.#api
        .locateRecent(recent.id, path)
        .then((res) => {
          this.recents.set(res.recents);
          this.error.set(null);
        })
        .catch(() => this.error.set(`Could not point ${recent.name} at ${path}.`));
    });
  }

  protected async forget(recent: RecentProject, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.#api.forgetRecent(recent.id).catch(() => undefined);
    this.recents.update((list) => list.filter((r) => r.id !== recent.id));
  }

  protected setShowMenu(on: boolean): void {
    void this.settings.patch({ showLaunchMenu: on });
  }

  /** The 4px coverage bar on the Continue card. */
  protected segments(recent: RecentProject): BarSegment[] {
    const { translated, draft, needsReview } = recent.coverage;
    return [
      { value: translated, tone: 'accent', label: 'Reviewed & final' },
      { value: draft, tone: 'warn', label: 'Machine draft' },
      { value: needsReview, tone: 'danger', label: 'Needs review' },
    ];
  }

  /** "2 hours ago" / "Tuesday" / "3 weeks ago", as the mock shows. */
  protected when(iso: string): string {
    return relative(iso);
  }

  protected short(path: string): string {
    return shortPath(path);
  }

  async #load(): Promise<void> {
    try {
      const { recents } = await this.#api.recents();
      this.recents.set(recents);
      this.recentsFailed.set(false);
    } catch {
      // An empty list would read as a first run, which is not what happened.
      this.recentsFailed.set(true);
    }
  }
}
