// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Project } from '@lexi/shared';

import { GridStore } from './grid-store.js';
import { ProjectStore } from './project-store.js';
import { UnitsStore, nextSelectedIndex } from './units-store.js';

/**
 * Where the selection lands when the filtered list changes underneath it.
 *
 * This is Sofia's workflow in one function: she is thirty rows into a review,
 * ticks "needs review" to narrow the list, and either keeps her place or does
 * not. Nothing about it is visible in a screenshot, so it is asserted here.
 */
describe('nextSelectedIndex', () => {
  const prev = (source: readonly string[], value: number) => ({ source, value });

  it('starts at the first row', () => {
    expect(nextSelectedIndex(['a', 'b', 'c'], undefined)).toBe(0);
  });

  it('follows the SAME unit when the filter moves it', () => {
    // 'c' was selected at index 2; after filtering it sits at index 0.
    expect(nextSelectedIndex(['c', 'd'], prev(['a', 'b', 'c', 'd'], 2))).toBe(0);
  });

  it('follows the same unit when rows are inserted above it', () => {
    expect(nextSelectedIndex(['x', 'y', 'a', 'b'], prev(['a', 'b'], 0))).toBe(2);
  });

  it('holds the position when the selected unit falls out of the filter', () => {
    // 'b' is gone. Snapping to 0 would throw a reviewer back to the top of a
    // 20,000-row list; holding the index keeps their eye where it was.
    expect(nextSelectedIndex(['a', 'c', 'd'], prev(['a', 'b', 'c', 'd'], 1))).toBe(1);
  });

  it('clamps to the last row when the list shrank past the old position', () => {
    expect(nextSelectedIndex(['a'], prev(['a', 'b', 'c'], 2))).toBe(0);
  });

  it('reports no selection for an empty list rather than row 0', () => {
    expect(nextSelectedIndex([], prev(['a'], 0))).toBe(-1);
  });

  it('survives a previous index that is already out of range', () => {
    expect(nextSelectedIndex(['a', 'b'], prev([], 5))).toBe(1);
    expect(nextSelectedIndex(['a', 'b'], prev(['a'], -1))).toBe(0);
  });
});

/**
 * S12's "Open in grid": the row it names gets selected, and a filter that
 * hides it is taken away once rather than leaving the user on the wrong row.
 */
describe('UnitsStore.reveal', () => {
  const answer = (ids: string[]) => ({
    total: ids.length,
    ids,
    scopeTotal: 3,
    facets: {},
    groupCounts: {},
  });

  /** Answer the pending query, and let the resource publish the answer. */
  const flushQuery = async (http: HttpTestingController, ids: string[]): Promise<void> => {
    TestBed.tick();
    for (const req of http.match((r) => r.url === '/api/units/query')) req.flush(answer(ids));
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  };

  function setup() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(ProjectStore).set({
      path: '/x',
      name: 'x',
      sourceLocale: 'en-GB',
      files: [],
      locales: [],
      visibleLocales: ['de'],
      filters: [],
      severities: {},
    } as unknown as Project);
    return { http, units: TestBed.inject(UnitsStore), grid: TestBed.inject(GridStore) };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('selects a row that is already in the list', async () => {
    const { http, units } = setup();
    await flushQuery(http, ['a', 'b', 'c']);
    units.reveal('c', 'de');
    TestBed.tick();
    expect(units.selectedRowId()).toBe('c');
    expect(TestBed.inject(GridStore).editLocale()).toBe('de');
  });

  it('clears the filters once when they hide the row, then selects it', async () => {
    const { http, units, grid } = setup();
    grid.toggleFilter('hasErrors');
    await flushQuery(http, ['a']);
    units.reveal('c', 'de');
    TestBed.tick();
    expect(grid.filters()).toEqual([]);
    await flushQuery(http, ['a', 'b', 'c']);
    expect(units.selectedRowId()).toBe('c');
    for (const open of http.match(() => true)) open.flush({});
  });

  it('gives up quietly on a row that is not in the project', async () => {
    const { http, units } = setup();
    await flushQuery(http, ['a']);
    units.reveal('zzz', 'de');
    TestBed.tick();
    expect(units.selectedRowId()).toBe('a');
  });
});
