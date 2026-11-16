// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@lexi/shared';

import { parseEvent } from './events-store.js';
import { parseUpdateState, UpdateStore } from './update-store.js';

const STATUS: UpdateStatus = {
  supported: true,
  currentVersion: '1.0.0',
  mode: 'auto',
  state: { phase: 'available', version: '1.1.0', releaseNotes: null },
};

describe('parseUpdateState', () => {
  it('accepts every phase the server sends', () => {
    expect(parseUpdateState({ phase: 'checking' })).toEqual({ phase: 'checking' });
    expect(parseUpdateState({ phase: 'available', version: '1.1.0', releaseNotes: 'x' })).toEqual({
      phase: 'available',
      version: '1.1.0',
      releaseNotes: 'x',
    });
    expect(parseUpdateState({ phase: 'downloading', version: '1.1.0', percent: 12 })).toEqual({
      phase: 'downloading',
      version: '1.1.0',
      percent: 12,
    });
    expect(parseUpdateState({ phase: 'error', message: 'nope' })).toEqual({
      phase: 'error',
      message: 'nope',
    });
  });

  it('drops what it cannot read', () => {
    expect(parseUpdateState(null)).toBeNull();
    expect(parseUpdateState({ phase: 'exploded' })).toBeNull();
    expect(parseUpdateState({ phase: 'ready', version: 1, releaseNotes: null })).toBeNull();
    expect(parseUpdateState({ phase: 'downloading', version: '1.1.0' })).toBeNull();
    expect(parseUpdateState({ phase: 'error' })).toBeNull();
    expect(parseEvent('{"type":"update","state":"ready"}')).toBeNull();
  });

  it('routes an update frame through parseEvent', () => {
    expect(parseEvent('{"type":"update","state":{"phase":"none"}}')).toEqual({
      type: 'update',
      state: { phase: 'none' },
    });
  });
});

describe('UpdateStore', () => {
  let http: HttpTestingController;
  let store: UpdateStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(UpdateStore);
  });

  afterEach(() => http.verify());

  it('is unsupported when the server cannot answer', async () => {
    const loaded = store.load();
    http.expectOne('/api/update').flush(null, { status: 500, statusText: 'Boom' });
    expect(await loaded).toBeNull();
    expect(store.supported()).toBe(false);
  });

  it('keeps a progress frame that overtook the download answer', async () => {
    const loaded = store.load();
    http.expectOne('/api/update').flush(STATUS);
    await loaded;

    const started = store.download();
    store.apply({ phase: 'downloading', version: '1.1.0', percent: 30 });
    http
      .expectOne('/api/update/download')
      .flush({ ...STATUS, state: { phase: 'downloading', version: '1.1.0', percent: 0 } });
    await started;

    expect(store.state()).toEqual({ phase: 'downloading', version: '1.1.0', percent: 30 });
  });
});
