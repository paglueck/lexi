// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import {
  estimateTokens,
  GLOBAL_GUIDE_KEY,
  STYLEGUIDE_TEMPLATE_GLOBAL,
  styleGuideTemplateFor,
  type MarkdownPreviewResponse,
  type MdBlock,
  type StyleGuide,
  type StyleGuideSummary,
} from '@lexi/shared';

import { StyleguidesApi } from '../api/styleguides-api.js';
import { messageOf } from '../api/server-message.js';
import { SettingsStore } from './settings-store.js';

/**
 * S6's left two panes: which guide is open, what is in the editor, and what it
 * renders to (FR-5.1 … FR-5.5).
 *
 * Two things here are worth not re-deriving.
 *
 * **The token count is computed locally, not fetched.** `estimateTokens` lives
 * in `@lexi/shared/constants` precisely so the server's meter and this editor
 * cannot disagree, and a count that lags a keystroke by a round trip is a count
 * nobody watches. The PREVIEW is fetched, because parsing Markdown in the
 * browser would mean a second parser and — worse — an HTML string to inject.
 *
 * **The buffer is the truth while the user is typing, and the SERVER's answer
 * is the truth once they save.** Same rule as `SettingsStore`: a
 * save is a commit, not a keystroke, and what lands in the signal afterwards is
 * what was stored rather than what was typed.
 */
@Injectable({ providedIn: 'root' })
export class StyleguidesStore {
  readonly #api = inject(StyleguidesApi);
  readonly #settings = inject(SettingsStore);

  readonly #guides = signal<readonly StyleGuideSummary[]>([]);
  readonly #missing = signal<readonly string[]>([]);
  readonly #dir = signal('.lexi/styleguides');
  readonly #linked = signal(false);
  readonly #available = signal(true);
  readonly #changedOnDisk = signal(false);
  readonly #active = signal<string>(GLOBAL_GUIDE_KEY);
  readonly #open = signal<StyleGuide | null>(null);
  readonly #buffer = signal('');
  readonly #loaded = signal(false);
  readonly #saving = signal(false);
  readonly #error = signal<string | null>(null);

  readonly guides = this.#guides.asReadonly();
  readonly missing = this.#missing.asReadonly();
  readonly dir = this.#dir.asReadonly();
  /** True while the guides come from a shared folder; `available` is false when it is missing. */
  readonly linked = this.#linked.asReadonly();
  readonly available = this.#available.asReadonly();
  /**
   * The shared folder changed on disk while the editor held unsaved text, so
   * the open guide was NOT reloaded. The page offers the reload instead.
   */
  readonly changedOnDisk = this.#changedOnDisk.asReadonly();
  readonly active = this.#active.asReadonly();
  readonly open = this.#open.asReadonly();
  readonly buffer = this.#buffer.asReadonly();
  readonly loaded = this.#loaded.asReadonly();
  readonly saving = this.#saving.asReadonly();
  readonly error = this.#error.asReadonly();

  /** `global.md`, `de.md` — the mono path S6 prints on the right of the bar. */
  readonly path = computed(() => `${this.#dir()}/${this.#open()?.name ?? ''}`);

