// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type { UnitCreateResponse } from '@lexi/shared';
import { UNIT_ID_PATTERN } from '@lexi/shared/constants';

import { UnitsApi } from '../../core/api/units-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { LxButton } from '../../ui/button.js';
import { LxField, LxInput } from '../../ui/field.js';
import { LxModalShell } from '../../ui/modal.js';

export interface CreateUnitModalData {
  /** The file group the key goes into, e.g. `messages`. */
  readonly group: string;
  /** That group's source file, relative to the project root — shown, not sent. */
  readonly sourceFile: string;
}

/**
 * The grid's "New key…". Like "Delete key…" it writes to disk at once — the
 * `<trans-unit>` lands in the source file when Create is pressed — so the modal
 * makes the call itself and stays open on a refusal (an id the group already
 * has, a file changed on disk), showing the server's own sentence. It resolves
 * the response, or undefined when cancelled.
 */
@Component({
  selector: 'lx-create-unit-modal',
  imports: [LxButton, LxField, LxInput, LxModalShell],
  template: `
    <lx-modal-shell title="New key" [subtitle]="data.sourceFile">
      <div class="fields">
        <lx-field label="ID" hint="The trans-unit id, e.g. checkout.payButton. No spaces.">
          <input
            lxInput
            class="lx-mono"
            autocomplete="off"
            spellcheck="false"
            [value]="unitId()"
            (input)="unitId.set($any($event.target).value); error.set(null)"
          />
        </lx-field>
        @if (idError(); as message) {
          <p class="err" role="alert">{{ message }}</p>
        }

        <lx-field label="Source text" hint="Plain text. Placeholders cannot be added here.">
          <textarea
            lxInput
            rows="2"
            [value]="source()"
            (input)="source.set($any($event.target).value)"
          ></textarea>
        </lx-field>

        <lx-field label="Description" optional hint='Written as note from="description".'>
          <input
            lxInput
            autocomplete="off"
            [value]="description()"
            (input)="description.set($any($event.target).value)"
          />
        </lx-field>

        <lx-field label="Meaning" optional hint='Written as note from="meaning".'>
          <input
            lxInput
            autocomplete="off"
            [value]="meaning()"
            (input)="meaning.set($any($event.target).value)"
          />
        </lx-field>

        <p class="body">
          The key is written to the source file <strong>right away</strong>. Translations are then
          added in the grid and saved as usual.
        </p>

        @if (error(); as message) {
          <p class="err" role="alert">{{ message }}</p>
        }
      </div>

      <span modal-footer class="lx-spacer"></span>
      <button type="button" modal-footer lx-button size="field" (click)="ref.close()">
        Cancel
      </button>
      <button
        type="button"
        modal-footer
        lx-button
        variant="primary"
        size="field"
        [disabled]="!valid() || saving()"
        (click)="create()"
      >
        {{ saving() ? 'Creating…' : 'Create key' }}
      </button>
    </lx-modal-shell>
  `,
  styles: `
    .fields {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-14);
    }
    .body {
      margin: 0;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
    }
    .err {
      margin: 0;
      color: var(--lx-danger-on-tint);
      font-size: var(--lx-fs-11-5);
    }
  `,
})
export class LxCreateUnitModal {
  protected readonly ref = inject<DialogRef<UnitCreateResponse, LxCreateUnitModal>>(DialogRef);
  protected readonly data = inject<CreateUnitModalData>(DIALOG_DATA);
  readonly #api = inject(UnitsApi);

  protected readonly unitId = signal('');
  protected readonly source = signal('');
  protected readonly description = signal('');
  protected readonly meaning = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Only once something was typed: an empty field is not yet a mistake. */
  protected readonly idError = computed(() => {
    const id = this.unitId().trim();
    return id !== '' && !UNIT_ID_PATTERN.test(id) ? 'The ID cannot contain spaces.' : null;
  });

  protected readonly valid = computed(
    () => UNIT_ID_PATTERN.test(this.unitId().trim()) && this.source().trim() !== '',
  );

  protected async create(): Promise<void> {
    if (!this.valid() || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const description = this.description().trim();
      const meaning = this.meaning().trim();
      const res = await this.#api.createUnit({
        unitId: this.unitId().trim(),
        group: this.data.group,
        source: this.source(),
        ...(description === '' ? {} : { description }),
        ...(meaning === '' ? {} : { meaning }),
      });
      this.ref.close(res);
    } catch (error) {
      this.error.set(messageOf(error, 'The key could not be created.'));
    } finally {
      this.saving.set(false);
    }
  }
}
