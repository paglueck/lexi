// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import type { ScannedFile } from '@lexi/shared';

import { ProjectActions } from './project-actions.js';
import { ProjectApi } from './api/project-api.js';
import { EventsStore } from './stores/events-store.js';
import { ProjectStore } from './stores/project-store.js';
import { SaveStore } from './stores/save-store.js';

/**
 * The three things the title bar's project menu can do, and the one question it
 * has to ask first. The stores are faked: what is under test is which call is
 * made with which argument, not the DI chain that would otherwise need a live
 * `HttpClient` and an open SSE stream.
 */

const file = (path: string, locale: string | null): ScannedFile =>
  ({
    path,
    relPath: path,
    fileIndex: 0,
    group: '',
    locale,
    localeSource: 'filename',
    conflictingTargetLanguage: null,
    sourceLanguage: 'en-GB',
    targetLanguage: locale,
    unitCount: 2,
    isTemplate: false,
    isRtl: false,
  }) as ScannedFile;

const FILES = [file('/p/messages.de.xlf', 'de'), file('/p/messages.fr.xlf', 'fr')];

function mount(unsaved = 0) {
  const api = {
    close: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue({ needsSetup: true }),
    clearRecents: vi.fn().mockResolvedValue(undefined),
    reloadFiles: vi
      .fn()
      .mockResolvedValue({ reloaded: [], failed: [], dropped: 0, unsavedCount: 0 }),
    scan: vi
      .fn()
      .mockResolvedValue({
        root: '/p',
        files: FILES,
        skipped: [],
        durationMs: 1,
        suggestedSourceLocale: 'en-GB',
        saved: null,
      }),
    open: vi
      .fn()
      .mockResolvedValue({
        name: 'p',
        path: '/p',
        sourceLocale: 'en-GB',
        files: FILES,
        locales: [],
      }),
  };
  const project = {
    project: signal({ path: '/p', sourceLocale: 'en-GB' }),
    files: signal(FILES),
    isOpen: signal(true),
    set: vi.fn(),
    clear: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const save = { unsavedCount: signal(unsaved), setUnsaved: vi.fn() };
  const events = { reload: vi.fn().mockResolvedValue({ reloaded: 2, dropped: 0, failed: 0 }) };
  const router = { navigate: vi.fn().mockResolvedValue(true) };

  TestBed.configureTestingModule({
    providers: [
      ProjectActions,
      { provide: ProjectApi, useValue: api },
      { provide: ProjectStore, useValue: project },
      { provide: SaveStore, useValue: save },
      { provide: EventsStore, useValue: events },
      { provide: Router, useValue: router },
    ],
  });
  return { actions: TestBed.inject(ProjectActions), api, project, events, router, save };
}

describe('ProjectActions', () => {
  it('closes the project and lands on the start screen when switching', async () => {
    const { actions, api, router } = mount();
    await actions.switchProject();
    expect(api.close).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/start']);
  });

  it('reloads every file in the project, not only the ones seen to change', async () => {
    const { actions, events } = mount();
    await actions.reloadFromDisk();
    expect(events.reload).toHaveBeenCalledWith(['/p/messages.de.xlf', '/p/messages.fr.xlf']);
  });

  it('re-opens with the mapping a fresh scan found, so a new locale file is picked up', async () => {
    const { actions, api } = mount();
    await actions.rescan();
    expect(api.scan).toHaveBeenCalledWith('/p');
    expect(api.open).toHaveBeenCalledWith({
      path: '/p',
      sourceLocale: 'en-GB',
      mapping: [
        { path: '/p/messages.de.xlf', fileIndex: 0, locale: 'de', fixTargetLanguage: false },
        { path: '/p/messages.fr.xlf', fileIndex: 0, locale: 'fr', fixTargetLanguage: false },
      ],
    });
  });

  it('keeps a locale the user confirmed in the wizard over the detected one', async () => {
    const { actions, api } = mount();
    api.scan.mockResolvedValueOnce({
      root: '/p',
      files: FILES,
      skipped: [],
      durationMs: 1,
      suggestedSourceLocale: 'en-GB',
      saved: {
        sourceLocale: 'en-GB',
        mapping: [{ relPath: '/p/messages.fr.xlf', fileIndex: 0, locale: 'fr-CA' }],
      },
    });
    await actions.rescan();
    const body = api.open.mock.calls[0]?.[0] as { mapping: Array<{ locale: string }> };
    expect(body.mapping.map((m) => m.locale)).toEqual(['de', 'fr-CA']);
  });

  it('takes a re-map to the wizard for the open project', async () => {
    const { actions, router } = mount();
    await actions.remap();
    expect(router.navigate).toHaveBeenCalledWith(['/setup'], { queryParams: { path: '/p' } });
  });

  it('asks before discarding unsaved drafts, and does nothing until answered', async () => {
    const { actions, api } = mount(3);
    await actions.switchProject();
    expect(actions.pendingConfirm()).toMatchObject({ action: 'switch', unsavedCount: 3 });
    expect(api.close).not.toHaveBeenCalled();
  });

  it('goes ahead once the question is answered yes', async () => {
    const { actions, api, router } = mount(3);
    await actions.switchProject();
    await actions.confirmPending();
    expect(api.close).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/start']);
    expect(actions.pendingConfirm()).toBeNull();
  });

  it('drops the pending action when the question is answered no', async () => {
    const { actions, api } = mount(3);
    await actions.switchProject();
    actions.dismissConfirm();
    expect(actions.pendingConfirm()).toBeNull();
    expect(api.close).not.toHaveBeenCalled();
  });

  it('opens a folder set up before straight away, without the wizard', async () => {
    const { actions, api, project, router } = mount();
    const opened = { path: '/q', name: 'q' };
    api.resume.mockResolvedValueOnce({ needsSetup: false, project: opened });
    await actions.openPath('/q');
    expect(api.scan).not.toHaveBeenCalled();
    expect(project.set).toHaveBeenCalledWith(opened);
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });

  it('scans a new folder and goes to the wizard', async () => {
    const { actions, api, router } = mount();
    await actions.openPath('/p');
    expect(api.scan).toHaveBeenCalledWith('/p');
    expect(router.navigate).toHaveBeenCalledWith(['/setup'], { queryParams: { path: '/p' } });
  });

  it('says so when a folder holds no XLIFF files', async () => {
    const { actions, api, router } = mount();
    api.scan.mockResolvedValueOnce({ root: '/e', files: [], skipped: [], durationMs: 1 });
    await actions.openPath('/e');
    expect(actions.openError()).toBe('No .xlf files found under /e.');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('asks before an open would drop unsaved drafts', async () => {
    const { actions, api } = mount(2);
    await actions.openPath('/q');
    expect(actions.pendingConfirm()).toMatchObject({ action: 'open', path: '/q' });
    expect(api.resume).not.toHaveBeenCalled();
    await actions.confirmPending();
    expect(api.resume).toHaveBeenCalledWith('/q');
  });

  it('clears the recent list and says it changed', async () => {
    const { actions, api } = mount();
    await actions.clearRecents();
    expect(api.clearRecents).toHaveBeenCalledOnce();
    expect(actions.recentsChangedAt()).toBeGreaterThan(0);
  });

  it('does not ask when there is nothing unsaved to lose', async () => {
    const { actions } = mount(0);
    await actions.reloadFromDisk();
    expect(actions.pendingConfirm()).toBeNull();
  });
});
