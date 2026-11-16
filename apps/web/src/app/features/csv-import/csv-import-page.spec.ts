// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import type {
  CsvImportApplyResponse,
  CsvImportPreviewResponse,
  CsvImportUndoResponse,
  Job,
} from '@lexi/shared';

import { CsvImportApi } from '../../core/api/csv-import-api.js';
import { CsvImportStore, type CsvImportOrigin } from '../../core/stores/csv-import-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { previewFixture } from '../../core/testing/csv-import-fixture.js';
import { jobFixture, jobLocale } from '../../core/testing/job-fixture.js';
import { CsvImportPage } from './csv-import-page.js';

/** S16, over a store stub holding one row of each category and an API stub. */
function mount() {
  const store = {
    preview: signal<CsvImportPreviewResponse | null>(previewFixture()),
    origin: signal<CsvImportOrigin | null>({ jobId: 'j1' }),
    // The texts the preview was made from, not `File`s: Apply sends exactly these.
    files: signal<readonly { name: string; text: string }[]>([
      { name: 'northwind_job13.csv', text: 'Unit ID,…' },
    ]),
    error: signal<string | null>(null),
    busy: signal(false),
    start: vi.fn(() => Promise.resolve()),
    clear: vi.fn(),
  };
  const api = {
    apply: vi.fn<() => Promise<CsvImportApplyResponse>>(() =>
      Promise.resolve({
        importId: 'imp1',
        at: '2026-10-20T14:30:00',
        written: [
          { path: 'locales/nl.xliff', count: 1 },
          { path: 'locales/tr.xliff', count: 1 },
        ],
      }),
    ),
    undo: vi.fn<() => Promise<CsvImportUndoResponse>>(() =>
      Promise.resolve({ restored: 1, skipped: [{ rowId: 'r2', locale: 'tr' }] }),
    ),
  };
  const job = jobFixture({
    id: 'j1',
    number: 13,
    status: 'done',
    locales: [jobLocale({ locale: 'nl' }), jobLocale({ locale: 'tr' })],
  });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: CsvImportStore, useValue: store },
      { provide: CsvImportApi, useValue: api },
      { provide: JobsStore, useValue: { jobs: signal<readonly Job[]>([job]) } },
      {
        provide: ProjectStore,
        useValue: {
          sourceLocale: signal('en-GB'),
          targetLocales: signal([
            { locale: 'nl', isRtl: false },
            { locale: 'tr', isRtl: false },
          ]),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(CsvImportPage);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rows = () => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
  const selectedId = () =>
    rows()
      .find((r) => r.getAttribute('aria-selected') === 'true')
      ?.querySelector('.unit')
      ?.textContent?.trim();
  const tab = (label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.tabs button')].find((b) =>
      b.textContent?.includes(label),
    )!;
  const link = (label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.bulk button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  const render = () => fixture.detectChanges();
  const applyButton = () => el.querySelector<HTMLButtonElement>('.apply')!;
  const applyLabel = () => applyButton().textContent!.trim();
  /** Lets the API stub's promise settle, then redraws. */
  const settle = async () => {
    await fixture.whenStable();
    render();
  };
  const banner = () => el.querySelector('.banner')?.textContent?.replace(/\s+/g, ' ').trim();
  return {
    fixture,
    el,
    store,
    api,
    rows,
    selectedId,
    tab,
    link,
    render,
    applyButton,
    applyLabel,
    settle,
    banner,
  };
}

describe('CsvImportPage list', () => {
  it('names the job, the file and its columns in the header', () => {
    const { el } = mount();
    const head = el.querySelector('.head')!.textContent!.replace(/\s+/g, ' ');
    expect(head).toContain('#13 Draft untranslated units · nl, tr');
    expect(head).toContain('northwind_job13.csv');
    expect(head).toContain('5 rows · UTF-8 · comma-separated');
    expect(head).toContain('Reviewer note · ignored');
    expect(head).toContain('Baseline: export snapshot, 20 Oct 13:14');
  });

  it('shows the bulk bar on the Conflicts tab only', () => {
    const { el, tab, render } = mount();
    expect(el.querySelector('.bulk')).toBeNull();
    tab('Conflicts').click();
    render();
    expect(el.querySelector('.bulk')?.textContent).toContain(
      'These units changed in Lexi after the export.',
    );
  });

  it('readies Apply once "Use CSV for all" decides every conflict', () => {
    const { tab, link, render, applyLabel, el } = mount();
    expect(applyLabel()).toBe('Resolve 1 conflict');
    tab('Conflicts').click();
    render();
    link('Use CSV for all').click();
    render();
    expect(applyLabel()).toBe('Apply 2 changes');
    expect(el.querySelector('lx-import-status-chip')?.textContent?.trim()).toBe('use CSV');
  });

  it('unticks a change without moving the selection', () => {
    const { rows, selectedId, render } = mount();
    rows()[1]!.click();
    render();
    expect(selectedId()).toBe('account.delete_confirm');
    rows()[0]!.querySelector<HTMLElement>('.box')!.click();
    render();
    expect(selectedId()).toBe('account.delete_confirm');
    expect(rows()[0]!.querySelector('lx-import-status-chip')?.textContent?.trim()).toBe('excluded');
  });

  it('moves the selection with ArrowDown and toggles a change with Space', () => {
    const { el, selectedId, render, rows } = mount();
    const list = el.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(selectedId()).toBe('checkout.pay_later');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    render();
    expect(rows()[0]!.getAttribute('aria-checked')).toBe('false');
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    render();
    expect(selectedId()).toBe('account.delete_confirm');
  });

  it('filters by language, keeping tr-TR under tr, and shows the unchanged box', () => {
    const { el, rows, render, tab } = mount();
    const tr = [...el.querySelectorAll<HTMLButtonElement>('lx-segmented-control button')].find(
      (b) => b.textContent?.trim() === 'tr',
    )!;
    tr.click();
    render();
    expect(rows().map((r) => r.querySelector('.loc')?.textContent?.trim())).toEqual([
      'tr',
      'tr-TR',
    ]);
    // Back to "All locales", the first option.
    tr.parentElement!.querySelector<HTMLButtonElement>('button')!.click();
    render();
    tab('Unchanged').click();
    render();
    expect(rows()).toEqual([]);
    expect(el.querySelector('.unchanged')?.textContent).toContain(
      '1 row matches the translation in Lexi exactly. Nothing to apply for them.',
    );
  });

  it('re-picks through the store with the same origin', async () => {
    const { el, store } = mount();
    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['x'], 'b.csv');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(store.start).toHaveBeenCalledWith([file], { jobId: 'j1' });
  });

  it('announces the include state on the option, not on the hidden box', () => {
    const { rows } = mount();
    expect(rows().map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      null,
      null,
    ]);
    expect(rows()[0]!.querySelector('.box')?.getAttribute('aria-hidden')).toBe('true');
    expect(rows()[0]!.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('keeps the Conflicts count amber under a locale without open conflicts', () => {
    const { el, tab, render } = mount();
    const nl = [...el.querySelectorAll<HTMLButtonElement>('lx-segmented-control button')].find(
      (b) => b.textContent?.trim() === 'nl',
    )!;
    nl.click();
    render();
    expect(tab('Conflicts').querySelector('.tab__count')?.getAttribute('data-tone')).toBe('warn');
  });
});

describe('CsvImportPage detail and footer', () => {
  it('shows the selected conflict as two radio cards; Keep current sets its chip', () => {
    const { el, rows, render } = mount();
    rows()[1]!.click();
    render();
    const cards = [...el.querySelectorAll<HTMLElement>('.detail lx-radio-card')];
    expect(cards.map((c) => c.querySelector('.title')?.textContent?.trim())).toEqual([
      'Use CSV',
      'Keep current',
    ]);
    cards[1]!.click();
    render();
    expect(rows()[1]!.querySelector('lx-import-status-chip')?.textContent?.trim()).toBe(
      'keep current',
    );
    expect(el.querySelector('.detail lx-import-status-chip')?.textContent?.trim()).toBe(
      'keep current',
    );
  });

  it('offers needsReview, reviewed and final, final by default, and the summary', () => {
    const { el } = mount();
    const footer = el.querySelector('lx-import-footer')!;
    const states = [...footer.querySelectorAll('lx-segmented-control button')];
    expect(states.map((b) => b.textContent?.trim())).toEqual(['needsReview', 'reviewed', 'final']);
    expect(states[2]!.getAttribute('aria-pressed')).toBe('true');
    expect(footer.textContent).toContain('Imported units get');
    expect(footer.textContent).toContain(
      '1 unit will be written · nl 1 · 1 unchanged marked final · 2 not importable',
    );
  });

  it('offers to mark the confirmed unchanged rows final, ticked by default', () => {
    const { el, render } = mount();
    const footer = el.querySelector('lx-import-footer')!;
    const box = footer.querySelector<HTMLButtonElement>('.finalize')!;
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.textContent?.replace(/\s+/g, ' ').trim()).toBe('✓ Mark 1 unchanged as ✓✓Final');
    box.click();
    render();
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(footer.textContent).toContain('1 unit will be written · nl 1 · 2 not importable');
  });

  it('marks unchanged rows final alone when nothing else is written', async () => {
    const { el, store, render, applyLabel, applyButton, api, settle, banner } = mount();
    const preview = store.preview()!;
    store.preview.set({ ...preview, rows: preview.rows.filter((r) => r.finalizable) });
    render();
    expect(el.querySelector('.finalize')).not.toBeNull();
    expect(applyLabel()).toBe('Mark 1 unit final');
    api.apply.mockResolvedValueOnce({
      importId: 'imp1',
      at: '2026-10-20T14:30:00',
      written: [{ path: 'locales/nl.xliff', count: 1 }],
    });
    applyButton().click();
    await settle();
    expect(api.apply).toHaveBeenCalledWith(
      expect.objectContaining({ finalizeUnchanged: true, include: [] }),
    );
    expect(banner()).toContain(
      'Marked 1 unit final in nl.xliff. Undo restores the previous states.',
    );
  });

  it('jumps to the first open conflict instead of applying', () => {
    const { applyButton, applyLabel, render, api, tab, selectedId } = mount();
    expect(applyLabel()).toBe('Resolve 1 conflict');
    expect(applyButton().disabled).toBe(false);
    applyButton().click();
    render();
    expect(api.apply).not.toHaveBeenCalled();
    expect(tab('Conflicts').getAttribute('aria-pressed')).toBe('true');
    expect(selectedId()).toBe('account.delete_confirm');
  });

  it('applies the included rows as final, then turns the screen into a record', async () => {
    const { applyButton, applyLabel, render, api, tab, link, settle, banner, rows, el } = mount();
    tab('Conflicts').click();
    render();
    link('Use CSV for all').click();
    render();
    tab('All changes').click();
    render();
    expect(applyLabel()).toBe('Apply 2 changes');
    el.querySelector<HTMLButtonElement>('.finalize')!.click();
    render();
    applyButton().click();
    await settle();
    expect(api.apply).toHaveBeenCalledWith({
      files: [{ name: 'northwind_job13.csv', text: 'Unit ID,…' }],
      jobId: 'j1',
      state: 'final',
      finalizeUnchanged: false,
      include: [
        { key: '0:2', current: 'Later betalen' },
        { key: '0:3', current: 'Hesabınızı silmek istiyor musunuz?' },
      ],
    });
    expect(applyLabel()).toBe('Applied');
    expect(applyButton().disabled).toBe(true);
    expect(banner()).toContain(
      'Wrote 2 units to nl.xliff and tr.xliff as final. Undo restores the previous targets.',
    );
    expect(banner()).toContain('Undo import');
    expect(banner()).toContain('Back to Jobs');
    expect(el.querySelector('lx-import-footer')?.textContent).toContain('Import applied');
    rows()[0]!.querySelector<HTMLElement>('.box')!.click();
    render();
    expect(rows()[0]!.getAttribute('aria-checked')).toBe('true');
    expect(rows()[0]!.querySelector('lx-import-status-chip')?.textContent?.trim()).toBe('applied');
  });

  it('shows a 409 in the banner and leaves Apply enabled', async () => {
    const { applyButton, api, settle, banner, rows, render, el } = mount();
    api.apply.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'conflict',
            message: 'checkout.pay_later (nl) changed since the preview.',
          },
        },
      }),
    );
    rows()[1]!.click();
    render();
    // Decide the one conflict so Apply is on offer.
    el.querySelectorAll<HTMLElement>('.detail lx-radio-card')[1]!.click();
    render();
    applyButton().click();
    await settle();
    expect(banner()).toBe('checkout.pay_later (nl) changed since the preview.');
    expect(applyButton().disabled).toBe(false);
    expect(applyButton().textContent?.trim()).toBe('Apply 1 change');
  });

  it('offers to undo the files a partial save did write', async () => {
    const { applyButton, api, settle, banner, rows, render, el } = mount();
    api.apply.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'conflict',
            message:
              'Could not write locales/tr.xliff. Those rows were not imported; the other files were written.',
            details: { importId: 'imp9', notWritten: ['locales/tr.xliff'] },
          },
        },
      }),
    );
    rows()[1]!.click();
    render();
    el.querySelectorAll<HTMLElement>('.detail lx-radio-card')[0]!.click();
    render();
    applyButton().click();
    await settle();
    expect(banner()).toContain('Could not write locales/tr.xliff.');
    expect(banner()).toContain('Some files were written: Undo import');
    expect(banner()).toContain('Not written: locales/tr.xliff');
    el.querySelector<HTMLButtonElement>('.banner .undo')!.click();
    await settle();
    expect(api.undo).toHaveBeenCalledWith('imp9');
  });

  it('undoes an applied import with the id the server returned', async () => {
    const { applyButton, api, settle, banner, link, tab, render, el } = mount();
    tab('Conflicts').click();
    render();
    link('Use CSV for all').click();
    render();
    applyButton().click();
    await settle();
    el.querySelector<HTMLButtonElement>('.banner .undo')!.click();
    await settle();
    expect(api.undo).toHaveBeenCalledWith('imp1');
    expect(banner()).toContain('Import undone. 1 restored, 1 skipped because they changed since');
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().textContent?.trim()).toBe('Undone');
    const summary = el.querySelector('lx-import-footer .summary')?.textContent?.trim();
    expect(summary).toBe('Import undone');
  });

  it('notes a conflict changed by an unknown author without naming one', () => {
    const { store, rows, render } = mount();
    const preview = store.preview()!;
    store.preview.set({
      ...preview,
      rows: preview.rows.map((r) =>
        r.category === 'conflict' ? { ...r, currentChangedBy: null } : r,
      ),
    });
    render();
    const note = rows()[1]!.textContent!.replace(/\s+/g, ' ');
    expect(note).toContain('Changed in Lexi after export');
    expect(note).not.toContain('edited in Lexi');
  });

  it('cancels by clearing the store and going back to Jobs', () => {
    const { el, store } = mount();
    const router = TestBed.inject(Router);
    const go = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    [...el.querySelectorAll<HTMLButtonElement>('lx-import-footer button')]
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click();
    expect(store.clear).toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith('/jobs');
  });

  describe('after a partial save', () => {
    const partial = () =>
      new HttpErrorResponse({
        status: 409,
        error: {
          error: {
            code: 'conflict',
            message: 'Could not write locales/tr.xliff.',
            details: { importId: 'imp9', notWritten: ['locales/tr.xliff'] },
          },
        },
      });

    /** Decides the conflict as Use CSV and applies into a partial 409. */
    async function partlyApplied() {
      const m = mount();
      m.api.apply.mockRejectedValueOnce(partial());
      m.rows()[1]!.click();
      m.render();
      m.el.querySelectorAll<HTMLElement>('.detail lx-radio-card')[0]!.click();
      m.render();
      m.applyButton().click();
      await m.settle();
      return m;
    }

    it('Apply is blocked after a partial save until its undo succeeds', async () => {
      const { applyButton, api, render, banner } = await partlyApplied();
      expect(applyButton().disabled).toBe(true);
      expect(applyButton().getAttribute('title')).toBe('Undo the partly written import first');
      applyButton().click();
      render();
      expect(api.apply).toHaveBeenCalledTimes(1);
      expect(banner()).toContain('Some files were written: Undo import');
    });

    it('a failed undo keeps the Undo offer', async () => {
      const { api, el, settle, banner, applyButton } = await partlyApplied();
      api.undo.mockRejectedValueOnce(
        new HttpErrorResponse({
          status: 500,
          error: { error: { code: 'internal', message: 'The disk is full.' } },
        }),
      );
      el.querySelector<HTMLButtonElement>('.banner .undo')!.click();
      await settle();
      expect(banner()).toContain('The disk is full.');
      expect(banner()).toContain('Some files were written: Undo import');
      expect(banner()).toContain('Not written: locales/tr.xliff');
      expect(applyButton().disabled).toBe(true);
      el.querySelector<HTMLButtonElement>('.banner .undo')!.click();
      await settle();
      expect(api.undo).toHaveBeenLastCalledWith('imp9');
      expect(api.undo).toHaveBeenCalledTimes(2);
    });

    it('after a successful partial undo, Apply is enabled again', async () => {
      const { el, settle, banner, applyButton, rows } = await partlyApplied();
      el.querySelector<HTMLButtonElement>('.banner .undo')!.click();
      await settle();
      expect(banner()).toContain('Import undone. 1 restored');
      expect(el.querySelector('.banner--error')).toBeNull();
      expect(applyButton().disabled).toBe(false);
      expect(applyButton().getAttribute('title')).toBeNull();
      // Still editable: a change's box toggles.
      rows()[0]!.querySelector<HTMLElement>('.box')!.click();
      await settle();
      expect(rows()[0]!.getAttribute('aria-checked')).toBe('false');
    });
  });
});
