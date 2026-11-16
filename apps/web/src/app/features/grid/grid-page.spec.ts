// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { ChromeStore } from '../../core/stores/chrome-store.js';
import { CsvImportStore } from '../../core/stores/csv-import-store.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { GridSelectionStore } from '../../core/stores/grid-selection-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { HistoryActions } from '../../core/history-actions.js';
import { LxBadge } from '../../ui/badge.js';
import { LxButton } from '../../ui/button.js';
import { LxToolbar } from '../../ui/chrome/toolbar.js';
import { LxIcon } from '../../ui/icon.js';
import { LxMenu } from '../../ui/menu.js';
import { LxModalService } from '../../ui/modal.js';
import { GridPage } from './grid-page.js';

/**
 * The grid's toolbar entry to the CSV import. The page's stores are replaced by
 * a stand-in that answers every read with an empty list, and the rail, table
 * and detail panel are dropped: only the toolbar is under test.
 */
const quiet = (): object => new Proxy({}, { get: () => () => [] });

function mount() {
  const start = vi.fn();
  const busy = signal(false);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      ...[GridStore, UnitsStore, DraftStore, HistoryActions, EditSessionStore, GridSelectionStore, ChromeStore, LxModalService].map((token) => ({
        provide: token,
        useValue: quiet(),
      })),
      { provide: ProjectStore, useValue: { project: () => null, isOpen: () => false } },
      { provide: CsvImportStore, useValue: { start, error: () => null, busy } },
    ],
  });
  TestBed.overrideComponent(GridPage, {
    set: {
      imports: [LxToolbar, LxButton, LxBadge, LxIcon, LxMenu],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    },
  });
  const fixture = TestBed.createComponent(GridPage);
  fixture.detectChanges();
  const buttons = () => [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')];
  const label = (b: Element) => (b.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { fixture, busy, buttons, label };
}

describe('GridPage toolbar', () => {
  it('offers "Import CSV…" before "Translate..."', () => {
    const { buttons, label } = mount();
    const labels = buttons().map(label);
    const at = labels.indexOf('Import CSV…');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(labels.indexOf('Translate...'));
  });

  it('disables "Import CSV…" while a pick is being previewed', () => {
    const { fixture, busy, buttons, label } = mount();
    const importButton = () => buttons().find((b) => label(b) === 'Import CSV…')!;
    expect(importButton().disabled).toBe(false);
    busy.set(true);
    fixture.detectChanges();
    expect(importButton().disabled).toBe(true);
  });
});

describe('GridPage locale menu', () => {
  const press = (target: EventTarget) =>
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

  it('closes on a press outside the menu and its button, not inside', () => {
    const { fixture } = mount();
    const root = fixture.nativeElement as HTMLElement;
    const menu = () => root.querySelector('.cols .menu');
    root.querySelector<HTMLButtonElement>('.cols button[aria-expanded]')!.click();
    fixture.detectChanges();
    expect(menu()).not.toBeNull();

    press(menu()!);
    fixture.detectChanges();
    expect(menu()).not.toBeNull();

    press(document.body);
    fixture.detectChanges();
    expect(menu()).toBeNull();
  });
});
