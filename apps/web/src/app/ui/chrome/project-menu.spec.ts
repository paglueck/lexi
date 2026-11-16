// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { ProjectActions, type PendingConfirm } from '../../core/project-actions.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { LxProjectMenu } from './project-menu.js';

/**
 * The title bar's project menu. `ProjectActions` is faked: what the menu owes
 * is "the right method for the row you clicked", and the methods themselves
 * have their own spec.
 */

function mount(over: { name?: string | null; pending?: PendingConfirm | null } = {}) {
  const actions = {
    reloadFromDisk: vi.fn().mockResolvedValue(undefined),
    rescan: vi.fn().mockResolvedValue(undefined),
    remap: vi.fn().mockResolvedValue(undefined),
    switchProject: vi.fn().mockResolvedValue(undefined),
    clearRecents: vi.fn().mockResolvedValue(undefined),
    confirmPending: vi.fn().mockResolvedValue(undefined),
    dismissConfirm: vi.fn(),
    pendingConfirm: signal<PendingConfirm | null>(over.pending ?? null),
    busy: signal<string | null>(null),
    canAct: signal(true),
  };
  const project = {
    name: signal<string | null>(over.name === undefined ? 'northwind' : over.name),
    isOpen: signal(over.name !== null),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: ProjectActions, useValue: actions },
      { provide: ProjectStore, useValue: project },
    ],
  });

  const fixture = TestBed.createComponent(LxProjectMenu);
  fixture.detectChanges();
  return { fixture, actions, project };
}

type Fixture = ReturnType<typeof mount>['fixture'];

const el = (fixture: Fixture): HTMLElement => fixture.nativeElement as HTMLElement;

const items = (fixture: Fixture): HTMLButtonElement[] => [
  ...el(fixture).querySelectorAll<HTMLButtonElement>('.menuitem'),
];

const clickTrigger = (fixture: Fixture): void => {
  el(fixture).querySelector<HTMLButtonElement>('.trigger')!.click();
  fixture.detectChanges();
};

describe('LxProjectMenu', () => {
  it('shows the project name on the trigger', () => {
    const { fixture } = mount();
    expect(el(fixture).querySelector('.trigger')?.textContent).toContain('northwind');
  });

  it('keeps the menu shut until the trigger is clicked', () => {
    const { fixture } = mount();
    expect(items(fixture)).toHaveLength(0);
  });

  it('offers the project actions, then the Phrase ones, once open', () => {
    const { fixture } = mount();
    clickTrigger(fixture);
    expect(items(fixture).map((b) => b.textContent?.trim())).toEqual([
      'Reload from disk',
      'Re-scan project',
      'Edit locale mapping…',
      'Switch project…',
      'Push to Phrase…',
      'Connect to Phrase…',
      'Clear recent projects',
    ]);
  });

  it('runs the action for the row that was clicked, and shuts the menu', async () => {
    const { fixture, actions } = mount();
    clickTrigger(fixture);
    items(fixture)[1]!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(actions.rescan).toHaveBeenCalledOnce();
    expect(actions.reloadFromDisk).not.toHaveBeenCalled();
    expect(items(fixture)).toHaveLength(0);
  });

  it('names how many drafts are at stake when a confirmation is pending', () => {
    const { fixture } = mount({ pending: { action: 'switch', unsavedCount: 3 } });
    const confirm = el(fixture).querySelector('.confirm');
    expect(confirm?.textContent).toContain('3');
  });

  it('carries the pending action through when the confirmation is accepted', () => {
    const { fixture, actions } = mount({ pending: { action: 'reload', unsavedCount: 2 } });
    el(fixture).querySelector<HTMLButtonElement>('.confirm__go')!.click();
    expect(actions.confirmPending).toHaveBeenCalledOnce();
  });

  it('renders nothing at all when no project is open', () => {
    const { fixture } = mount({ name: null });
    expect(el(fixture).querySelector('.trigger')).toBeNull();
  });
});
