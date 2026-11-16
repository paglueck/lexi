// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WIDTHS,
  GridColumnsStore,
  MAX_WIDTH,
  MIN_WIDTH,
  clampWidth,
  readWidths,
  storageKey,
  trackList,
  writeWidths,
} from './grid-columns-store.js';
import { ProjectStore } from './project-store.js';

/**
 * Column widths the user drags in the grid header. What matters: the header and
 * the rows get one track list, a width outlives a reload for the SAME project
 * only, and a broken or missing localStorage costs the preference, never the grid.
 */

describe('trackList', () => {
  it('gives every column a fixed width, then a filler that has no cell', () => {
    expect(trackList({}, ['de', 'fr'])).toBe(
      `${DEFAULT_WIDTHS.id}px ${DEFAULT_WIDTHS.source}px ${DEFAULT_WIDTHS.locale}px ${DEFAULT_WIDTHS.locale}px minmax(0, 1fr)`,
    );
  });

  it('uses a dragged width, and keeps widths for columns that are hidden', () => {
    expect(trackList({ source: 400, fr: 90, ja: 500 }, ['fr'])).toBe(
      `${DEFAULT_WIDTHS.id}px 400px 90px minmax(0, 1fr)`,
    );
  });
});

describe('clampWidth', () => {
  it('rounds, and keeps a column grabbable and on screen', () => {
    expect(clampWidth(150.6)).toBe(151);
    expect(clampWidth(-40)).toBe(MIN_WIDTH);
    expect(clampWidth(99999)).toBe(MAX_WIDTH);
  });
});

describe('readWidths / writeWidths', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips per project', () => {
    writeWidths('/a', { de: 300 });
    expect(readWidths('/a')).toEqual({ de: 300 });
    expect(readWidths('/b')).toEqual({});
  });

  it('removes the entry once nothing differs from the defaults', () => {
    writeWidths('/a', { de: 300 });
    writeWidths('/a', {});
    expect(localStorage.getItem(storageKey('/a'))).toBeNull();
  });

  it('treats a corrupt entry as nothing stored, and drops values that are not widths', () => {
    localStorage.setItem(storageKey('/a'), '{not json');
    expect(readWidths('/a')).toEqual({});
    localStorage.setItem(storageKey('/a'), JSON.stringify({ de: 'wide', fr: 5, ja: 260 }));
    expect(readWidths('/a')).toEqual({ fr: MIN_WIDTH, ja: 260 });
  });

  it('survives a localStorage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeWidths('/a', { de: 300 })).not.toThrow();
    expect(readWidths('/a')).toEqual({});
  });
});

describe('GridColumnsStore', () => {
  const project = signal<{ path: string } | null>(null);

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    project.set({ path: '/a' });
    TestBed.configureTestingModule({
      providers: [{ provide: ProjectStore, useValue: { project } }],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('loads the open project’s widths and saves a drag once it settles', () => {
    writeWidths('/a', { de: 333 });
    const store = TestBed.inject(GridColumnsStore);
    TestBed.tick();
    expect(store.width('de')).toBe(333);
    expect(store.width('fr')).toBe(DEFAULT_WIDTHS.locale);

    store.setWidth('fr', 250);
    store.setWidth('fr', 260);
    expect(readWidths('/a')).toEqual({ de: 333 }); // not yet: the write trails the drag
    vi.runAllTimers();
    expect(readWidths('/a')).toEqual({ de: 333, fr: 260 });
  });

  it('resets a column to its default', () => {
    const store = TestBed.inject(GridColumnsStore);
    TestBed.tick();
    store.setWidth('source', 500);
    store.reset('source');
    vi.runAllTimers();
    expect(store.width('source')).toBe(DEFAULT_WIDTHS.source);
    expect(localStorage.getItem(storageKey('/a'))).toBeNull();
  });

  it('writes a pending drag to the project it was made in, not the next one', () => {
    writeWidths('/b', { de: 111 });
    const store = TestBed.inject(GridColumnsStore);
    TestBed.tick();
    store.setWidth('de', 400);

    project.set({ path: '/b' });
    TestBed.tick();
    vi.runAllTimers();

    expect(readWidths('/a')).toEqual({ de: 400 });
    expect(readWidths('/b')).toEqual({ de: 111 });
    expect(store.width('de')).toBe(111);
  });
});
