// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '@lexi/shared';

import { CsvImportApi } from '../../core/api/csv-import-api.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { jobFixture } from '../../core/testing/job-fixture.js';
import { JobsPage } from './jobs-page.js';

/**
 * The queue header's toolbar. The cards themselves are `job-card.spec.ts`'s;
 * the list here is kept empty so this spec is only about the header.
 */
function mount(completed: readonly Job[]) {
  const fake = {
    refresh: vi.fn(() => Promise.resolve()),
    clearFinished: vi.fn(() => Promise.resolve()),
    loaded: signal(true),
    error: signal<string | null>(null),
    jobs: signal<readonly Job[]>(completed),
    ordered: signal<readonly Job[]>([]),
    unfinished: signal<readonly Job[]>([]),
    completed: signal<readonly Job[]>(completed),
    // What the run-log panel beside the queue reads.
    selected: signal<Job | null>(null),
    selectedId: signal<string | null>(null),
    logFilter: signal<'all' | 'flagged'>('all'),
    logLocale: signal<string>('all'),
    filteredLog: signal([]),
    visibleLog: signal([]),
  };
  TestBed.configureTestingModule({ providers: [
      { provide: JobsStore, useValue: fake },
      // The run-log panel beside the queue asks for the shown job's imports.
      { provide: CsvImportApi, useValue: { jobImports: () => Promise.resolve({ imports: [] }) } },
    ],
  });
  const fixture = TestBed.createComponent(JobsPage);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = [...el.querySelectorAll<HTMLButtonElement>('.queue__actions button')].find(
    (b) => b.textContent?.trim() === 'Clear finished',
  );
  return { fake, el, button };
}

describe('JobsPage header', () => {
  it('sits the counts on the left and "Clear finished" on the right', () => {
    const { el, button } = mount([jobFixture({ status: 'done' })]);
    expect(el.querySelector('.queue__count')?.textContent).toContain('0 active · 1 finished');
    expect(button).toBeDefined();
  });

  it('clears the finished jobs through the store', () => {
    const { fake, button } = mount([jobFixture({ status: 'done' })]);
    button!.click();
    expect(fake.clearFinished).toHaveBeenCalledTimes(1);
  });

  it('cannot be pressed with nothing finished to clear', () => {
    const { button } = mount([]);
    expect(button!.disabled).toBe(true);
  });
});
