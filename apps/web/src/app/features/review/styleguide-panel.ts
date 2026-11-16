// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { GLOBAL_GUIDE_KEY } from '@lexi/shared/constants';

import { StyleguidesApi } from '../../core/api/styleguides-api.js';

/**
 * FR-7.1's "style-guide reminders" — read-only, global then the locale
 * extension, collapsed by default so it does not crowd the target editor.
 *
 * Reads `StyleguidesApi` DIRECTLY rather than through the root-provided
 * `StyleguidesStore`: that store holds the Style Guides SCREEN's open-buffer
 * state (`active`, `buffer`, `dirty`), and calling `.select(locale)` on it from
 * here would silently change what the Style Guides settings screen shows next
 * time somebody opens it — a cross-feature side effect this panel must not have.
 */
@Component({
  selector: 'lx-styleguide-panel',
  template: `
    <details class="wrap">
      <summary class="lx-caption">Style guide reminders</summary>
      @if (loading()) {
        <p class="cap">Loading…</p>
      } @else {
        @if (global(); as g) {
          <section class="guide">
            <span class="lx-caption">Global</span>
            @if (g.exists && g.text.trim() !== '') {
              <p class="body">{{ g.text }}</p>
            } @else {
              <p class="cap">No global style guide written yet.</p>
            }
          </section>
        }
        @if (localeGuide(); as l) {
          <section class="guide">
            <span class="lx-caption">{{ locale() }}</span>
            @if (l.exists && l.text.trim() !== '') {
              <p class="body">{{ l.text }}</p>
            } @else {
              <p class="cap">No {{ locale() }} extension written yet.</p>
            }
          </section>
        }
      }
    </details>
  `,
  styles: `
    .wrap {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-8);
      padding: var(--lx-sp-12) var(--lx-sp-14);
      border: 1px solid var(--lx-border-row);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-rail);
    }
    summary {
      cursor: pointer;
      color: var(--lx-text-subtle);
    }
    .guide {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-4);
      margin-top: var(--lx-sp-8);
    }
    .body {
      margin: 0;
      white-space: pre-wrap;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-body);
    }
    .cap {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
  `,
})
export class LxStyleguidePanel {
  readonly #api = inject(StyleguidesApi);

  readonly locale = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly global = signal<{ readonly exists: boolean; readonly text: string } | null>(
    null,
  );
  protected readonly localeGuide = signal<{
    readonly exists: boolean;
    readonly text: string;
  } | null>(null);

  readonly #key = computed(() => this.locale());

  constructor() {
    effect(() => {
      const locale = this.#key();
      this.loading.set(true);
      void Promise.all([
        this.#api.get(GLOBAL_GUIDE_KEY).catch(() => ({ exists: false, text: '' })),
        this.#api.get(locale).catch(() => ({ exists: false, text: '' })),
      ]).then(([g, l]) => {
        this.global.set(g);
        this.localeGuide.set(l);
        this.loading.set(false);
      });
    });
  }
}
