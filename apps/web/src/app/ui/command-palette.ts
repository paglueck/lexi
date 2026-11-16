// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { Router } from '@angular/router';

import { LxModalShell } from './modal.js';
import { HistoryActions } from '../core/history-actions.js';
import { ProjectActions } from '../core/project-actions.js';
import { PhraseActions } from '../features/phrase/phrase-actions.js';
import { ThemeStore } from '../core/stores/theme-store.js';

interface Command {
  readonly id: string;
  readonly label: string;
  /** A shortcut this command already has, shown for discoverability (e.g. Settings' `⌘,`). */
  readonly hint?: string;
  readonly run: () => void;
}

/** Instance counter, for the listbox ids `aria-activedescendant` has to point at. */
let instances = 0;

/**
 * `⌘K` — a navigation aid, not a general action runner (yet). Opened by
 * `App`'s global key handler through `LxModalService`, which is what supplies
 * the focus trap, `aria-modal` and Escape-to-close for free.
 *
 * The listbox shape (role="combobox" input + role="listbox"/"option" list,
 * `aria-activedescendant` rather than moving real focus) is `LxCombobox`'s
 * pattern, reused rather than reinvented, because a second accessible
 * implementation of the same idiom is a second place to get it subtly wrong.
 */
@Component({
  selector: 'lx-command-palette',
  imports: [LxModalShell],
  template: `
    <lx-modal-shell title="Commands">
      <input
        #field
        class="lx-input"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        placeholder="Type a command…"
        aria-label="Commands"
        aria-expanded="true"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="matches().length > 0 ? listId + '-' + highlighted() : null"
        aria-autocomplete="list"
        [value]="query()"
        (input)="onInput($event)"
        (keydown)="onKeydown($event)"
      />
      <ul class="menu" role="listbox" [id]="listId">
        @for (command of matches(); track command.id; let i = $index) {
          <li
            class="option"
            role="option"
            [id]="listId + '-' + i"
            [attr.aria-selected]="i === highlighted()"
            [class.option--on]="i === highlighted()"
            (mousedown)="choose($event, command)"
          >
            <span>{{ command.label }}</span>
            @if (command.hint) {
              <kbd class="hint lx-mono">{{ command.hint }}</kbd>
            }
          </li>
        } @empty {
          <li class="empty" role="presentation">No matching commands.</li>
        }
      </ul>
    </lx-modal-shell>
  `,
  styles: `
    .lx-input {
      width: 100%;
      margin-bottom: var(--lx-sp-12);
    }
    .menu {
      max-height: 320px;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-8);
      padding: var(--lx-sp-8) var(--lx-sp-10);
      border-radius: var(--lx-r-5);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      cursor: pointer;
    }
    .option--on,
    .option:hover {
      background: var(--lx-bg-selected);
      color: var(--lx-accent-on-tint);
    }
    .hint {
      font-size: var(--lx-fs-10);
      color: var(--lx-text-faint-3);
    }
    .empty {
      padding: var(--lx-sp-8) var(--lx-sp-10);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
  `,
})
export class LxCommandPalette {
  readonly #ref = inject<DialogRef<void, LxCommandPalette>>(DialogRef);
  readonly #router = inject(Router);
  readonly #theme = inject(ThemeStore);
  readonly #project = inject(ProjectActions);
  readonly #phrase = inject(PhraseActions);
  readonly #history = inject(HistoryActions);

  protected readonly query = signal('');
  protected readonly highlighted = signal(0);
  protected readonly listId = `lx-command-palette-${++instances}`;

