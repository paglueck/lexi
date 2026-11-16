// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  LocaleSummary,
  Project,
  Term,
  TermBaseResponse,
  TermImportRequest,
} from '@lexi/shared';

import { ProjectStore } from '../../core/stores/project-store.js';
import { TermBasePage } from './termbase-page.js';

/**
 * S13, the Term Base. Asserted: the fallback rule is visible (an empty locale
 * shows the source, never an error), DNT locks without deleting, and the
 * import preview promises exactly what the server will do. Geometry and colour
 * are the kitchen sink's job.
 */

const locale = (code: string, isRtl = false): LocaleSummary => ({
  locale: code,
  isRtl,
  fileCount: 1,
  unitCount: 10,
  translated: 0,
  untranslated: 10,
  draftMachine: 0,
  needsReview: 0,
  missing: 0,
  orphans: 0,
});

const project = (): Project => ({
  path: '/x/northwind',
  name: 'northwind',
  sourceLocale: 'en-GB',
  files: [],
  locales: [locale('de'), locale('pl'), locale('ar', true)],
  unitCount: 10,
  customIdShare: 0,
  health: {
    units: 10,
    unitsWithNote: 0,
    noteCoverage: 0,
    customIdUnits: 0,
    customIdShare: 0,
    errorCells: 0,
    warningCells: 0,
    staleUnits: 0,
    issues: [],
  },
  editRate: [],
  visibleLocales: ['de'],
  filters: [],
  groups: ['messages'],
  openedAt: new Date().toISOString(),
  writeState: 'auto',
  escapePolicy: 'angular',
  severities: {},
});

const term = (id: string, over: Partial<Term> = {}): Term => ({
  id,
  term: id,
  note: '',
  dnt: false,
  translations: {},
  ...over,
});

const TERMS = [
  term('checkout', { note: 'Checkout flow', translations: { de: 'Kasse', ar: 'الدفع' } }),
  term('Northwind', { dnt: true, translations: { de: 'Nordwind' } }),
  term('invoice', { translations: { de: 'Rechnung', pl: 'Faktura', ar: 'فاتورة' } }),
];

const listing = (
  terms: readonly Term[] = TERMS,
  over: Partial<TermBaseResponse> = {},
): TermBaseResponse => ({
  terms: [...terms],
  total: terms.length,
  path: '.lexi/termbase.csv',
  linked: false,
  available: true,
  ...over,
});

const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let http: HttpTestingController;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  http = TestBed.inject(HttpTestingController);
  TestBed.inject(ProjectStore).set(project());
});

afterEach(() => {
  http.verify();
});

const mount = async (terms: readonly Term[] = TERMS, over: Partial<TermBaseResponse> = {}) => {
  const fixture = TestBed.createComponent(TermBasePage);
  fixture.detectChanges();
  http.expectOne('/api/termbase').flush(listing(terms, over));
  await settled();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
};

const rows = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('.row:not(.row--head)'),
];
const button = (el: Element, name: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => text(b).startsWith(name));
const importButton = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('lx-import-dialog .foot [data-variant="primary"]')!;

