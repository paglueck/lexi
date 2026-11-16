// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { UnitRow } from '@lexi/shared';

import { LxGridRow } from './grid-row.js';

/**
 * The grid row's three architectural promises, asserted rather than trusted.
 *
 * All three are invisible to a screenshot and all three are the kind of thing a
 * well-meaning refactor undoes: swapping a raw chip span for the component,
 * reaching for `ngClass` instead of a data attribute, or dropping the sr-only
 * state name because the glyph "already shows it".
 */

const row = (over: Partial<UnitRow> = {}): UnitRow => ({
  rowId: 'messagespay',
  unitId: 'checkout.pay_now',
  group: 'messages',
  customId: true,
  isIcu: false,
  source: [
    { k: 't', v: 'You have ' },
    { k: 'p', id: 'INTERPOLATION', equivText: '{{ count }}' },
    { k: 't', v: ' invoices' },
  ],
  cells: {
    de: { state: 'reviewed', error: false, missing: false, segments: [{ k: 't', v: 'Sie haben' }] },
    fr: { state: 'needsReview', error: true, missing: false, segments: [{ k: 't', v: 'Vous' }] },
  },
  ...over,
});

@Component({
  imports: [LxGridRow],
  template: `<lx-grid-row
    [row]="data()"
    [locales]="['de', 'fr']"
    [selected]="selected()"
    [editLocale]="editLocale()"
    [picked]="picked()"
  />`,
})
class Host {
  readonly data = signal<UnitRow | undefined>(row());
  readonly selected = signal(false);
  readonly editLocale = signal<string | null>(null);
  readonly picked = signal<ReadonlySet<string> | null>(null);
}

const mount = () => {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
};

describe('LxGridRow', () => {
  it('renders placeholders as RAW .lx-chip spans, never as components', () => {
    // 12 columns x ~45 visible rows would otherwise be hundreds of component
    // instances churning on every scroll frame. LxPlaceholderChip declares no
    // styles precisely so these raw spans look identical.
    const el = mount().nativeElement as HTMLElement;
    const chips = el.querySelectorAll('.lx-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent?.trim()).toBe('{{ count }}');
    expect(el.querySelector('span[lx-chip]')).toBeNull();
  });

  it('carries colour only through data attributes, never inline styles', () => {
    const el = mount().nativeElement as HTMLElement;
    const cells = el.querySelectorAll('.c-tgt');

    expect(cells[0]?.getAttribute('data-state')).toBe('reviewed');
    expect(cells[0]?.getAttribute('data-error')).toBeNull();
    expect(cells[1]?.getAttribute('data-state')).toBe('needsReview');
    expect(cells[1]?.getAttribute('data-error')).toBe('true');

    // ngClass/ngStyle object literals allocate on every change-detection pass.
    for (const cell of cells) expect(cell.getAttribute('style')).toBeNull();
  });

  it('never states a translation status by colour alone (FR-3.7)', () => {
    const el = mount().nativeElement as HTMLElement;
    const badges = el.querySelectorAll('.c-tgt .lx-badge');

    expect(badges[0]?.querySelector('.sr-only')?.textContent).toBe('Reviewed');
    // An error is an overlay on a state, so the label must say both.
    expect(badges[1]?.querySelector('.sr-only')?.textContent).toBe(
      'Needs review, validation error',
    );
    expect(badges[0]?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders a skeleton while its window is in flight, not an empty row', () => {
    // A fling outruns the fetch by design; collapsing the row would make the
    // list look full of holes and would break the fixed 34px scroll height.
    const fixture = mount();
    fixture.componentInstance.data.set(undefined);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.bone').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('[role="gridcell"]')).toHaveLength(4);
  });

  it('marks selection as an attribute, so the highlight is pure CSS', () => {
    const fixture = mount();
    const host = (fixture.nativeElement as HTMLElement).querySelector('lx-grid-row');
    expect(host?.getAttribute('data-selected')).toBeNull();

    fixture.componentInstance.selected.set(true);
    fixture.detectChanges();
    expect(host?.getAttribute('data-selected')).toBe('true');
  });

  it('shows the ICU badge only for an ICU unit (FR-PH-4)', () => {
    const fixture = mount();
    expect((fixture.nativeElement as HTMLElement).querySelector('.icu')).toBeNull();

    fixture.componentInstance.data.set(row({ isIcu: true }));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.icu')?.textContent).toContain(
      'ICU',
    );
  });

  it('marks exactly the cell being edited, by attribute, and moves the mark with the locale', () => {
    const fixture = mount();
    fixture.componentInstance.selected.set(true);
    fixture.componentInstance.editLocale.set('fr');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const marked = () =>
      [...el.querySelectorAll('.c-tgt')].map((c) => c.getAttribute('data-editing'));
    expect(marked()).toEqual([null, 'true']);
    // Still paintable by CSS alone: the mark is an attribute, never a style.
    expect([...el.querySelectorAll('.c-tgt')].every((c) => !c.hasAttribute('style'))).toBe(true);

    fixture.componentInstance.editLocale.set('de');
    fixture.detectChanges();
    expect(marked()).toEqual(['true', null]);

    fixture.componentInstance.editLocale.set(null);
    fixture.detectChanges();
    expect(marked()).toEqual([null, null]);
  });

  it('marks the cells of a multi-selection by attribute, on any row', () => {
    const fixture = mount();
    const el = fixture.nativeElement as HTMLElement;
    const picked = () =>
      [...el.querySelectorAll('.c-tgt')].map((c) => c.getAttribute('data-picked'));
    expect(picked()).toEqual([null, null]);

    // Not the selected row: a range spans rows the single selection is not on.
    fixture.componentInstance.picked.set(new Set(['fr']));
    fixture.detectChanges();
    expect(picked()).toEqual([null, 'true']);

    fixture.componentInstance.picked.set(new Set(['de', 'fr']));
    fixture.detectChanges();
    expect(picked()).toEqual(['true', 'true']);
  });
});
