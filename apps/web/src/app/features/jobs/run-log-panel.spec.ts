// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { CsvImportSummary, Job } from '@lexi/shared';

import { CsvImportApi } from '../../core/api/csv-import-api.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { jobFixture } from '../../core/testing/job-fixture.js';
import { LxRunLogPanel } from './run-log-panel.js';

function mount(imports: readonly CsvImportSummary[], job: Job | null = jobFixture()) {
  const selectedId = signal<string | null>(job?.id ?? null);
  const store = {
    selected: signal<Job | null>(job),
    selectedId,
    logFilter: signal<'all' | 'flagged'>('all'),
    logLocale: signal<string>('all'),
    filteredLog: signal([]),
    visibleLog: signal([]),
  };
  const jobImports = vi.fn(() => Promise.resolve({ imports }));
  TestBed.configureTestingModule({
    providers: [
      { provide: JobsStore, useValue: store },
      { provide: CsvImportApi, useValue: { jobImports } },
    ],
  });
  const fixture = TestBed.createComponent(LxRunLogPanel);
  fixture.detectChanges();
  return { fixture, store, selectedId, jobImports };
}

const text = (f: { nativeElement: unknown }) => (f.nativeElement as HTMLElement).textContent ?? '';

describe('LxRunLogPanel CSV import lines', () => {
  it('renders one line per import for the shown job', async () => {
    const at = new Date(2026, 9, 20, 9, 5).toISOString();
    const { fixture, jobImports } = mount([
      { importId: 'i1', at, jobId: 'j', count: 12, undone: false },
      { importId: 'i0', at, jobId: 'j', count: 3, undone: true },
      { importId: 'iz', at, jobId: 'j', count: 1, undone: false },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(jobImports).toHaveBeenCalledOnce();
    expect(text(fixture)).toContain('CSV import · 12 units · 09:05');
    expect(text(fixture)).toContain('CSV import · 3 units · 09:05 · undone');
    expect(text(fixture)).toContain('CSV import · 1 unit · 09:05');
    expect(text(fixture)).not.toContain('1 units');
  });

  it('loads again when the shown job changes, and not with no job', async () => {
    const { fixture, selectedId, jobImports } = mount([], null);
    await fixture.whenStable();
    expect(jobImports).not.toHaveBeenCalled();
    selectedId.set('other');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(jobImports).toHaveBeenCalledWith('other');
  });
});
