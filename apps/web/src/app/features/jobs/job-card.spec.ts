// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { rowIdOf } from '@lexi/shared/constants';
import type { Job, ReportQuery } from '@lexi/shared';

import { UnitsApi } from '../../core/api/units-api.js';
import { stamp } from '../../core/format-time.js';
import { CsvImportStore } from '../../core/stores/csv-import-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { jobFixture, jobLocale } from '../../core/testing/job-fixture.js';
import { LxModalService } from '../../ui/modal.js';
import { LxJobCard } from './job-card.js';

/**
 * S14's card variants, its locale rows and the actions each exposes.
 * `JobsStore` is faked rather than constructed for real — it would otherwise
 * need a live `EventsStore`/`HttpClient` chain for a component test that only
 * cares which method got called with which id.
 */

const job = (over: Parameters<typeof jobFixture>[0] = {}): Job =>
  jobFixture({
    total: 140,
    ids: [],
    currentIndex: 86,
    currentRowId: rowIdOf('messages', '55e1cc0d84fa'),
    accepted: 82,
    rejected: 4,
    avgMsPerUnit: 2100,
    ...over,
  });

/** A three-locale job #14: fr done, de running, pl queued — the design's mock. */
const multi = (over: Partial<Job> = {}): Job =>
  jobFixture({
    number: 14,
    status: 'running',
    currentLocale: 'de',
    avgMsPerUnit: 2000,
    locales: [
      jobLocale({
        locale: 'fr',
        status: 'done',
        total: 24,
        currentIndex: 24,
        accepted: 20,
        rejected: 4,
      }),
      jobLocale({
        locale: 'de',
        status: 'running',
        total: 140,
        currentIndex: 86,
        accepted: 82,
        rejected: 4,
        currentRowId: rowIdOf('messages', '7c0e5512ab90'),
      }),
      jobLocale({ locale: 'pl', status: 'queued', total: 1148 }),
    ],
    ...over,
  });

function mount(initial: Job, others: readonly Job[] = []) {
  const fake = {
    selectedId: signal<string | null>(null),
    jobs: signal<readonly Job[]>([...others, initial]),
    select: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    remove: vi.fn(),
    skipLocale: vi.fn(),
    unskipLocale: vi.fn(),
    downloadReport: vi.fn<(id: string, query: ReportQuery) => Promise<void>>(() =>
      Promise.resolve(),
    ),
  };
  // The export modal is faked too: the test closes it with whatever it chooses.
  const exportClosed = new Subject<ReportQuery | undefined>();
  const modal = { open: vi.fn(() => ({ closed: exportClosed })) };
  const csvImport = { start: vi.fn(), error: () => null, busy: signal(false) };
  const units = {
    detail: vi.fn(() => Promise.resolve({ source: [{ k: 't', v: 'Your session ends soon' }] })),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: JobsStore, useValue: fake },
      { provide: LxModalService, useValue: modal },
      { provide: CsvImportStore, useValue: csvImport },
      { provide: UnitsApi, useValue: units },
      {
        provide: ProjectStore,
        useValue: {
          targetLocales: signal([
            { locale: 'ar', isRtl: true },
            { locale: 'de', isRtl: false },
          ]),
        },
      },
      provideRouter([{ path: 'review', children: [] }]),
    ],
  });

  @Component({
    imports: [LxJobCard],
    template: `<lx-job-card [job]="data()" />`,
  })
  class Host {
    readonly data = signal<Job>(initial);
  }

  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return {
    fixture,
    fake,
    modal,
    units,
    exportClosed,
    csvImport,
    el: fixture.nativeElement as HTMLElement,
  };
}

const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const buttons = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('button')].map((b) => text(b));
const rows = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('lx-job-locale-row'),
];

