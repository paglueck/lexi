// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import type { PhraseRegion, PhraseToken, PhraseTokenVerifyResponse } from '@lexi/shared';
import { PHRASE_HOSTS, PHRASE_REGIONS } from '@lexi/shared/constants';

import { PhraseTokensApi } from '../../core/api/phrase-tokens-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { relative } from '../../core/format-time.js';
import { noteOf } from '../../core/stores/phrase-checkout-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import {
  LxButton,
  LxModalService,
  LxSegmentedControl,
  type SegmentOption,
} from '../../ui/index.js';
import {
  LxPhraseTokenRemoveConfirm,
  type PhraseTokenRemoveData,
} from './phrase-token-remove-confirm.js';

/** `https://api.us.app.phrase.com/v2` -> `api.us.app.phrase.com`. */
export function hostOf(region: PhraseRegion): string {
  return new URL(PHRASE_HOSTS[region]).host;
}

/** A token must be at least this long before Verify is offered. */
const MIN_TOKEN_LENGTH = 8;

/**
 * S19 — Settings › Phrase: the saved access tokens.
 *
 * Secrets go up once (verify, save, replace) and never come back; the list
 * shows the last four characters. Secrets live in `~/.lexi/settings.json`
 * (0600) on this machine — not in a keychain, and never in a project.
 */
@Component({
  selector: 'lx-phrase-tokens',
  imports: [LxButton, LxSegmentedControl],
  templateUrl: './phrase-tokens.html',
  styleUrl: './phrase-tokens.css',
})
export class LxPhraseTokens {
  readonly #api = inject(PhraseTokensApi);
  readonly #modal = inject(LxModalService);
  readonly #settings = inject(SettingsStore);

  protected readonly REGION_OPTIONS: ReadonlyArray<SegmentOption<PhraseRegion>> =
    PHRASE_REGIONS.map((r) => ({ value: r, label: r }));
  protected readonly noteOf = noteOf;
  protected readonly hostOf = hostOf;

