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
});