  readonly dirty = computed(() => this.#buffer() !== (this.#open()?.text ?? ''));

  /** Live, local, and the same function the server's meter uses. */
  readonly tokens = computed(() => estimateTokens(this.#buffer()));

  /**
   * The guide plus its global partner against the model's context window.
   *
   * The pair is the right unit: a locale guide is never sent alone, and the
   * failure FR-5.4 exists to prevent is silent — a model handed more than its
   * window simply drops the beginning of what it was told, and the drafts come
   * back subtly unsteered rather than obviously broken.
   */
  readonly budget = computed(() => {
    const window = this.#settings.llm()?.params.contextWindow ?? 8192;
    const globalTokens =
      this.#active() === GLOBAL_GUIDE_KEY
        ? 0
        : (this.#guides().find((g) => g.key === GLOBAL_GUIDE_KEY)?.tokens ?? 0);
    const total = this.tokens() + globalTokens;
    return { total, window, over: total > window };
  });

  /** True only for a guide that has never been written — see `StyleGuide.exists`. */
  readonly canSeed = computed(() => this.#open()?.exists === false && this.#buffer().trim() === '');

  /** FR-5.6's starter template for whichever guide is open. */
  readonly template = computed(() =>
    this.#active() === GLOBAL_GUIDE_KEY
      ? STYLEGUIDE_TEMPLATE_GLOBAL
      : styleGuideTemplateFor(this.#active()),
  );

  /**
   * The rendered preview.
   *
   * `httpResource` rather than an awaited call, for the reason the detail panel
   * uses one: typing fires a request per debounce tick and only the last one's
   * answer should ever be on screen. An awaited call would race and the pane
   * would settle on whichever render happened to finish last.
   */
  readonly preview = httpResource<MarkdownPreviewResponse>(() => ({
    url: '/api/markdown/preview',
    method: 'POST',
    body: { text: this.#debounced() },
  }));

  readonly blocks = computed<readonly MdBlock[]>(() => this.preview.value()?.blocks ?? []);

  readonly #debounced = signal('');
  #timer: ReturnType<typeof setTimeout> | null = null;

  async load(): Promise<void> {
    await this.#refreshList();
    await this.select(this.#active());
    this.#loaded.set(true);
  }

  /**
   * The linked folder changed on disk (`shared-source-changed`). The list is
   * always refreshed; the open guide only when nothing is being typed into it,
   * because a `git pull` in the shared repository must not eat an edit.
   */
  async onDiskChange(): Promise<void> {
    await this.#refreshList();
    if (this.dirty()) this.#changedOnDisk.set(true);
    else await this.select(this.#active());
  }

  /** Open a guide. An unsaved buffer is NOT carried across — see `dirty`. */
  async select(key: string): Promise<void> {
    this.#active.set(key);
    this.#changedOnDisk.set(false);
    this.#error.set(null);
    try {
      const guide = await this.#api.get(key);
      this.#open.set(guide);
      this.#setBuffer(guide.text);
    } catch (error) {
      this.#error.set(messageOf(error, 'That style guide could not be opened.'));
    }
  }

  edit(text: string): void {
    this.#setBuffer(text);
  }

  /** Put the starter template in the editor. Not saved until the user saves. */
  seed(): void {
    this.#setBuffer(this.template());
  }

  async save(): Promise<boolean> {
    if (!this.dirty()) return true;
    this.#saving.set(true);
    this.#error.set(null);
    try {
      const guide = await this.#api.save(this.#active(), this.#buffer());
      this.#changedOnDisk.set(false);
      this.#open.set(guide);
      this.#setBuffer(guide.text);
      await this.#refreshList();
      return true;
    } catch (error) {
      this.#error.set(messageOf(error, 'The style guide could not be saved.'));
      return false;
    } finally {
      this.#saving.set(false);
    }
  }

  /**
   * Discard the edit and go back to what is on disk — re-read, when the shared
   * folder has changed since the guide was opened.
   */
  revert(): void {
    if (this.#changedOnDisk()) void this.select(this.#active());
    else this.#setBuffer(this.#open()?.text ?? '');
  }

  async remove(): Promise<void> {
    const key = this.#active();
    try {
      await this.#api.remove(key);
    } catch (error) {
      this.#error.set(messageOf(error, 'The style guide could not be deleted.'));
      return;
    }
    await this.#refreshList();
    await this.select(GLOBAL_GUIDE_KEY);
  }

  async #refreshList(): Promise<void> {
    try {
      const listing = await this.#api.list();
      this.#guides.set(listing.guides);
      this.#missing.set(listing.missing);
      this.#dir.set(listing.dir);
      this.#linked.set(listing.linked);
      this.#available.set(listing.available);
    } catch {
      // A listing that will not load is not worth a banner: the editor still
      // works on whichever guide is open, which is what the user came for.
      this.#guides.set([]);
      this.#missing.set([]);
    }
  }

  /**
   * 150 ms after the last keystroke, not on every one.
   *
   * The token count above is instant because it is local; only the render waits,
   * and a render is what costs a request.
   */
  #setBuffer(text: string): void {
    this.#buffer.set(text);
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#debounced.set(text);
      this.#timer = null;
    }, 150);
  }
}
