// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import type { CsvImportPreviewResponse } from '@lexi/shared';

import { CsvImportApi } from '../api/csv-import-api.js';
import { CsvImportStore } from './csv-import-store.js';
import { ProjectStore } from './project-store.js';

function setup() {
  const preview = vi.fn(() => Promise.resolve({ files: [] } as unknown as CsvImportPreviewResponse));
  const router = { navigateByUrl: vi.fn(() => Promise.resolve(true)) };
  TestBed.configureTestingModule({
    providers: [
      { provide: CsvImportApi, useValue: { preview } },
      { provide: Router, useValue: router },
      {
        provide: ProjectStore,
        useValue: { targetLocales: () => [{ locale: 'de' }, { locale: 'nl' }] },
      },
    ],
  });
  return { store: TestBed.inject(CsvImportStore), preview, router };
}

const csv = (name: string, text: string): File => new File([text], name, { type: 'text/csv' });

describe('CsvImportStore.start', () => {
  it('reports a file without locale columns and stays on the page', async () => {
    const { store, preview, router } = setup();
    await store.start([csv('de.csv', 'Unit ID,Locale,Translation\na,de,Hallo\n')], {
      jobId: 'j1',
    });
    expect(store.error()).toContain('a column per locale');
    expect(preview).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(store.busy()).toBe(false);
  });

  it('previews a valid file against its job and opens the job import screen', async () => {
    const { store, preview, router } = setup();
    await store.start([csv('de.csv', 'Unit ID,de\na,Hallo\n')], { jobId: 'j1' });
    expect(preview).toHaveBeenCalledWith({
      files: [{ name: 'de.csv', text: 'Unit ID,de\na,Hallo\n' }],
      jobId: 'j1',
    });
    expect(router.navigateByUrl).toHaveBeenCalledWith('/jobs/j1/import');
    expect(store.preview()).not.toBeNull();
    expect(store.error()).toBeNull();
  });

  it('keeps the texts it previewed, so Apply sends what the user saw', async () => {
    const { store } = setup();
    await store.start([csv('de.csv', 'Unit ID,de\na,Hallo\n')], { jobId: 'j1' });
    expect(store.files()).toEqual([{ name: 'de.csv', text: 'Unit ID,de\na,Hallo\n' }]);
  });

  it('opens /import with no job when started from the grid', async () => {
    const { store, preview, router } = setup();
    await store.start([csv('de.csv', 'Unit ID,de\na,Hallo\n')], { grid: true });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ jobId: null }));
    expect(router.navigateByUrl).toHaveBeenCalledWith('/import');
    store.clear();
    expect(store.preview()).toBeNull();
    expect(store.origin()).toBeNull();
  });

  it('keeps the error, and no stale preview, when the server rejects the file', async () => {
    const { store, preview, router } = setup();
    await store.start([csv('de.csv', 'Unit ID,de\na,Hallo\n')], { jobId: 'j1' });
    expect(store.preview()).not.toBeNull();
    preview.mockRejectedValueOnce(new Error('offline'));
    router.navigateByUrl.mockClear();
    await store.start([csv('nl.csv', 'Unit ID,nl\na,Hoi\n')], { grid: true });
    expect(store.error()).not.toBeNull();
    expect(store.busy()).toBe(false);
    expect(store.preview()).toBeNull();
    expect(store.origin()).toBeNull();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('ignores a second start while the first is still running', async () => {
    const { store, preview } = setup();
    const file = csv('de.csv', 'Unit ID,de\na,Hallo\n');
    const first = store.start([file], { jobId: 'j1' });
    expect(store.busy()).toBe(true);
    await store.start([file], { grid: true });
    await first;
    expect(preview).toHaveBeenCalledTimes(1);
    expect(store.origin()).toEqual({ jobId: 'j1' });
  });
});
