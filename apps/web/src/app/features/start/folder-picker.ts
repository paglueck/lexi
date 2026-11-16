// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type { FsEntry } from '@lexi/shared';

import { ProjectApi } from '../../core/api/project-api.js';
import { LxButton, LxIcon, LxModalShell } from '../../ui/index.js';

/** Passed as dialog data when the picker chooses something other than a project. */
export interface FolderPickerData {
  readonly title: string;
  readonly subtitle: string;
}

/**
 * "Open folder…" — the in-app directory browser.
 *
 * DEVIATION from the handoff, which specifies a native directory picker. A page
 * served over localhost has no such dialog: `showDirectoryPicker` is
 * Chromium-only and gives the BROWSER a handle, not the server, which is the
 * process that has to read the files. So the server offers the tree through
 * `/api/fs/browse` and this is its client. The jail is enforced there, not here
 * — the roots are granted out of band, at boot.
 *
 * Marked for the designer review together with the other deviations.
 *
 * Also picks the shared style guide or Term Base folder: `FolderPickerData`
 * changes the title, and the XLIFF count is only shown when opening a project.
 */
@Component({
  selector: 'lx-folder-picker',
  imports: [LxModalShell, LxButton, LxIcon],
  template: `
    <lx-modal-shell [title]="data?.title ?? 'Open a project'" [subtitle]="path() || choose">
      <div class="crumbs">
        <button
          lx-button
          variant="neutral"
          size="xs"
          type="button"
          [disabled]="parent() === null"
          (click)="up()"
        >
          <lx-icon name="arrow-up" [size]="12" />
          Up
        </button>
        @for (root of roots(); track root) {
          <button lx-button variant="neutral" size="xs" type="button" (click)="browse(root)">
            {{ label(root) }}
          </button>
        }
      </div>

      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }

      <!-- A plain list of buttons: role=listbox would promise option children
           and arrow-key selection, which a list of links into folders is not. -->
      <ul class="entries" aria-label="Folders">
        @for (entry of dirs(); track entry.path) {
          <li>
            <button class="entry" type="button" (click)="browse(entry.path)">
              <lx-icon class="entry__glyph" name="folder" [size]="13" />
              <span class="entry__name">{{ entry.name }}</span>
            </button>
          </li>
        } @empty {
          <li class="empty">No sub-folders here.</li>
        }
      </ul>

      @if (data === null) {
        <p class="found lx-caption">
          @if (xliffCount() > 0) {
            {{ xliffCount() }} XLIFF file{{ xliffCount() === 1 ? '' : 's' }} in this folder
          } @else {
            No .xlf files directly in this folder
          }
        </p>
      }

      <div modal-footer class="foot">
        <button lx-button variant="secondary" size="md" type="button" (click)="ref.close()">
          Cancel
        </button>
        <button
          lx-button
          variant="primary"
          size="md"
          type="button"
          [disabled]="path() === ''"
          (click)="ref.close(path())"
        >
          Use this folder
        </button>
      </div>
    </lx-modal-shell>
  `,
  styleUrl: './folder-picker.css',
})
export class LxFolderPicker {
  readonly ref = inject<DialogRef<string, LxFolderPicker>>(DialogRef);
  protected readonly data = inject<FolderPickerData | null>(DIALOG_DATA, { optional: true });
  protected readonly choose = this.data?.subtitle ?? 'Choose a folder';
  readonly #api = inject(ProjectApi);

  protected readonly roots = signal<readonly string[]>([]);
  protected readonly path = signal('');
  protected readonly parent = signal<string | null>(null);
  protected readonly entries = signal<readonly FsEntry[]>([]);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.#init();
  }

  protected dirs(): readonly FsEntry[] {
    return this.entries().filter((e) => e.kind !== 'file');
  }

  /** The signal that this folder is the one: it actually holds .xlf files. */
  protected xliffCount(): number {
    return this.entries().filter((e) => e.isXliff).length;
  }

  protected label(root: string): string {
    return root.split('/').filter(Boolean).at(-1) ?? root;
  }

  protected up(): void {
    const parent = this.parent();
    if (parent !== null) void this.browse(parent);
  }

  protected async browse(path: string): Promise<void> {
    try {
      const res = await this.#api.browse(path);
      this.path.set(res.path);
      this.parent.set(res.parent);
      this.entries.set(res.entries);
      this.error.set(null);
    } catch {
      // The jail refuses rather than explains, which is correct. Say something
      // true and unhelpful rather than something specific and wrong.
      this.error.set('That folder is outside the folders Lexi was given access to.');
    }
  }

  async #init(): Promise<void> {
    const { roots } = await this.#api.roots();
    this.roots.set(roots.map((r) => r.path));
    const first = roots[0]?.path;
    if (first !== undefined) await this.browse(first);
  }
}
