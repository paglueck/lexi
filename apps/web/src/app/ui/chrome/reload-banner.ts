// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, signal } from '@angular/core';

import { EventsStore } from '../../core/stores/events-store.js';
import { SaveStore } from '../../core/stores/save-store.js';
import { LxButton } from '../button.js';

/**
 * "3 files changed on disk" (FR-1.5).
 *
 * Lives in the SHELL rather than on the dashboard, although the mock draws it
 * as a dashboard rail row. The reason is what it is for: the files move
 * underneath a `git pull` while somebody is typing in the grid, and a warning
 * that can only be seen on a screen they are not looking at is not a warning.
 * The dashboard's rail still shows the same fact — it is a list of what needs
 * attention, and this qualifies — so the two agree by both reading one store.
 *
 * The unsaved count is in the text on purpose. A reload re-reads the files the
 * dirty buffer was written against, and an edit whose unit no longer exists
 * cannot be carried across. Saying so before the click is what makes this a
 * warning rather than an apology afterwards.
 */
@Component({
  selector: 'lx-reload-banner',
  imports: [LxButton],
  template: `
    @if (events.hasChanges()) {
      <div class="banner" role="status">
        <span class="lx-badge" data-tone="neutral" aria-hidden="true">↻</span>
        <p class="text">
          <strong class="title">{{ headline() }}</strong>
          <span class="detail">{{ detail() }}</span>
        </p>
        @if (dropped(); as count) {
          <span class="dropped">{{ count }}</span>
        }
        <div class="actions">
          <button type="button" lx-button variant="neutral" size="xs" (click)="events.dismiss()">
            Dismiss
          </button>
          <button
            type="button"
            lx-button
            variant="accent-soft"
            size="xs"
            [disabled]="events.reloading()"
            (click)="reload()"
          >
            {{ events.reloading() ? 'Reloading…' : 'Reload' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: `
    .banner {
      display: flex;
      gap: var(--lx-sp-12);
      align-items: center;
      padding: var(--lx-sp-8) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-warn-tint-border);
      background: var(--lx-warn-callout-bg);
    }
    .text {
      display: flex;
      gap: var(--lx-sp-8);
      align-items: baseline;
      flex-wrap: wrap;
      min-width: 0;
      margin: 0;
    }
    .title {
      color: var(--lx-warn-on-tint-strong);
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-600);
    }
    .detail {
      color: var(--lx-warn-body-text);
      font-size: var(--lx-fs-12);
      overflow-wrap: anywhere;
    }
    .dropped {
      color: var(--lx-danger);
      font-size: var(--lx-fs-12);
    }
    .actions {
      display: flex;
      gap: var(--lx-sp-8);
      margin-left: auto;
    }
  `,
})
export class LxReloadBanner {
  protected readonly events = inject(EventsStore);
  protected readonly save = inject(SaveStore);

  protected readonly headline = computed(() => {
    const count = this.events.changedPaths().length;
    return `${count} ${count === 1 ? 'file' : 'files'} changed on disk`;
  });

  protected readonly detail = computed(() => {
    const files = this.events.changedRelative();
    const shown = files.slice(0, 3).join(', ');
    const rest = files.length > 3 ? `, and ${files.length - 3} more` : '';
    const unsaved = this.save.unsavedCount();
    if (unsaved === 0) return `${shown}${rest}. Nothing of yours is unsaved.`;
    return `${shown}${rest}. You have ${unsaved} unsaved ${
      unsaved === 1 ? 'edit' : 'edits'
    } — any whose string no longer exists will be dropped.`;
  });

  /** What the last reload cost. A signal, because the banner has to redraw for it. */
  readonly #dropped = signal(0);

  protected readonly dropped = computed(() => {
    const count = this.#dropped();
    return count > 0 ? `${count} unsaved ${count === 1 ? 'edit was' : 'edits were'} dropped` : null;
  });

  protected async reload(): Promise<void> {
    const result = await this.events.reload();
    this.#dropped.set(result.dropped);
  }
}
