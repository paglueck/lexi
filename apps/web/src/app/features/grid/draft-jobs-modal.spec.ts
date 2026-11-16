// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobCreateRequest, UnitsQueryRequest, UnitsQueryResponse } from '@lexi/shared';

import { GridStore } from '../../core/stores/grid-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { ToastStore } from '../../core/stores/toast-store.js';
import { jobFixture } from '../../core/testing/job-fixture.js';
import { LxDraftJobsModal } from './draft-jobs-modal.js';

/**
 * S15. The thing about it that is easy to get wrong and invisible in a
 * screenshot: every per-cell grid filter is an ANY over the locales in scope,
 * so the toolbar's own id list is "untranslated in de OR fr" and cannot be
 * handed to every locale of a job. The modal asks each locale separately, and
 * the answers it shows must be the answers the job drafts.
 */

const answer = (ids: string[]): UnitsQueryResponse => ({
  total: ids.length,
  ids,
  scopeTotal: 99,
  facets: {},
  groupCounts: {},
});

const BASE_QUERY: UnitsQueryRequest = {
  search: '',
  scope: 'all',
  groups: ['checkout'],
  locales: ['de', 'fr'],
  filters: ['untranslated'],
};

describe('LxDraftJobsModal', () => {
  let http: HttpTestingController;

  const grid = {
    availableLocales: signal<readonly string[]>(['de', 'fr', 'pl', 'ar']),
    visibleLocales: signal<readonly string[]>(['de', 'fr']),
    queryBody: signal<UnitsQueryRequest>({ ...BASE_QUERY }),
  };
  let locked: WritableSignal<ReadonlyMap<string, number>>;
  let jobs: { locked: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  let ref: { close: ReturnType<typeof vi.fn> };
  let toasts: { show: ReturnType<typeof vi.fn> };
  const configured = signal(true);

  beforeEach(() => {
    grid.queryBody.set({ ...BASE_QUERY });
    grid.visibleLocales.set(['de', 'fr']);
    configured.set(true);
    // Like the real store: `locked` is reactive, and a created job locks its
    // locales at once — so the selection empties before the toast is written.
    locked = signal<ReadonlyMap<string, number>>(new Map());
    jobs = {
      locked: vi.fn(() => locked()),
      create: vi.fn((request: JobCreateRequest) => {
        locked.set(new Map([...locked(), ...request.locales.map((l) => [l.locale, 16] as const)]));
        return Promise.resolve(jobFixture({ number: 16, status: 'queued' }));
      }),
    };
    ref = { close: vi.fn() };
    toasts = { show: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: GridStore, useValue: grid },
        { provide: JobsStore, useValue: jobs },
        { provide: DialogRef, useValue: ref },
        { provide: ToastStore, useValue: toasts },
        { provide: SettingsStore, useValue: { configured } },
        {
          provide: ProjectStore,
          useValue: { targetLocales: signal([{ locale: 'ar', isRtl: true }]) },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  /**
   * Open the modal and answer the one query each locale fires.
   *
   * A macrotask, not `whenStable`: the app is zoneless, so nothing is tracking
   * the component's own `Promise.all` and `whenStable` resolves before the
   * counts have landed.
   */
  const open = async (counts: Record<string, string[]>) => {
    const fixture = TestBed.createComponent(LxDraftJobsModal);
    fixture.detectChanges();
    const requests = http.match('/api/units/query');
    for (const req of requests) {
      const locale = (req.request.body as UnitsQueryRequest).locales[0] as string;
      req.flush(answer(counts[locale] ?? []));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, requests };
  };

  const text = (node: Element | null | undefined): string =>
    node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const localeRows = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLButtonElement>('button.locale'),
  ];
  const button = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b).startsWith(label));
  const settle = async (fixture: { detectChanges(): void }) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  it('asks each locale its own question, keeping the rest of the filter', async () => {
    const { requests } = await open({ de: ['a', 'b'], fr: ['a'] });
    expect(requests.map((r) => (r.request.body as UnitsQueryRequest).locales)).toEqual([
      ['de'],
      ['fr'],
      ['pl'],
      ['ar'],
    ]);
    expect((requests[0]?.request.body as UnitsQueryRequest).filters).toEqual(['untranslated']);
    expect((requests[0]?.request.body as UnitsQueryRequest).groups).toEqual(['checkout']);
  });

  it('shows the scope as read-only chips, defaulting to untranslated', async () => {
    grid.queryBody.set({ ...BASE_QUERY, filters: [] });
    const { el, requests } = await open({ de: ['a'] });
    expect((requests[0]?.request.body as UnitsQueryRequest).filters).toEqual(['untranslated']);
    expect([...el.querySelectorAll('.chip')].map((c) => text(c))).toEqual([
      'Untranslated',
      'file: checkout',
    ]);
  });

  it('"Change in Grid" closes the dialog', async () => {
    const { el } = await open({});
    button(el, 'Change in Grid')?.click();
    expect(ref.close).toHaveBeenCalled();
  });

  it('shows each locale its own count, name and RTL mark, with the visible columns picked', async () => {
    const { el } = await open({ de: ['a', 'b'], fr: ['a'], pl: ['c'], ar: ['d'] });
    const rows = localeRows(el);
    expect(text(rows[0])).toContain('de');
    expect(text(rows[0])).toContain('German');
    expect(text(rows[0])).toContain('2');
    expect(text(rows[3])).toContain('RTL');
    expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'false',
      'false',
    ]);
    expect(text(el.querySelector('.picked'))).toBe('2 selected');
  });

  it('locks a locale an active job already holds, and says which job', async () => {
    locked.set(new Map([['fr', 14]]));
    const { el } = await open({ de: ['a'], fr: ['a'], pl: ['c'] });
    const fr = localeRows(el)[1]!;
    expect(fr.disabled).toBe(true);
    expect(fr.getAttribute('aria-checked')).toBe('false');
    expect(text(fr)).toContain('in #14');
    expect(jobs.locked).toHaveBeenCalledWith('draft');
  });

  it('cannot pick a locale with nothing to do', async () => {
    const { el } = await open({ de: ['a'], fr: [] });
    expect(localeRows(el)[1]!.disabled).toBe(true);
  });

  it('Select all picks every free locale with work, None clears them', async () => {
    locked.set(new Map([['pl', 14]]));
    const { el, fixture } = await open({ de: ['a'], fr: ['b'], pl: ['c'], ar: [] });
    button(el, 'Select all')?.click();
    fixture.detectChanges();
    expect(localeRows(el).map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'false',
      'false',
    ]);
    button(el, 'None')?.click();
    fixture.detectChanges();
    expect(text(el.querySelector('.summary'))).toBe('No locales selected');
    expect(button(el, 'Queue job')?.disabled).toBe(true);
  });

  it('previews the run order, and sorts by units in scope for "Smallest first"', async () => {
    const { el, fixture } = await open({ de: ['a', 'b', 'c'], fr: ['a'] });
    expect(text(el.querySelector('.sequence'))).toBe('de → fr');
    const smallest = [...el.querySelectorAll<HTMLElement>('lx-segmented-control button')].find(
      (b) => text(b) === 'Smallest first',
    );
    smallest?.click();
    fixture.detectChanges();
    expect(text(el.querySelector('.sequence'))).toBe('fr → de');
  });

  it('sums the units and estimates the time in the footer', async () => {
    const { el } = await open({ de: ['a', 'b'], fr: ['c'] });
    expect(text(el.querySelector('.summary'))).toBe('2 locales · 3 units · ~1 min');
    expect(text(button(el, 'Queue job'))).toBe('Queue job · 2 locales');
  });

  it('queues ONE job with each locale carrying its own rows, in run order, then closes with a toast', async () => {
    const { el, fixture } = await open({ de: ['a', 'b'], fr: ['b'] });
    button(el, 'Queue job')?.click();
    await settle(fixture);

    expect(jobs.create).toHaveBeenCalledTimes(1);
    expect(jobs.create).toHaveBeenCalledWith({
      task: 'draft',
      locales: [
        { locale: 'de', ids: ['a', 'b'] },
        { locale: 'fr', ids: ['b'] },
      ],
    });
    expect(ref.close).toHaveBeenCalledTimes(1);
    // The same toast "Translate N cells" shows, with the way to the job.
    expect(toasts.show).toHaveBeenCalledWith({
      tone: 'accent',
      title: 'Job #16 queued',
      detail: '2 locales: de, fr · 3 units',
      action: { label: 'View jobs', route: '/jobs' },
    });
  });

  describe('the job name', () => {
    const nameInput = (el: HTMLElement) =>
      el.querySelector<HTMLInputElement>('lx-field input[lxInput]')!;
    const type = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };

    it('is prefilled with the default title and follows the selection until edited', async () => {
      const { el, fixture } = await open({ de: ['a'], fr: ['b'], pl: ['c'] });
      expect(nameInput(el).value).toBe('Draft untranslated units · de, fr');
      button(el, 'Select all')?.click();
      fixture.detectChanges();
      expect(nameInput(el).value).toBe('Draft untranslated units · de, fr, pl');
    });

    it('keeps an edit when the selection changes, and sends it with the job', async () => {
      const { el, fixture } = await open({ de: ['a'], fr: ['b'], pl: ['c'] });
      type(nameInput(el), '  Release 4.2 ');
      fixture.detectChanges();
      button(el, 'Select all')?.click();
      fixture.detectChanges();
      expect(nameInput(el).value).toBe('  Release 4.2 ');

      button(el, 'Queue job')?.click();
      await settle(fixture);
      expect(jobs.create).toHaveBeenCalledWith({
        task: 'draft',
        locales: [
          { locale: 'de', ids: ['a'] },
          { locale: 'fr', ids: ['b'] },
          { locale: 'pl', ids: ['c'] },
        ],
        name: 'Release 4.2',
      });
      expect(toasts.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Job #16 queued · Release 4.2' }),
      );
    });

    it('falls back to the default, following the selection again, once cleared', async () => {
      const { el, fixture } = await open({ de: ['a'], fr: ['b'], pl: ['c'] });
      type(nameInput(el), 'Release 4.2');
      fixture.detectChanges();
      type(nameInput(el), '');
      nameInput(el).dispatchEvent(new Event('blur'));
      fixture.detectChanges();
      expect(nameInput(el).value).toBe('Draft untranslated units · de, fr');
      button(el, 'Select all')?.click();
      fixture.detectChanges();
      expect(nameInput(el).value).toBe('Draft untranslated units · de, fr, pl');

      button(el, 'Queue job')?.click();
      await settle(fixture);
      expect(jobs.create.mock.calls[0]?.[0]).not.toHaveProperty('name');
    });

    it('sends no name when the default is left as it is', async () => {
      const { el, fixture } = await open({ de: ['a'] });
      button(el, 'Queue job')?.click();
      await settle(fixture);
      expect(jobs.create.mock.calls[0]?.[0]).not.toHaveProperty('name');
      expect(toasts.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Job #16 queued' }),
      );
    });
  });

  it('stays open with the reason when the job could not be queued', async () => {
    // The server's 409, in the shape `HttpClient` rejects with.
    jobs.create.mockRejectedValueOnce({
      error: { error: { message: 'de is already in active job #14' } },
    });
    const { el, fixture } = await open({ de: ['a'] });
    button(el, 'Queue job')?.click();
    await settle(fixture);
    expect(text(el.querySelector('.banner'))).toContain('already in active job');
    expect(ref.close).not.toHaveBeenCalled();
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('asks for a model first when none is configured', async () => {
    configured.set(false);
    const { el } = await open({ de: ['a'] });
    expect(el.textContent).toContain('Set a model in Settings before drafting.');
    expect(button(el, 'Queue job')?.disabled).toBe(true);
  });
});
