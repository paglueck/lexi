// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '@lexi/shared';

import { ProjectApi } from '../../core/api/project-api.js';
import { ProjectActions } from '../../core/project-actions.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { StartPage } from './start-page.js';

/**
 * S17's states: a first run, a last project whose folder is gone, a Recent
 * list that is empty or carries a Phrase badge, the launch toggle and ↵.
 * Opening itself is `ProjectActions.openPath`, faked here and tested in its
 * own spec.
 */

const recent = (over: Partial<RecentProject> = {}): RecentProject => ({
  id: 'r1',
  path: '/Users/x/dev/northwind',
  name: 'northwind',
  openedAt: new Date().toISOString(),
  localeCount: 10,
  unitCount: 4812,
  coverage: { translated: 50, draft: 10, needsReview: 5 },
  exists: true,
  ...over,
});

async function mount(recents: RecentProject[]) {
  const api = {
    recents: vi.fn().mockResolvedValue({ recents }),
    forgetRecent: vi.fn().mockResolvedValue(undefined),
    locateRecent: vi.fn(),
  };
  const actions = {
    openPath: vi.fn().mockResolvedValue(undefined),
    openFolder: vi.fn().mockResolvedValue(undefined),
    busy: signal<string | null>(null),
    openError: signal<string | null>(null),
    recentsChangedAt: signal(0),
  };
  const settings = {
    load: vi.fn().mockResolvedValue(null),
    settings: signal({ launch: { showMenu: true, lastParentDir: null } }),
    loaded: signal(true),
    loadFailed: signal(false),
    patch: vi.fn().mockResolvedValue(true),
  };

  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ProjectApi, useValue: api },
      { provide: ProjectActions, useValue: actions },
      { provide: ProjectStore, useValue: { version: signal('0.9.2') } },
      { provide: SettingsStore, useValue: settings },
    ],
  });
  const fixture = TestBed.createComponent(StartPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, api, actions, settings };
}

const titles = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.card__title')].map((t) => t.textContent?.trim() ?? '');

describe('StartPage (S17)', () => {
  it('hides Continue and Recent on a first run', async () => {
    const { el } = await mount([]);
    expect(titles(el)).toEqual(['Check out from Phrase', 'Open a project…']);
    expect(el.querySelector('.recent')).toBeNull();
    expect(el.textContent).toContain('v0.9.2');
  });

  it('continues with the newest project, and lists the rest with a Phrase badge', async () => {
    const { el, actions } = await mount([
      recent(),
      recent({
        id: 'r2',
        name: 'nw-checkout',
        path: '/p2',
        origin: { kind: 'phrase', tags: ['checkout-v2'] },
      }),
      recent({ id: 'r3', name: 'admin', path: '/p3' }),
    ]);
    expect(titles(el)[0]).toBe('Continue with northwind');
    expect(el.querySelector('.card__stats')?.textContent).toContain('4,812 units');
    expect(el.querySelector('.card__path')?.textContent?.trim()).toBe('~/dev/northwind');

    const rows = [...el.querySelectorAll<HTMLButtonElement>('.row')];
    expect(rows.map((r) => r.querySelector('.row__name')?.textContent)).toEqual([
      'nw-checkout',
      'admin',
    ]);
    expect(rows[0]?.querySelector('.row__badge')?.textContent).toContain('Phrase · checkout-v2');
    expect(rows[1]?.querySelector('.row__badge')).toBeNull();

    el.querySelector<HTMLButtonElement>('.card--primary')!.click();
    expect(actions.openPath).toHaveBeenCalledWith('/Users/x/dev/northwind');
    rows[1]!.click();
    expect(actions.openPath).toHaveBeenCalledWith('/p3');
  });

  it('labels the Phrase badge by what was checked out', async () => {
    const { el } = await mount([
      recent(),
      recent({ id: 'r2', path: '/p2', origin: { kind: 'phrase', tags: [] } }),
      recent({ id: 'r3', path: '/p3', origin: { kind: 'phrase', tags: ['release'] } }),
      recent({
        id: 'r4',
        path: '/p4',
        origin: { kind: 'phrase', tags: ['checkout-v2', 'release', 'roles'] },
      }),
    ]);
    const badges = [...el.querySelectorAll<HTMLElement>('.row__badge')];
    expect(badges.map((b) => b.textContent?.trim())).toEqual([
      'Phrase · all keys',
      'Phrase · release',
      'Phrase · 3 tags',
    ]);
    expect(badges[0]?.getAttribute('title')).toBeNull();
    expect(badges[1]?.getAttribute('title')).toBeNull();
    expect(badges[2]?.getAttribute('title')).toBe('checkout-v2, release, roles');
  });

  it('hides Recent when the last project is the only one', async () => {
    const { el } = await mount([recent()]);
    expect(el.querySelector('.recent')).toBeNull();
  });

  it('offers Locate and Remove when the last folder is gone, and ↵ does nothing', async () => {
    const { fixture, el, api, actions } = await mount([recent({ exists: false })]);
    expect(el.querySelector('.card__missing')?.textContent).toContain('Folder not found');
    expect(el.querySelector('.card__stats')).toBeNull();

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.openPath).not.toHaveBeenCalled();

    const remove = [...el.querySelectorAll<HTMLButtonElement>('.card__fix button')].find((b) =>
      b.textContent?.includes('Remove from recent'),
    )!;
    remove.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.forgetRecent).toHaveBeenCalledWith('r1');
    expect(titles(el)[0]).toBe('Check out from Phrase');
  });

  it('continues on ↵', async () => {
    const { actions } = await mount([recent()]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(actions.openPath).toHaveBeenCalledWith('/Users/x/dev/northwind');
  });

  it('turns the launch menu off through the settings patch', async () => {
    const { el, settings } = await mount([]);
    const toggle = el.querySelector<HTMLElement>('lx-toggle')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click();
    expect(settings.patch).toHaveBeenCalledWith({ showLaunchMenu: false });
  });
});
