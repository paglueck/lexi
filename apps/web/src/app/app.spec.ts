// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { App } from './app.js';
import { EventsStore } from './core/stores/events-store.js';
import { JobsStore } from './core/stores/jobs-store.js';
import { ProjectStore } from './core/stores/project-store.js';
import { UpdateStore } from './core/stores/update-store.js';

describe('App jobs refresh', () => {
  it('refreshes the jobs list when the open project changes path, not only when it opens', () => {
    const project = signal<{ path: string } | null>(null);
    // A computed, like the real store's: it stays true from project A to project B.
    const isOpen = computed(() => project() !== null);
    const refresh = vi.fn(() => Promise.resolve());
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        // Every read answers with an empty list: the shell's stores watch events this spec does not care about.
        { provide: EventsStore, useValue: new Proxy({}, { get: () => () => [] }) },
                { provide: JobsStore, useValue: { refresh, jobs: () => [], loaded: () => false } },
        {
          provide: ProjectStore,
          useValue: {
            project: project.asReadonly(),
            isOpen,
            applyHealth: vi.fn(),
          },
        },
      ],
    });
    // Only the constructor's effect is under test, so the shell's chrome is not rendered.
    TestBed.overrideComponent(App, { set: { imports: [], template: '', templateUrl: undefined } });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(refresh).not.toHaveBeenCalled();

    project.set({ path: '/a' });
    fixture.detectChanges();
    expect(refresh).toHaveBeenCalledTimes(1);

    project.set({ path: '/b' });
    fixture.detectChanges();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('leaves the start-up update check alone once the shell is gone', async () => {
    // The check waits for a lazy chunk. A shell destroyed before the chunk
    // arrives (a test's teardown, in practice) must not reach into its
    // destroyed injector; that used to be an unhandled NG0205 rejection.
    const load = vi.fn(() => Promise.resolve({ supported: false }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EventsStore, useValue: new Proxy({}, { get: () => () => [] }) },
        { provide: JobsStore, useValue: { refresh: vi.fn(), jobs: () => [], loaded: () => false } },
        {
          provide: ProjectStore,
          useValue: { project: () => null, isOpen: () => false, applyHealth: vi.fn() },
        },
        { provide: UpdateStore, useValue: { load } },
      ],
    });
    TestBed.overrideComponent(App, { set: { imports: [], template: '', templateUrl: undefined } });
    const fixture = TestBed.createComponent(App);
    fixture.destroy();
    TestBed.resetTestingModule();

    // Let the lazy chunk resolve and its continuation run.
    await import('./features/update/update-dialog.js');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(load).not.toHaveBeenCalled();
  });
});