describe('TermBasePage', () => {
  it('shows one column per project locale, and an empty locale as the source term', async () => {
    const { el } = await mount();
    expect([...el.querySelectorAll('.th')].map(text)).toEqual(['Term', 'DNT', 'de', 'pl', 'ar']);

    const checkout = rows(el)[0]!;
    const cells = [...checkout.querySelectorAll('.cell--locale')];
    expect(text(cells[0])).toBe('Kasse');
    // pl is empty: it keeps the source, shown as "= checkout", not as a gap.
    expect(cells[1]?.querySelector('.same')).not.toBeNull();
    expect(text(cells[1])).toContain('checkout');
    expect(cells[2]?.querySelector('.tr')?.getAttribute('dir')).toBe('rtl');
  });

  it('merges a DNT row into one cell', async () => {
    const { el } = await mount();
    const northwind = rows(el)[1]!;
    expect(northwind.querySelectorAll('.cell--locale')).toHaveLength(0);
    expect(text(northwind.querySelector('.cell--merged'))).toContain(
      'Kept as source in all locales',
    );
  });

  it('filters by kind and searches terms and translations', async () => {
    const { fixture, el } = await mount();
    const counts = [...el.querySelectorAll('.filter')].map(text);
    expect(counts).toEqual(['All3', 'Translated2', 'DNT1', 'Uses source1']);

    button(el, 'Uses source')!.click();
    fixture.detectChanges();
    expect(rows(el).map((r) => text(r.querySelector('.term')))).toEqual(['checkout']);

    button(el, 'All')!.click();
    const search = el.querySelector<HTMLInputElement>('.search')!;
    search.value = 'faktura';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows(el).map((r) => text(r.querySelector('.term')))).toEqual(['invoice']);
  });

  it('toggles DNT from the table without selecting the row', async () => {
    const { fixture, el } = await mount();
    rows(el)[2]!.querySelector<HTMLButtonElement>('.check')!.click();
    fixture.detectChanges();
    // The first term stays selected; the toggled one is DNT at once.
    expect(rows(el)[0]?.getAttribute('aria-selected')).toBe('true');
    expect(rows(el)[2]?.querySelector('.cell--merged')).not.toBeNull();

    await settled();
    const req = http.expectOne('/api/termbase/invoice');
    expect(req.request.body).toEqual({ dnt: true });
    req.flush({ ...TERMS[2], dnt: true });
  });

  it('hides a DNT term’s locale fields and says its stored translations come back', async () => {
    const { fixture, el } = await mount();
    rows(el)[1]!.click();
    fixture.detectChanges();

    const editor = el.querySelector('.editor')!;
    expect(editor.querySelector('.locales')).toBeNull();
    expect(editor.querySelector('.locale input')).toBeNull();
    expect(text(editor.querySelector('.stored'))).toBe(
      '1 stored translation stays in termbase.csv and comes back if DNT is turned off.',
    );
    expect(text(editor.querySelector('.prompt'))).toBe(
      '- "Northwind": do not translate, keep exactly as written',
    );
  });

  it('writes a translation after a pause and previews the prompt line', async () => {
    const { fixture, el } = await mount();
    const editor = el.querySelector('.editor')!;
    expect(text(editor.querySelector('.status'))).toBe('2 translated · 1 as source');
    expect(text(editor.querySelector('.prompt'))).toBe('- "checkout" → "Kasse" (Checkout flow)');

    const de = editor.querySelector<HTMLInputElement>('#tr-de')!;
    de.value = '';
    de.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(text(editor.querySelector('.prompt'))).toBe(
      '- "checkout": keep as written (no de translation) (Checkout flow)',
    );

    await new Promise((resolve) => setTimeout(resolve, 350));
    const req = http.expectOne('/api/termbase/checkout');
    expect(req.request.body).toEqual({ translations: { ar: 'الدفع' } });
    req.flush({ ...TERMS[0], translations: { ar: 'الدفع' } });
  });

  it('adds an untitled term on top and selects it', async () => {
    const { fixture, el } = await mount();
    button(el, 'Add term')!.click();
    http.expectOne({ method: 'POST', url: '/api/termbase' }).flush(term('new', { term: '' }));
    await settled();
    fixture.detectChanges();
    expect(text(rows(el)[0]?.querySelector('.term'))).toBe('New term');
    expect(rows(el)[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('deletes only on the second click', async () => {
    const { fixture, el } = await mount();
    button(el, 'Delete term')!.click();
    fixture.detectChanges();
    http.expectNone('/api/termbase/checkout');
    button(el, 'Click again to delete')!.click();
    http
      .expectOne({ method: 'DELETE', url: '/api/termbase/checkout' })
      .flush(listing(TERMS.slice(1)));
    await settled();
    fixture.detectChanges();
    expect(rows(el)).toHaveLength(2);
    expect(rows(el)[0]?.getAttribute('aria-selected')).toBe('true');
  });

  describe('a shared Term Base', () => {
    it('offers to link one while the project uses its own file', async () => {
      const { el } = await mount();
      expect(button(el, 'Link shared folder…')).toBeDefined();
      expect(el.querySelector('lx-badge')).toBeNull();
    });

    it('marks a linked file as shared, and says when its folder is missing', async () => {
      const { el } = await mount([], {
        path: '/Users/me/lexi-shared/termbase.csv',
        linked: true,
        available: false,
      });
      expect(text(el.querySelector('.path'))).toBe('/Users/me/lexi-shared/termbase.csv');
      expect(text(el.querySelector('lx-badge'))).toBe('Shared');
      expect(text(el.querySelector('[role="status"]'))).toBe('Shared folder missing');
    });

    it('unlinks and reloads from the project’s own file', async () => {
      const { fixture, el } = await mount([], {
        path: '/Users/me/lexi-shared/termbase.csv',
        linked: true,
      });
      button(el, 'Unlink')!.click();
      const req = http.expectOne({ method: 'PUT', url: '/api/shared-sources' });
      expect(req.request.body).toEqual({ termbase: null });
      req.flush({
        styleguides: { path: null, available: true },
        termbase: { path: null, available: true },
      });
      await settled();
      http.expectOne('/api/termbase').flush(listing());
      await settled();
      fixture.detectChanges();
      expect(rows(el)).toHaveLength(3);
      expect(el.querySelector('lx-badge')).toBeNull();
    });
  });

  describe('CSV import', () => {
    const CSV = [
      'term,note,dnt,de,pl,es',
      'invoice,,no,Rechnung,Faktura VAT,Factura',
      'basket,,no,Warenkorb,,',
      'checkout,Checkout flow,no,Kasse,,',
    ].join('\n');

    const openImport = async () => {
      const mounted = await mount();
      const input = mounted.el.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File([CSV], 'terms.csv', { type: 'text/csv' });
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change'));
      await settled();
      await settled();
      mounted.fixture.detectChanges();
      return mounted;
    };

    it('previews new, updated and unchanged terms and flags unknown columns', async () => {
      const { el } = await openImport();
      const dialog = el.querySelector('lx-import-dialog')!;
      expect(text(dialog.querySelector('.file'))).toBe('terms.csv');
      expect(text(dialog.querySelector('.chip--ignored'))).toBe(
        'es · ignored, not a project locale',
      );

      const statuses = [...dialog.querySelectorAll('.status')].map(text);
      expect(statuses).toEqual(['Update', 'New', 'Unchanged']);
      const firstRow = dialog.querySelectorAll('.prow:not(.prow--head)')[0]!;
      expect(text(firstRow)).toContain('pl changed');
      expect(text(dialog.querySelector('.summary'))).toBe('1 new · 1 update · 1 unchanged');
      expect(text(importButton(el))).toBe('Import 2 terms');
    });

    it('counts only new terms with "Keep existing", and sends the mode to the server', async () => {
      const { fixture, el } = await openImport();
      button(el, 'Keep existing')!.click();
      fixture.detectChanges();
      expect(text(importButton(el))).toBe('Import 1 term');

      importButton(el).click();
      const req = http.expectOne('/api/termbase/import');
      const body = req.request.body as TermImportRequest;
      expect(body.mode).toBe('keep');
      // No ar column in the file: ar is left alone, not cleared.
      expect(body.locales).toEqual(['de', 'pl']);
      expect(body.rows).toHaveLength(3);
      req.flush({ ...listing([term('basket'), ...TERMS]), added: 1, updated: 0, unchanged: 2 });
      await settled();
      fixture.detectChanges();
      expect(el.querySelector('lx-import-dialog')).toBeNull();
      expect(rows(el)).toHaveLength(4);
    });
  });
});
