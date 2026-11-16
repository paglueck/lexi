// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import type { LlmProbe, LlmSettings, Settings, SettingsPatch } from '@lexi/shared';
import { isLlmConfigured, type EditorMode } from '@lexi/shared/constants';

import { SettingsApi } from '../api/settings-api.js';

/**
 * The machine settings, as the whole app sees them (S7).
 *
 * One `load()` per session, shared by the settings screen and by S1's
 * environment panel — which is why this is a root store rather than page state:
 * the start screen has to answer "is a model configured?" before the settings
 * screen has ever been opened.
 *
 * Patching is a commit, not a keystroke. The page sends a
 * field when the user leaves it, and the response — never the local edit — is
 * what lands in the signal, so what is displayed is always what was stored.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  readonly #api = inject(SettingsApi);

  readonly #settings = signal<Settings | null>(null);
  readonly #loaded = signal(false);
  readonly #saving = signal(false);
  readonly #testing = signal(false);
  readonly #error = signal<string | null>(null);

  readonly settings = this.#settings.asReadonly();
  readonly loaded = this.#loaded.asReadonly();
  readonly saving = this.#saving.asReadonly();
  readonly testing = this.#testing.asReadonly();
  /** The last rejected patch, in the server's words. Cleared by the next one. */
  readonly error = this.#error.asReadonly();
  readonly #loadFailed = signal(false);
  /**
   * The first read failed. Kept apart from `error()`, which is about the last
   * PATCH: a screen that could not load its settings is showing defaults, and
   * has to say so rather than let someone "change" a value that was never read.
   */
  readonly loadFailed = this.#loadFailed.asReadonly();

  readonly llm = computed<LlmSettings | null>(() => this.#settings()?.llm ?? null);
  readonly probe = computed<LlmProbe | null>(() => this.#settings()?.lastProbe ?? null);
  /**
   * `LxSegmentEditor`'s rendering mode, everywhere the editor appears — the
   * grid's detail panel and Focus mode both read this rather than each
   * carrying their own default.
   */
  readonly editorMode = computed<EditorMode>(() => this.#settings()?.editorMode ?? 'chips');

  /** An endpoint AND a model: either alone cannot produce a translation. */
  readonly configured = computed(() => {
    const llm = this.llm();
    return llm !== null && isLlmConfigured(llm);
  });

  #inFlight: Promise<Settings | null> | null = null;

  /** Idempotent: several screens ask on boot and one request answers them all. */
  async load(): Promise<Settings | null> {
    if (this.#settings() !== null) return this.#settings();
    this.#inFlight ??= this.#api
      .get()
      .then((settings) => {
        this.#settings.set(settings);
        this.#loadFailed.set(false);
        return settings;
      })
      .catch(() => {
        this.#loadFailed.set(true);
        return null;
      })
      .finally(() => {
        this.#loaded.set(true);
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  /**
   * Read again, after something other than a patch changed the settings on
   * the server — a Phrase checkout remembers its parent folder, the token
   * routes change `phrase.tokens`.
   */
  async reload(): Promise<void> {
    try {
      this.#settings.set(await this.#api.get());
    } catch {
      // Keep what is shown; the next load or patch replaces it.
    }
  }

  /**
   * Apply a patch. Returns false when the server refused it, having put the
   * reason in `error()` — a rejected base URL is ordinary traffic on this
   * screen, not an exception.
   */
  async patch(patch: SettingsPatch): Promise<boolean> {
    this.#saving.set(true);
    this.#error.set(null);
    try {
      this.#settings.set(await this.#api.patch(patch));
      return true;
    } catch (error) {
      this.#error.set(messageOf(error));
      return false;
    } finally {
      this.#saving.set(false);
    }
  }

  /** "Test connection" (FR-6.3). The probe lands in `probe()` either way. */
  async test(): Promise<LlmProbe | null> {
    this.#testing.set(true);
    this.#error.set(null);
    try {
      const probe = await this.#api.test();
      const current = this.#settings();
      if (current !== null) this.#settings.set({ ...current, lastProbe: probe });
      return probe;
    } catch (error) {
      this.#error.set(messageOf(error));
      return null;
    } finally {
      this.#testing.set(false);
    }
  }
}

/**
 * The server's sentence, not "Http failure response for /api/settings: 400".
 *
 * Every failing endpoint answers with the same envelope (`ErrorEnvelopeSchema`),
 * and on this screen the message IS the feature: "missing its scheme" is what
 * tells the user what to type.
 */
function messageOf(error: unknown): string {
  const body = (error as { error?: unknown } | null)?.error;
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message === 'string' && message !== '') return message;
  return 'The setting could not be saved.';
}