describe('LxJobCard', () => {
  it('titles the job by its task, its number and up to three locales', () => {
    const { el } = mount(multi());
    expect(text(el.querySelector('.number'))).toBe('#14');
    expect(text(el.querySelector('.title'))).toBe('Draft untranslated units · fr, de, pl');
  });

  it('titles a named job by its name instead', () => {
    const { el } = mount(multi({ name: 'Release 4.2' }));
    expect(text(el.querySelector('.number'))).toBe('#14');
    expect(text(el.querySelector('.title'))).toBe('Release 4.2');
  });

  it('names a job over more than three locales by how many', () => {
    const codes = ['de', 'fr', 'pl', 'it'];
    const { el } = mount(job({ locales: codes.map((locale) => jobLocale({ locale })) }));
    expect(text(el.querySelector('.title'))).toBe('Draft untranslated units · 4 locales');
  });

  it('renders a running job with its totals across locales, which locale it is on, and pause/cancel', () => {
    const { el } = mount(multi());
    const card = el.querySelector('lx-job-card') as HTMLElement;
    expect(card.getAttribute('data-status')).toBe('running');
    const stats = text(el.querySelector('.stats'));
    expect(stats).toContain('110 of 1,312');
    expect(stats).toContain('8 flagged');
    expect(stats).toContain('locale 2 of 3');
    expect(stats).toContain('left');
    expect(buttons(el)).toContain('Pause');
    expect(buttons(el)).toContain('Cancel');
    expect(buttons(el)).not.toContain('Resume');
  });

  it('leaves a skipped locale out of the totals and the locale count', () => {
    const j = multi();
    const { el } = mount({
      ...j,
      locales: j.locales.map((l) => (l.locale === 'pl' ? { ...l, status: 'skipped' } : l)),
    });
    const stats = text(el.querySelector('.stats'));
    expect(stats).toContain('110 of 164');
    expect(stats).toContain('locale 2 of 2');
  });

  it('shows "paused" instead of an ETA, and Resume instead of Pause', () => {
    const j = multi({ status: 'paused' });
    const { el } = mount({
      ...j,
      locales: j.locales.map((l) => (l.locale === 'de' ? { ...l, status: 'paused' } : l)),
    });
    expect(text(el.querySelector('.stats'))).toContain('paused');
    expect(text(el.querySelector('.stats'))).not.toContain('left');
    expect(buttons(el)).toContain('Resume');
    expect(buttons(el)).not.toContain('Pause');
  });

  it('names the locale and unit being drafted now, with its source text', async () => {
    const { el, units, fixture } = mount(multi());
    await fixture.whenStable();
    fixture.detectChanges();
    expect(units.detail).toHaveBeenCalledWith(rowIdOf('messages', '7c0e5512ab90'));
    expect(text(el.querySelector('.now__label'))).toBe('now: de');
    // Shown without the group half or the row id's internal separator.
    expect(text(el.querySelector('.now__id'))).toBe('7c0e5512ab90');
    expect(text(el.querySelector('.now__source'))).toBe('“Your session ends soon”');
  });

  it('renders one row per locale with its counts and status', () => {
    const { el } = mount(multi());
    const [fr, de, pl] = rows(el);
    expect(text(fr)).toContain('fr');
    expect(text(fr)).toContain('French');
    expect(text(fr)).toContain('24 / 24');
    expect(text(fr)).toContain('4 flagged');
    expect(text(fr)).toContain('done');
    expect(text(de)).toContain('86 / 140');
    expect(text(pl)).toContain('0 / 1148');
    expect(text(pl)).not.toContain('flagged');
  });

  it('marks a right-to-left locale', () => {
    const { el } = mount(
      job({
        locales: [jobLocale({ locale: 'ar' }), jobLocale({ locale: 'de', status: 'queued' })],
      }),
    );
    const [ar, de] = rows(el);
    expect(text(ar)).toContain('RTL');
    expect(text(de)).not.toContain('RTL');
  });

  it('offers Skip on a queued locale only, and calls the store without selecting the card', () => {
    const { el, fake } = mount(multi());
    const [fr, de, pl] = rows(el);
    expect(text(fr)).not.toContain('Skip');
    expect(text(de)).not.toContain('Skip');
    const skip = [...pl!.querySelectorAll('button')].find((b) => text(b) === 'Skip');
    skip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.skipLocale).toHaveBeenCalledWith('j1', 'pl');
    expect(fake.select).not.toHaveBeenCalled();
  });

  it('offers Undo on a skipped locale', () => {
    const j = multi();
    const { el, fake } = mount({
      ...j,
      locales: j.locales.map((l) => (l.locale === 'pl' ? { ...l, status: 'skipped' } : l)),
    });
    const undo = [...rows(el)[2]!.querySelectorAll('button')].find((b) => text(b) === 'Undo');
    undo?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.unskipLocale).toHaveBeenCalledWith('j1', 'pl');
  });

  it('renders a queued job with what it will do, what it waits for, and Remove', () => {
    const running = multi({ id: 'j0', number: 14, createdAt: '2026-09-17T09:00:00Z' });
    const queued = job({
      id: 'j15',
      number: 15,
      status: 'queued',
      currentIndex: 0,
      accepted: 0,
      rejected: 0,
      total: 58,
    });
    const { el, fake } = mount(queued, [running]);
    const card = el.querySelector('lx-job-card') as HTMLElement;
    expect(card.getAttribute('data-status')).toBe('queued');
    expect(text(el.querySelector('.stats'))).toContain('58 units');
    expect(text(el.querySelector('.stats'))).toContain('1 locale');
    expect(text(el.querySelector('.stats'))).toContain('~3 min');
    expect(el.textContent).toContain('starts after #14');
    const remove = [...el.querySelectorAll('button')].find((b) => text(b) === 'Remove');
    remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.remove).toHaveBeenCalledWith('j15');
    expect(fake.select).not.toHaveBeenCalled();
  });

  it('says a queued job with nothing ahead of it starts next', () => {
    const { el } = mount(job({ status: 'queued', currentIndex: 0 }));
    expect(el.textContent).toContain('starts next');
  });

  it('renders a finished job with the drafts it wrote, what was rejected, and a flagged-units link', () => {
    const { el } = mount(job({ status: 'done', currentIndex: 140, accepted: 136 }));
    const stats = text(el.querySelector('.stats'));
    expect(stats).toContain('136 drafts written');
    expect(stats).toContain('4 rejected');
    expect(buttons(el).some((b) => b.includes('Show flagged'))).toBe(true);
    // No Skip once a job has finished: there is no turn left to skip.
    expect(buttons(el)).not.toContain('Skip');
  });

  it('omits the flagged-units link when nothing was flagged', () => {
    const { el } = mount(job({ status: 'done', rejected: 0, skipped: 0, failed: 0 }));
    expect(buttons(el).some((b) => b.includes('Show flagged'))).toBe(false);
  });

  it('gives a finished job its finish date and time, and how long it took', () => {
    const finishedAt = '2026-09-21T11:36:14Z';
    const { el } = mount(job({ status: 'done', startedAt: '2026-09-21T11:34:00Z', finishedAt }));
    const note = text(el.querySelector('.row .note'));
    // The date is there even for a job that finished today.
    expect(note).toBe(`${stamp(finishedAt)} · 2 min 14 s`);
    expect(note).toContain(
      new Date(finishedAt).toLocaleDateString([], { day: 'numeric', month: 'short' }),
    );
  });

  it('says a cancelled job was stopped by the user, and when', () => {
    const finishedAt = '2026-09-21T11:36:14Z';
    const { el } = mount(job({ status: 'cancelled', finishedAt }));
    expect(text(el.querySelector('.row .note'))).toBe(`stopped by user · ${stamp(finishedAt)}`);
  });

  it('says a job cancelled before it ran never started', () => {
    const finishedAt = '2026-09-21T11:33:00Z';
    const { el } = mount(job({ status: 'cancelled', startedAt: null, finishedAt }));
    expect(text(el.querySelector('.row .note'))).toBe(
      `cancelled before it started · ${stamp(finishedAt)}`,
    );
  });

  it('offers Remove on a finished job, as a button, without selecting the card', () => {
    const { el, fake } = mount(job({ status: 'done' }));
    const remove = [...el.querySelectorAll<HTMLButtonElement>('button[lx-button]')].find(
      (b) => text(b) === 'Remove',
    );
    expect(remove).toBeDefined();
    remove!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.remove).toHaveBeenCalledWith('j1');
    expect(fake.select).not.toHaveBeenCalled();
  });

  it('offers no Remove while a job runs — it has to be cancelled first', () => {
    const { el } = mount(job({ status: 'running' }));
    expect(buttons(el)).not.toContain('Remove');
  });

  it('clicking Pause calls the store without also selecting the card', () => {
    const { el, fake } = mount(job({ status: 'running' }));
    const pause = [...el.querySelectorAll('button')].find((b) => text(b) === 'Pause');
    pause?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.pause).toHaveBeenCalledWith('j1');
    expect(fake.select).not.toHaveBeenCalled();
  });

  it("clicking Cancel calls the store with this job's id", () => {
    const { el, fake } = mount(job({ status: 'running' }));
    const cancel = [...el.querySelectorAll('button')].find((b) => text(b) === 'Cancel');
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.cancel).toHaveBeenCalledWith('j1');
  });

  it('clicking the card body selects it', () => {
    const { el, fake } = mount(job({ status: 'queued' }));
    (el.querySelector('lx-job-card') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(fake.select).toHaveBeenCalledWith('j1');
  });

  it.each(['queued', 'running', 'done'] as const)(
    'is reachable by keyboard when %s: the title is a button that selects the card, once',
    (status) => {
      const { el, fake } = mount(job({ status }));
      const title = el.querySelector<HTMLButtonElement>('button.title');
      expect(title).not.toBeNull();
      expect(title!.getAttribute('aria-pressed')).toBe('false');
      title!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Not twice: the host's own click handler must not also fire.
      expect(fake.select).toHaveBeenCalledTimes(1);
    },
  );

  const reviewed = (pending: Record<string, number>): Job =>
    job({
      status: 'done',
      locales: Object.entries(pending).map(([locale, n]) =>
        jobLocale({ locale, status: 'done', accepted: 20, currentIndex: 20, pendingReview: n }),
      ),
    });
  const reviewControl = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('.row [lx-button]')].find((b) =>
      text(b).startsWith('Review'),
    );

  it('offers Review as a header button that goes straight to the one locale with drafts to review', () => {
    const { el, fake } = mount(reviewed({ de: 20, fr: 0 }));
    const link = reviewControl(el);
    expect(link?.tagName).toBe('A');
    expect(text(link)).toBe('Review 20');
    expect(link?.getAttribute('href')).toBe('/review?job=j1&locale=de');
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.select).not.toHaveBeenCalled();
    // Review lives in the header now, not on the locale rows.
    expect(el.querySelector('lx-job-locale-row a')).toBeNull();
  });

  it('opens a menu of the locales when several have drafts to review', () => {
    const { el, fixture, fake } = mount({
      ...reviewed({ de: 20, fr: 5, it: 0 }),
      pendingReview: 25,
    });
    const button = reviewControl(el) as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(text(button)).toBe('Review 25');
    expect(el.querySelector('[role="menu"]')).toBeNull();

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(fake.select).not.toHaveBeenCalled();
    const items = [...el.querySelectorAll<HTMLAnchorElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((i) => [text(i), i.getAttribute('href')])).toEqual([
      ['de20', '/review?job=j1&locale=de'],
      ['fr5', '/review?job=j1&locale=fr'],
    ]);

    // A click outside closes it.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it('offers no Review once every draft has been decided, or before the job has finished', () => {
    expect(reviewControl(mount(reviewed({ de: 0 })).el)).toBeUndefined();
    TestBed.resetTestingModule();
    expect(reviewControl(mount(job({ status: 'running' })).el)).toBeUndefined();
  });

  it('clicking "Show flagged units" selects the job with the flagged filter', () => {
    const { el, fake } = mount(job({ status: 'done' }));
    const link = [...el.querySelectorAll('button')].find((b) => text(b).includes('Show flagged'));
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.select).toHaveBeenCalledWith('j1', 'flagged');
  });

  const reportButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    // A real button like Pause and Cancel (`lx-button`), not a text link.
    [...el.querySelectorAll<HTMLButtonElement>('button[lx-button]')].find((b) =>
      text(b).includes('Export'),
    );

  const CSV: ReportQuery = { format: 'csv', delimiter: ';', split: 'single' };

  it('offers the export once a job has finished, and downloads what the modal chose without selecting the card', async () => {
    const { el, fake, modal, exportClosed, fixture } = mount(multi({ status: 'done' }));
    const button = reportButton(el);
    expect(button).toBeDefined();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.open).toHaveBeenCalledWith(expect.anything(), {
      data: { locales: 'fr, de, pl', localeCount: 3 },
    });
    expect(fake.downloadReport).not.toHaveBeenCalled();

    exportClosed.next(CSV);
    await fixture.whenStable();
    expect(fake.downloadReport).toHaveBeenCalledWith('j1', CSV);
    expect(fake.select).not.toHaveBeenCalled();
  });

  it('downloads nothing when the export modal is cancelled', async () => {
    const { el, fake, exportClosed, fixture } = mount(job({ status: 'done' }));
    reportButton(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    exportClosed.next(undefined);
    await fixture.whenStable();
    expect(fake.downloadReport).not.toHaveBeenCalled();
  });

  it('offers no review report while the job is still running', () => {
    const { el } = mount(job({ status: 'running' }));
    expect(reportButton(el)).toBeUndefined();
  });

  it('offers no review report for a job that reached no unit', () => {
    const { el } = mount(job({ status: 'cancelled', currentIndex: 0, accepted: 0, rejected: 0 }));
    expect(reportButton(el)).toBeUndefined();
  });

  it('says so when the report could not be created', async () => {
    const { el, fake, exportClosed, fixture } = mount(job({ status: 'done' }));
    fake.downloadReport.mockRejectedValueOnce(new Error('offline'));
    reportButton(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    exportClosed.next(CSV);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('could not be created');
  });

  it('offers "Import reviewed CSV…" on a finished job that has a report', () => {
    const { el } = mount(job({ status: 'done', accepted: 10, rejected: 0 }));
    expect(buttons(el)).toContain('Import reviewed CSV…');
  });

  it('disables "Import reviewed CSV…" while a pick is being previewed', () => {
    const { el, fixture, csvImport } = mount(job({ status: 'done', accepted: 10, rejected: 0 }));
    const importButton = () =>
      [...el.querySelectorAll('button')].find((b) => text(b) === 'Import reviewed CSV…')!;
    expect(importButton().disabled).toBe(false);
    csvImport.busy.set(true);
    fixture.detectChanges();
    expect(importButton().disabled).toBe(true);
  });
});
