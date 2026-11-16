// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { isRtlLocale } from '@lexi/shared/constants';

import { shortPath } from '../../core/format-time.js';
import { PhraseCheckoutStore } from '../../core/stores/phrase-checkout-store.js';
import { LxButton, LxModalService } from '../../ui/index.js';
import { LxFolderPicker } from '../start/folder-picker.js';

/**
 * S18 step 3: where the project goes, which target locales it gets, and a
 * preview of the files that will be written.
 */
@Component({
  selector: 'lx-step-destination',
  imports: [LxButton],
  template: `
    <div class="col">
      <section class="group">
        <h2 class="label">Location</h2>
        <div class="field">
          <span class="field__label" id="parent-label">
            Parent folder
            @if (store.parentFromLastUse()) {
              <span class="muted-2">last used</span>
            }
          </span>
          <div class="parent">
            <span class="input input--ro mono" aria-labelledby="parent-label">
              {{ store.parentDir() ? short(store.parentDir()!) : '…' }}
            </span>
            <button lx-button type="button" size="sm" class="choose" (click)="choose()">
              Choose…
            </button>
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="folder-name">Project folder</label>
          <input
            id="folder-name"
            class="input mono"
            spellcheck="false"
            autocomplete="off"
            [class.input--bad]="store.folderError() !== null"
            [attr.aria-invalid]="store.folderError() !== null"
            [attr.aria-describedby]="'folder-hint'"
            [value]="store.folderName()"
            (input)="store.setFolderName($any($event.target).value)"
            (change)="store.validateFolder()"
          />
          @if (store.folderError(); as message) {
            <p class="error" id="folder-hint" role="alert">{{ message }}</p>
          } @else {
            <p class="hint" id="folder-hint">
              Defaults to the project and its tags. The folder doesn’t exist yet and will be
              created.
            </p>
          }
        </div>
      </section>

      <section class="group">
        <div class="label-row">
          <h2 class="label">Target locales</h2>
          <span class="count">
            {{ store.selectedLocales().length }} of {{ store.targetLocales().length }}
          </span>
          <span class="links push">
            <button type="button" class="link" (click)="store.selectAllLocales()">
              Select all
            </button>
            <button type="button" class="link" (click)="store.selectNoLocales()">None</button>
          </span>
        </div>
        <p class="hint">
          From the Phrase project. Base locale
          <span class="mono base">{{ store.baseLocale() }}</span> is always included.
        </p>
        @if (store.detail() === null) {
          @if (store.loadError(); as message) {
            <p class="error" role="alert">{{ message }}</p>
          } @else {
            <p class="hint">Loading the project’s locales…</p>
          }
        }
        <div class="locales">
          @for (locale of store.targetLocales(); track locale.code) {
            @let on = store.isLocaleOn(locale.code);
            <button
              type="button"
              role="checkbox"
              class="loc"
              [class.loc--on]="on"
              [attr.aria-checked]="on"
              (click)="store.toggleLocale(locale.code)"
            >
              <span class="box" aria-hidden="true">{{ on ? '✓' : '' }}</span>
              <span class="loc__code">{{ locale.code }}</span>
              <span class="loc__name">{{ locale.name }}</span>
              @if (rtl(locale.code)) {
                <span class="rtl mono">RTL</span>
              }
            </button>
          }
        </div>
        @if (store.localesError(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
      </section>
    </div>

    <section class="col">
      <h2 class="label">Will be created</h2>
      <div class="panel">
        <div class="tree__root mono">{{ short(store.targetPath()) }}/</div>
        @for (file of files(); track file.name) {
          <div class="file">
            <span class="file__name mono" [attr.data-kind]="file.kind">{{ file.name }}</span>
            <span class="kind mono" [attr.data-kind]="file.kind">{{ file.kind }}</span>
            <span class="file__meta">{{ file.meta }}</span>
          </div>
        }
        <p class="foot">
          Phrase key names become unit ids. Key descriptions are kept as
          <span class="mono note">&lt;note&gt;</span>. File layout and locale mapping follow the
          usual setup, so no wizard step is needed.
        </p>
      </div>
    </section>
  `,
  styleUrls: ['./checkout-shared.css'],
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--lx-sp-24);
      max-width: 1080px;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-20);
      min-width: 0;
    }
    section.col {
      gap: var(--lx-sp-10);
    }
    .group {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-10);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
    }
    .field__label {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-11-5);
    }
    .muted-2 {
      color: var(--lx-text-faint-2);
    }
    .parent {
      display: flex;
      gap: var(--lx-sp-8);
    }
    .input {
      box-sizing: border-box;
      height: 34px;
      padding: 0 var(--lx-sp-12);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-titlebar);
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-12);
      outline: none;
    }
    .input:focus {
      border-color: var(--lx-accent);
    }
    .input--ro {
      display: flex;
      flex: 1;
      align-items: center;
      min-width: 0;
      overflow: hidden;
      color: var(--lx-text-secondary);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .input--bad,
    .input--bad:focus {
      border-color: var(--lx-danger-tint-border);
    }
    .choose {
      height: 34px;
    }
    .hint {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .base {
      color: var(--lx-text-mono);
    }
    .links {
      display: flex;
      gap: var(--lx-sp-12);
    }
    .locales {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--lx-sp-6);
    }
    .loc {
      display: flex;
      gap: var(--lx-sp-10);
      align-items: center;
      height: 36px;
      padding: 0 var(--lx-sp-12);
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-titlebar);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .loc--on {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
    }
    .loc:focus-visible {
      outline: none;
      box-shadow: var(--lx-ring-focus);
    }
    .box {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 15px;
      height: 15px;
      border: 1px solid var(--lx-neutral-border-strong);
      border-radius: var(--lx-r-4);
      color: var(--lx-accent-on);
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
    }
    .loc--on .box {
      border-color: var(--lx-accent);
      background: var(--lx-accent);
    }
    .loc__code {
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-600);
    }
    .loc__name {
      overflow: hidden;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-11-5);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rtl {
      padding: 0 var(--lx-sp-4);
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-3);
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-9-5);
    }
    .tree__root {
      padding: var(--lx-sp-12) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-section);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12);
      overflow-wrap: anywhere;
    }
    .file {
      display: grid;
      grid-template-columns: 180px 56px minmax(0, 1fr);
      gap: var(--lx-sp-12);
      align-items: center;
      padding: var(--lx-sp-8) var(--lx-sp-16) var(--lx-sp-8) 30px;
      border-bottom: 1px solid var(--lx-border-row);
    }
    .file__name {
      overflow: hidden;
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-12);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file__name[data-kind='base'] {
      color: var(--lx-text-primary);
    }
    .file__name[data-kind='origin'] {
      color: var(--lx-text-subtle);
    }
    .kind {
      justify-self: start;
      padding: 0 5px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-3);
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-9-5);
    }
    .kind[data-kind='base'] {
      border-color: var(--lx-accent-tint-border);
      color: var(--lx-accent-on-tint);
    }
    .file__meta {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .foot {
      margin: 0;
      padding: var(--lx-sp-12) var(--lx-sp-16);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
      line-height: 1.6;
    }
    .note {
      color: var(--lx-text-muted);
    }
  `,
})
export class LxStepDestination {
  protected readonly store = inject(PhraseCheckoutStore);
  readonly #modal = inject(LxModalService);

  protected readonly files = computed(() => {
    const keys = this.store.keysText();
    const base = this.store.baseLocale();
    return [
      { name: 'messages.xlf', kind: 'base', meta: `${base} · ${keys} units with base text` },
      ...this.store.selectedLocales().map((code) => ({
        name: `messages.${code}.xlf`,
        kind: 'target',
        meta: `${code} · ${keys} units · state="new"`,
      })),
      { name: '.lexi/phrase.json', kind: 'origin', meta: 'project id, scope, key ids · no token' },
    ];
  });

  protected short(path: string): string {
    return shortPath(path);
  }

  protected rtl(code: string): boolean {
    return isRtlLocale(code);
  }

  protected choose(): void {
    const ref = this.#modal.open<LxFolderPicker, string>(LxFolderPicker, {
      data: {
        title: 'Choose a parent folder',
        subtitle: 'The project folder is created inside it',
      },
    });
    ref.closed.subscribe((path) => {
      if (!path) return;
      this.store.setParentDir(path);
      void this.store.validateFolder();
    });
  }
}