  protected readonly fieldRef = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly #commands: readonly Command[] = [
    { id: 'go-dashboard', label: 'Go to Dashboard', run: () => this.#go('/dashboard') },
    { id: 'go-grid', label: 'Go to Grid', run: () => this.#go('/grid') },
    { id: 'go-review', label: 'Go to Review', run: () => this.#go('/review') },
    { id: 'go-styleguides', label: 'Go to Style guides', run: () => this.#go('/styleguides') },
    { id: 'go-termbase', label: 'Go to Term Base', run: () => this.#go('/termbase') },
    { id: 'go-issues', label: 'Go to Issues', run: () => this.#go('/issues') },
    { id: 'go-jobs', label: 'Go to Jobs', run: () => this.#go('/jobs') },
    { id: 'go-settings', label: 'Go to Settings', hint: '⌘,', run: () => this.#go('/settings') },
    { id: 'undo', label: 'Undo', hint: '⌘Z', run: () => void this.#history.undo() },
    { id: 'redo', label: 'Redo', hint: '⌘⇧Z', run: () => void this.#history.redo() },
    {
      id: 'discard-all',
      label: 'Discard all unsaved changes',
      run: () => void this.#history.discardAll(),
    },
    // The same three the title bar's project menu offers. They go through
    // `ProjectActions`, so the unsaved-drafts question is asked here too — the
    // palette is a second door onto one action, not a way round its guard.
    {
      id: 'project-reload',
      label: 'Reload project from disk',
      run: () => void this.#project.reloadFromDisk(),
    },
    { id: 'project-rescan', label: 'Re-scan project', run: () => void this.#project.rescan() },
    {
      id: 'project-remap',
      label: 'Edit locale mapping',
      run: () => void this.#project.remap(),
    },
    { id: 'phrase-push', label: 'Push to Phrase', run: () => void this.#phrase.push() },
    { id: 'phrase-connect', label: 'Connect to Phrase', run: () => void this.#phrase.connect() },
    {
      id: 'project-switch',
      label: 'Switch project',
      run: () => void this.#project.switchProject(),
    },
    {
      id: 'project-open',
      label: 'Open a project…',
      hint: '⌘O',
      run: () => void this.#project.openFolder(),
    },
    {
      id: 'phrase-checkout',
      label: 'Check out from Phrase',
      hint: '⌘⇧P',
      run: () => this.#go('/phrase/checkout'),
    },
    {
      id: 'recents-clear',
      label: 'Clear recent projects',
      run: () => void this.#project.clearRecents(),
    },
    { id: 'theme-dark', label: 'Switch to dark theme', run: () => this.#theme.set('dark') },
    { id: 'theme-light', label: 'Switch to light theme', run: () => this.#theme.set('light') },
    { id: 'theme-system', label: 'Match the system theme', run: () => this.#theme.set('system') },
  ];

  /** Substring match, ranked by how early the match falls in the label. */
  protected readonly matches = computed<readonly Command[]>(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle === '') return this.#commands;
    return this.#commands
      .map((c) => ({ c, at: c.label.toLowerCase().indexOf(needle) }))
      .filter((m) => m.at !== -1)
      .sort((a, b) => a.at - b.at)
      .map((m) => m.c);
  });

  constructor() {
    // Keep the highlight inside the list as it filters under the cursor.
    effect(() => {
      const size = this.matches().length;
      if (this.highlighted() >= size) this.highlighted.set(Math.max(0, size - 1));
    });

    afterNextRender(() => this.fieldRef().nativeElement.focus());
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.highlighted.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.highlighted.update((i) => Math.min(i + 1, this.matches().length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.highlighted.update((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        this.#run(this.matches()[this.highlighted()]);
        break;
      default:
        break;
    }
  }

  protected choose(event: Event, command: Command): void {
    // Mousedown, not click: a click would blur the input first, and preventing
    // that default here is what keeps focus (and the caret) exactly where it
    // was — the same reason `LxCombobox` picks its options the same way.
    event.preventDefault();
    this.#run(command);
  }

  #run(command: Command | undefined): void {
    if (!command) return;
    this.#ref.close();
    command.run();
  }

  #go(path: string): void {
    void this.#router.navigateByUrl(path);
  }
}
