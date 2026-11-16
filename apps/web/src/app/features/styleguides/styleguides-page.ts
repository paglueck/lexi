// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { GLOBAL_GUIDE_KEY, isRtlLocale } from '@lexi/shared/constants';

import { EventsStore } from '../../core/stores/events-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { StyleguidesStore } from '../../core/stores/styleguides-store.js';
import { messageOf } from '../../core/api/server-message.js';
import { LxButton } from '../../ui/button.js';
import { LxIcon } from '../../ui/icon.js';
import { LxMenu } from '../../ui/menu.js';
import { LxInput } from '../../ui/field.js';
import { LxSharedSourceControl } from '../shared-sources/shared-source-control.js';

/**
 * S6 — style guides (M10, FR-5.1 … FR-5.7).
 *
 * Two panes over `StyleguidesStore`, which owns which guide is open, the dirty
 * buffer and its live-rendered preview. The glossary that used to be the third
 * pane is the Term Base tab now (S13).
 *
 * The preview renders `StyleguidesStore.blocks()` — a typed `MdBlock[]` tree,
 * never HTML — straight through interpolation. There is no `[innerHTML]`
 * anywhere in this codebase and this screen does not start one: the worst a
 * pasted style guide can do here is look like angle brackets.
 */
@Component({
  selector: 'lx-styleguides-page',
  imports: [LxButton, LxIcon, LxInput, LxMenu, LxSharedSourceControl, NgTemplateOutlet],
  templateUrl: './styleguides-page.html',
  styleUrl: './styleguides-page.css',
})
export class StyleguidesPage {
  protected readonly store = inject(StyleguidesStore);
  protected readonly project = inject(ProjectStore);

  protected readonly GLOBAL_GUIDE_KEY = GLOBAL_GUIDE_KEY;

  protected readonly localesMenuOpen = signal(false);
  protected readonly armedGuideDelete = signal(false);

  /**
   * The tab that labels the panel — ids mirror the template's. Null for a
   * locale guide that has not been saved yet: it has no tab until it exists on
   * disk, and pointing `aria-labelledby` at a missing id names nothing.
   */
  protected readonly activeTabId = computed<string | null>(() => {
    const active = this.store.active();
    if (active === GLOBAL_GUIDE_KEY) return 'guide-tab-global';
    return this.store.guides().some((g) => g.key === active) ? `guide-tab-${active}` : null;
  });

  /**
   * A locale guide for Arabic is often written partly IN Arabic — examples of
   * the register it asks for — so the editor and the preview follow the
   * locale's direction. The global guide has no locale and stays LTR.
   */
  protected readonly guideDir = computed(() => {
    const active = this.store.active();
    return active !== GLOBAL_GUIDE_KEY && isRtlLocale(active) ? 'rtl' : null;
  });

  protected readonly previewError = computed(() => messageOf(this.store.preview.error(), ''));

  constructor() {
    void this.store.load();

    // A linked folder changed on disk. 0 is "never", not an event.
    const events = inject(EventsStore);
    effect(() => {
      if (events.sharedChangedAt().styleguides === 0) return;
      untracked(() => void this.store.onDiskChange());
    });
  }

  protected selectGuide(key: string): void {
    this.armedGuideDelete.set(false);
    void this.store.select(key);
  }

  /**
   * ←/→ (and Home/End) between guide tabs, selecting as focus moves — the WAI
   * "automatic activation" tab pattern, which suits tabs whose panels load in
   * milliseconds. Tab itself leaves the strip: only the active tab is a stop.
   */
  protected onTabKey(event: KeyboardEvent): void {
    const current = event.currentTarget as HTMLElement;
    const list = current.closest('[role="tablist"]');
    const tabs = list === null ? [] : [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = tabs.indexOf(current);
    if (index < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next]!.focus();
    tabs[next]!.click();
  }

  protected addLocale(locale: string): void {
    this.localesMenuOpen.set(false);
    void this.store.select(locale);
  }

  protected deleteGuide(): void {
    if (!this.armedGuideDelete()) {
      this.armedGuideDelete.set(true);
      return;
    }
    this.armedGuideDelete.set(false);
    void this.store.remove();
  }
}
