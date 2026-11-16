// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReportQuery } from '@lexi/shared';

import { LxReportExportModal, readReportChoice } from './report-export-modal.js';

/**
 * The export modal only decides; the job card downloads. What is pinned here
 * is that the separator is offered for CSV alone, that Export closes with the
 * choice, and that the choice is remembered for the next job.
 */

let closed: ReportQuery | undefined;

const setup = (localeCount: number) => {
  localStorage.clear();
  closed = undefined;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DIALOG_DATA, useValue: { locales: 'de', localeCount } },
      {
        provide: DialogRef,
        useValue: { close: (value?: ReportQuery) => (closed = value) } as Partial<DialogRef>,
      },
    ],
  });
};

beforeEach(() => setup(1));

afterEach(() => localStorage.clear());

const mount = () => {
  const fixture = TestBed.createComponent(LxReportExportModal);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const click = (target: Element | null | undefined) => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
  };
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes(text),
    );
  return { el, click, button };
};

describe('LxReportExportModal', () => {
  it('defaults to the HTML report and offers no separator for it', () => {
    const { el, click, button } = mount();
    expect(
      el.querySelector('lx-radio-card[data-format="html"][aria-checked="true"]'),
    ).not.toBeNull();
    expect(el.querySelector('lx-segmented-control')).toBeNull();
    click(button('Export'));
    expect(closed).toEqual({ format: 'html', delimiter: ';', split: 'single' });
  });

  it('offers the separator for CSV and closes with what was picked', () => {
    const { el, click, button } = mount();
    click(el.querySelector('lx-radio-card[data-format="csv"]'));
    expect(el.querySelector('lx-segmented-control')).not.toBeNull();
    click(button('Comma'));
    click(button('Export'));
    expect(closed).toEqual({ format: 'csv', delimiter: ',', split: 'single' });
  });

  it('closes with nothing when cancelled', () => {
    const { click, button } = mount();
    click(button('Cancel'));
    expect(closed).toBeUndefined();
  });

  it('remembers the last export, and ignores a stored value it does not know', () => {
    const { el, click, button } = mount();
    click(el.querySelector('lx-radio-card[data-format="csv"]'));
    click(button('Export'));
    expect(readReportChoice()).toEqual({ format: 'csv', delimiter: ';', split: 'single' });

    localStorage.setItem('lexi.report-export', JSON.stringify({ format: 'pdf', delimiter: '|' }));
    expect(readReportChoice()).toEqual({ format: 'html', delimiter: ';', split: 'single' });
  });

  it('offers one file per locale for a multi-locale CSV, and remembers it', () => {
    setup(2);
    const { el, click, button } = mount();
    expect(el.querySelector('[data-files]')).toBeNull();
    click(el.querySelector('lx-radio-card[data-format="csv"]'));
    expect(el.querySelector('[data-files]')).not.toBeNull();
    click(button('One per locale'));
    click(button('Export'));
    expect(closed).toEqual({ format: 'csv', delimiter: ';', split: 'perLocale' });
    expect(readReportChoice().split).toBe('perLocale');
  });

  it('offers no Files choice for one locale and exports a single file regardless', () => {
    localStorage.setItem(
      'lexi.report-export',
      JSON.stringify({ format: 'csv', delimiter: ';', split: 'perLocale' }),
    );
    const { el, click, button } = mount();
    expect(el.querySelector('[data-files]')).toBeNull();
    click(button('Export'));
    expect(closed).toEqual({ format: 'csv', delimiter: ';', split: 'single' });
    expect(readReportChoice().split).toBe('perLocale');
  });
});
