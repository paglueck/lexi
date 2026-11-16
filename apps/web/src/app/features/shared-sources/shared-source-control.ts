// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { SharedSourceKind } from '@lexi/shared';

import { SharedSourcesApi } from '../../core/api/shared-sources-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { LxBadge, LxButton, LxModalService } from '../../ui/index.js';
import { LxFolderPicker, type FolderPickerData } from '../start/folder-picker.js';

const PICKER: Record<SharedSourceKind, FolderPickerData> = {
  styleguides: {
    title: 'Link shared style guides',
    subtitle: 'Choose the folder that holds global.md and the locale guides',
  },
  termbase: {
    title: 'Link a shared Term Base',
    subtitle: 'Choose the folder that holds termbase.csv',
  },
};

/**
 * The toolbar control that links the style guides or the Term Base to a folder
 * outside the project — typically a checkout of a Git repository several
 * projects share (`apps/server/src/lib/shared-sources.ts`).
 *
 * A link replaces the project's own files while it is set, and is stored on
 * this machine only. The page reloads itself on `changed`; the server also
 * announces the change, so a second tab follows.
 */
@Component({
  selector: 'lx-shared-source-control',
  imports: [LxBadge, LxButton],
  template: `
    @if (linked()) {
      <lx-badge tone="accent" size="xs" [attr.title]="path()">Shared</lx-badge>
    }
    @if (linked() && !available()) {
      <span class="missing" role="status">Shared folder missing</span>
    }
    <button
      lx-button
      type="button"
      variant="neutral"
      size="xs"
      [disabled]="busy()"
      [attr.title]="linked() ? 'Link a different shared folder' : null"
      (click)="pick()"
    >
      {{ linked() ? 'Change…' : 'Link shared folder…' }}
    </button>
    @if (linked()) {
      <button
        lx-button
        type="button"
        variant="ghost"
        size="xs"
        [disabled]="busy()"
        [attr.title]="unlinkTitle()"
        (click)="set(null)"
      >
        Unlink
      </button>
    }
    @if (error(); as message) {
      <span class="missing" role="alert">{{ message }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--lx-sp-6);
    }
    .missing {
      color: var(--lx-warn-tint-fg);
      font-size: var(--lx-fs-11);
    }
  `,
})
export class LxSharedSourceControl {
  readonly #api = inject(SharedSourcesApi);
  readonly #modal = inject(LxModalService);

  readonly kind = input.required<SharedSourceKind>();
  /** The linked folder or file, for the badge's tooltip. */
  readonly path = input('');
  readonly linked = input(false);
  readonly available = input(true);

  readonly changed = output();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly unlinkTitle = computed(() =>
    this.kind() === 'termbase'
      ? 'Use this project’s own .lexi/termbase.csv again'
      : 'Use this project’s own .lexi/styleguides again',
  );

  protected pick(): void {
    const ref = this.#modal.open<LxFolderPicker, string>(LxFolderPicker, {
      data: PICKER[this.kind()],
    });
    ref.closed.subscribe((path) => {
      if (path) void this.set(path);
    });
  }

  protected async set(path: string | null): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.#api.put({ [this.kind()]: path });
      this.changed.emit();
    } catch (error) {
      this.error.set(messageOf(error, 'The shared folder could not be linked.'));
    } finally {
      this.busy.set(false);
    }
  }
}
