// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, effect, inject, signal, viewChild, type ElementRef } from '@angular/core';

import { ProjectActions, type ProjectAction } from '../../core/project-actions.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { PhraseActions } from '../../features/phrase/phrase-actions.js';
import { LxButton } from '../button.js';
import { LxIcon } from '../icon.js';
import { LxMenu } from '../menu.js';

/**
 * The project name in the title bar, made into a menu (S1). Below the project
 * actions sit the two Phrase entries — push, and connect for a project whose
 * first-open step was skipped.
 *
 * The name was already the one piece of chrome that names the thing every
 * screen is about, and it did nothing when clicked. Reload, re-scan and switch
 * all answer "this project, but different", so they belong on it rather than as
 * three more glyphs competing with the gear — the bar deliberately carries very
 * little.
 *
 * Presentation only. Which stores get touched in what order is
 * `ProjectActions`' business; this decides what the rows say and when the panel
 * is up. `Escape` and a click anywhere else close it, through host listeners
 * rather than a backdrop element, so the menu never sits on top of the tab
 * strip it is next to.
 */
const LABEL: Record<ProjectAction, string> = {
  reload: 'Reload from disk',
  rescan: 'Re-scan project',
  remap: 'Edit locale mapping…',
  switch: 'Switch project…',
  open: 'Open project',
};

/** What the confirmation says is about to happen, in the same words as the row. */
const CONSEQUENCE: Record<ProjectAction, string> = {
  reload: 're-reads the files they were written against',
  rescan: 'rebuilds the project from a fresh scan',
  remap: 're-opens the project with the new mapping',
  switch: 'closes this project',
  open: 'opens another project',
};

@Component({
  selector: 'lx-project-menu',
  imports: [LxButton, LxIcon, LxMenu],
  host: {
    '(document:click)': 'close()',
    '(document:keydown.escape)': 'onEscape()',
    '(click)': '$event.stopPropagation()',
  },
  template: `
    @if (project.isOpen()) {
      <button
        type="button"
        class="trigger"
        [attr.aria-expanded]="open()"
        aria-haspopup="menu"
        title="Reload, re-scan or switch project"
        (click)="toggle()"
      >
        {{ project.name() }}
        <lx-icon class="caret" name="chevron-down" [size]="12" />
      </button>

      @if (open()) {
        <div class="menu" lxMenu aria-label="Project" (lxMenuClose)="close()">
          @for (action of ACTIONS; track action) {
            <button
              type="button"
              role="menuitem"
              class="menuitem"
              [disabled]="!actions.canAct()"
              (click)="run(action)"
            >
              {{ LABEL[action] }}
            </button>
          }
          <hr class="sep" />
          <button
            type="button"
            role="menuitem"
            class="menuitem"
            [disabled]="!actions.canAct()"
            (click)="phrase(true)"
          >
            Push to Phrase…
          </button>
          <button
            type="button"
            role="menuitem"
            class="menuitem"
            [disabled]="!actions.canAct()"
            (click)="phrase(false)"
          >
            Connect to Phrase…
          </button>
          <hr class="sep" />
          <button type="button" role="menuitem" class="menuitem" (click)="clearRecents()">
            Clear recent projects
          </button>
        </div>
      }

      @if (actions.pendingConfirm(); as pending) {
        <div
          class="confirm"
          role="alertdialog"
          aria-label="Unsaved drafts"
          aria-describedby="project-confirm-text"
          tabindex="-1"
          #confirm
        >
          <p class="confirm__text" id="project-confirm-text">
            {{ pending.unsavedCount }} unsaved
            {{ pending.unsavedCount === 1 ? 'draft' : 'drafts' }} will be lost —
            {{ CONSEQUENCE[pending.action] }}. Save first if you want to keep them.
          </p>
          <div class="confirm__actions">
            <button
              type="button"
              lx-button
              variant="neutral"
              size="xs"
              class="confirm__cancel"
              (click)="actions.dismissConfirm()"
            >
              Cancel
            </button>
            <button
              type="button"
              lx-button
              variant="danger-soft"
              size="xs"
              class="confirm__go"
              (click)="actions.confirmPending()"
            >
              {{ LABEL[pending.action] }}
            </button>
          </div>
        </div>
      }
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
    }
    .trigger {
      display: inline-flex;
      align-items: center;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-2) var(--lx-sp-6);
      border: 0;
      border-radius: var(--lx-r-5);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .trigger:hover,
    .trigger[aria-expanded='true'] {
      background: var(--lx-bg-selected);
    }
    .caret {
      color: var(--lx-text-faint-2);
    }
    .menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      min-width: 180px;
      padding: var(--lx-sp-4);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
    }
    .menuitem {
      padding: var(--lx-sp-4) var(--lx-sp-8);
      border: 0;
      border-radius: var(--lx-r-5);
      background: transparent;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      text-align: left;
      cursor: pointer;
    }
    .menuitem:hover:not(:disabled) {
      background: var(--lx-bg-selected);
    }
    .sep {
      width: 100%;
      margin: var(--lx-sp-4) 0;
      border: 0;
      border-top: 1px solid var(--lx-border-section);
    }
    .menuitem:disabled {
      color: var(--lx-text-faint);
      cursor: default;
    }
    .confirm {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 30;
      width: 320px;
      padding: var(--lx-sp-12);
      border: 1px solid var(--lx-warn-tint-border);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
    }
    .confirm__text {
      margin: 0 0 var(--lx-sp-10);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12);
      line-height: var(--lx-lh-body);
    }
    .confirm__actions {
      display: flex;
      gap: var(--lx-sp-8);
      justify-content: flex-end;
    }
  `,
})
export class LxProjectMenu {
  protected readonly project = inject(ProjectStore);
  protected readonly actions = inject(ProjectActions);
  readonly #phrase = inject(PhraseActions);

  protected readonly LABEL = LABEL;
  protected readonly CONSEQUENCE = CONSEQUENCE;
  protected readonly ACTIONS: readonly ProjectAction[] = ['reload', 'rescan', 'remap', 'switch'];

  protected readonly open = signal(false);

  private readonly confirmEl = viewChild<ElementRef<HTMLElement>>('confirm');

  constructor() {
    // The confirmation can be raised from the command palette as well as from
    // this menu, and either way it appears with focus somewhere else. Moving it
    // to Cancel — the harmless choice — makes it announce itself and keeps
    // Enter from ever meaning "discard".
    effect(() => {
      this.confirmEl()?.nativeElement.querySelector<HTMLElement>('.confirm__cancel')?.focus();
    });
  }

  protected onEscape(): void {
    this.close();
    if (this.actions.pendingConfirm()) this.actions.dismissConfirm();
  }

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected close(): void {
    this.open.set(false);
  }

  /**
   * The panel shuts on the click, not when the work finishes.
   *
   * Two of the three can take a moment, and a menu that hangs open over a
   * re-scan reads as a click that did not land — which is how a user ends up
   * running it twice.
   */
  protected run(action: ProjectAction): void {
    this.close();
    if (action === 'reload') void this.actions.reloadFromDisk();
    else if (action === 'rescan') void this.actions.rescan();
    else if (action === 'remap') void this.actions.remap();
    else void this.actions.switchProject();
  }

  /** Only the list goes; the projects themselves are not touched, so nothing is asked. */
  protected clearRecents(): void {
    this.close();
    void this.actions.clearRecents();
  }

  /** The Phrase rows open a dialog of their own; nothing is lost, so nothing is asked. */
  protected phrase(push: boolean): void {
    this.close();
    if (push) void this.#phrase.push();
    else void this.#phrase.connect();
  }
}
