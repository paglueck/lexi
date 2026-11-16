// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { ThemeMode } from '@lexi/shared/constants';

import { SettingsStore } from './settings-store.js';

export type { ThemeMode };
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'lexi.theme';

/**
 * Theme selection, and S7's Appearance pane (M8's first consumer of it).
 *
 * **Two stores on purpose, with one of them authoritative.** The durable record
 * is `~/.lexi/settings.json` through `GET/PATCH /api/settings`, which is what
 * makes the choice survive a cleared browser profile. `localStorage` stays as
 * well, because the theme has to be on `<html>` BEFORE first paint and the
 * inline script in `index.html` that does it cannot await a fetch — a server
 * round trip there would mean a dark flash on every load in the light theme.
 *
 * So: localStorage is the pre-paint cache, the server is the record, and they
 * are written together. On boot, a stored local choice wins (it is what the
 * page has already painted, and re-painting to argue with it would be worse
 * than a stale setting); the server's choice is adopted only when this browser
 * has none — which is exactly the new-profile case the server copy exists for.
 */
@Injectable({ providedIn: 'root' })
export class ThemeStore {
  readonly #settings = inject(SettingsStore);

  readonly #mode = signal<ThemeMode>(readStoredMode() ?? 'system');
  readonly #system = signal<ResolvedTheme>(systemTheme());

  readonly mode = this.#mode.asReadonly();
  readonly resolved = computed<ResolvedTheme>(() => {
    const m = this.#mode();
    return m === 'system' ? this.#system() : m;
  });

  constructor() {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener('change', (e) => this.#system.set(e.matches ? 'light' : 'dark'));

    effect(() => {
      document.documentElement.setAttribute('data-theme', this.resolved());
    });

    if (readStoredMode() === null) void this.#adoptStored();
  }

  set(mode: ThemeMode): void {
    this.#mode.set(mode);
    writeStoredMode(mode);
    // Fire and forget: the theme has already applied, and a failed patch means
    // one machine keeps its own preference rather than one screen going wrong.
    void this.#settings.patch({ theme: mode });
  }

  toggle(): void {
    this.set(this.resolved() === 'dark' ? 'light' : 'dark');
  }

  /** This browser has no stored choice: take the machine's, if it has one. */
  async #adoptStored(): Promise<void> {
    const settings = await this.#settings.load();
    if (settings === null || settings.theme === 'system') return;
    this.#mode.set(settings.theme);
    writeStoredMode(settings.theme);
  }
}

/** `null` means "this browser has never been told", which is not the same as "system". */
function readStoredMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    // 'system' is written rather than removed, so "I chose to follow the
    // system" is distinguishable from "nobody has chosen anything" — the
    // distinction #adoptStored turns on. The inline pre-paint script already
    // treats any value that is not dark/light as "follow the system".
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private window or blocked site data: the theme still applies for this
    // session, and the server copy still records the choice.
  }
}

function systemTheme(): ResolvedTheme {
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