  protected readonly tokens = signal<readonly PhraseToken[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly checking = signal(false);

  protected readonly selected = computed<PhraseToken | null>(
    () => this.tokens().find((t) => t.id === this.selectedId()) ?? this.tokens()[0] ?? null,
  );
  /** The note being edited; follows the selected token. */
  protected readonly note = linkedSignal(() => this.selected()?.note ?? '');

  /* ---- replace secret ---- */
  protected readonly replacing = signal(false);
  protected readonly replacement = signal('');
  protected readonly replaceBusy = signal(false);

  /* ---- add form ---- */
  protected readonly adding = signal(false);
  protected readonly draftNote = signal('');
  protected readonly draftToken = signal('');
  protected readonly draftRegion = signal<PhraseRegion>('EU');
  protected readonly verifying = signal(false);
  protected readonly verified = signal<PhraseTokenVerifyResponse | null>(null);
  protected readonly saving = signal(false);

  protected readonly canVerify = computed(
    () => this.draftToken().trim().length >= MIN_TOKEN_LENGTH && !this.verifying(),
  );
  protected readonly canSave = computed(
    () => this.verified()?.ok === true && this.draftNote().trim() !== '' && !this.saving(),
  );
  protected readonly saveHint = computed(() => {
    if (this.verified()?.ok !== true) return 'Verify the token first.';
    if (this.draftNote().trim() === '') return 'Add a note so you can tell tokens apart.';
    return 'Stored in ~/.lexi on this machine.';
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const { tokens } = await this.#api.list();
      this.tokens.set(tokens);
      this.error.set(null);
    } catch (error) {
      this.error.set(messageOf(error, 'The saved Phrase tokens could not be read.'));
    } finally {
      this.loaded.set(true);
    }
  }

  protected select(id: string): void {
    this.selectedId.set(id);
    this.adding.set(false);
    this.replacing.set(false);
  }

  /* ---- detail ---- */

  protected saveNote(): void {
    const token = this.selected();
    const note = this.note().trim();
    if (token === null || note === token.note) return;
    void this.#update(this.#api.update(token.id, { note }));
  }

  protected setRegion(region: PhraseRegion): void {
    const token = this.selected();
    if (token === null || region === token.region) return;
    void this.#update(this.#api.update(token.id, { region }));
  }

  protected async checkAgain(): Promise<void> {
    const token = this.selected();
    if (token === null) return;
    this.checking.set(true);
    try {
      await this.#update(this.#api.check(token.id));
    } finally {
      this.checking.set(false);
    }
  }

  protected startReplace(): void {
    this.replacement.set('');
    this.replacing.set(true);
  }

  protected async saveReplacement(): Promise<void> {
    const token = this.selected();
    const secret = this.replacement().trim();
    if (token === null || secret.length < MIN_TOKEN_LENGTH) return;
    this.replaceBusy.set(true);
    try {
      if (await this.#update(this.#api.replaceSecret(token.id, secret))) {
        this.replacing.set(false);
        this.replacement.set('');
      }
    } finally {
      this.replaceBusy.set(false);
    }
  }

  protected remove(): void {
    const token = this.selected();
    if (token === null) return;
    const ref = this.#modal.open<LxPhraseTokenRemoveConfirm, boolean>(LxPhraseTokenRemoveConfirm, {
      data: { note: noteOf(token) } satisfies PhraseTokenRemoveData,
    });
    ref.closed.subscribe((yes) => {
      if (yes === true) void this.#remove(token.id);
    });
  }

  async #remove(id: string): Promise<void> {
    try {
      await this.#api.remove(id);
      this.tokens.update((list) => list.filter((t) => t.id !== id));
      this.selectedId.set(this.tokens()[0]?.id ?? null);
      this.error.set(null);
      void this.#settings.reload();
    } catch (error) {
      this.error.set(messageOf(error, 'The token could not be removed.'));
    }
  }

  /** Put the server's answer in the list. False when the server refused. */
  async #update(request: Promise<PhraseToken>): Promise<boolean> {
    try {
      const token = await request;
      this.tokens.update((list) => list.map((t) => (t.id === token.id ? token : t)));
      this.error.set(null);
      void this.#settings.reload();
      return true;
    } catch (error) {
      this.error.set(messageOf(error, 'The token could not be saved.'));
      return false;
    }
  }

  /* ---- add ---- */

  protected openAdd(): void {
    this.draftNote.set('');
    this.draftToken.set('');
    this.draftRegion.set('EU');
    this.verified.set(null);
    this.replacing.set(false);
    this.adding.set(true);
  }

  protected cancelAdd(): void {
    this.adding.set(false);
  }

  /** Editing the token or the region throws the verification away. */
  protected setDraftToken(value: string): void {
    this.draftToken.set(value);
    this.verified.set(null);
  }

  protected setDraftRegion(region: PhraseRegion): void {
    this.draftRegion.set(region);
    this.verified.set(null);
  }

  protected async verify(): Promise<void> {
    if (!this.canVerify()) return;
    const token = this.draftToken().trim();
    const region = this.draftRegion();
    this.verifying.set(true);
    try {
      const result = await this.#api.verify(token, region);
      // Only if nothing changed while Phrase was asked.
      if (this.draftToken().trim() === token && this.draftRegion() === region) {
        this.verified.set(result);
      }
    } catch (error) {
      this.verified.set({
        ok: false,
        detail: messageOf(error, 'Lexi could not ask Phrase.'),
        user: '',
        org: '',
        scopes: '',
        projects: [],
      });
    } finally {
      this.verifying.set(false);
    }
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    try {
      const token = await this.#api.create({
        note: this.draftNote().trim(),
        token: this.draftToken().trim(),
        region: this.draftRegion(),
      });
      this.tokens.update((list) => [...list, token]);
      this.selectedId.set(token.id);
      this.adding.set(false);
      this.error.set(null);
      void this.#settings.reload();
    } catch (error) {
      this.error.set(messageOf(error, 'The token could not be saved.'));
    } finally {
      this.saving.set(false);
    }
  }

  /* ---- display ---- */

  protected meta(token: PhraseToken): string {
    return [token.user, token.org].filter((s) => s !== '').join(' · ') || 'Not checked yet';
  }

  protected projectCount(n: number): string {
    return `${n} ${n === 1 ? 'project' : 'projects'}`;
  }

  protected when(iso: string | null): string {
    return relative(iso) || 'never';
  }

  protected projectNames(v: PhraseTokenVerifyResponse): string {
    return v.projects.map((p) => p.name).join(', ');
  }

  protected verifiedLine(v: PhraseTokenVerifyResponse): string {
    return ['Valid', v.user, v.org, v.scopes].filter((s) => s !== '').join(' · ');
  }
}
