// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { CsvImportRow } from '@lexi/shared';

import { importRow, previewFixture } from '../../core/testing/csv-import-fixture.js';
import { LxImportDetail } from './import-detail.js';
import type { ImportChip } from './import-model.js';

const rowOf = (unitId: string): CsvImportRow =>
  previewFixture().rows.find((r) => r.unitId === unitId)!;

function mount(row: CsvImportRow, chip: ImportChip, readOnly = false) {
  const fixture = TestBed.createComponent(LxImportDetail);
  fixture.componentRef.setInput('row', row);
  fixture.componentRef.setInput('chip', chip);
  fixture.componentRef.setInput('sourceLocale', 'en-GB');
  fixture.componentRef.setInput('exportedAt', '2026-10-20T13:14:00');
  fixture.componentRef.setInput('readOnly', readOnly);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const text = () => el.textContent!.replace(/\s+/g, ' ');
  const toggles: number[] = [];
  const resolved: string[] = [];
  fixture.componentInstance.includeToggle.subscribe(() => toggles.push(1));
  fixture.componentInstance.resolve.subscribe((c) => resolved.push(c));
  return { fixture, el, text, toggles, resolved };
}

describe('LxImportDetail', () => {
  it('shows a change as Lexi now against the CSV, with the stat line and checks', () => {
    const { text, el } = mount(importRow(), 'changed');
    expect(text()).toContain('Source · en-GB');
    expect(text()).toContain('Pay later');
    expect(text()).toContain('In Lexi now');
    expect(text()).toContain('13 chars');
    expect(text()).toContain('From CSV');
    expect(text()).toContain('16 chars');
    expect(text()).toContain('1 word removed · 1 word added');
    const checks = [...el.querySelectorAll('.check')].map((c) => c.textContent!.trim());
    expect(checks).toEqual([
      '✓ Placeholders and markup match source',
      '✓ Source unchanged since export',
    ]);
    expect(text()).toContain('Include in import');
    expect(text()).toContain('space');
  });

  it('counts a trailing append as words added, none removed', () => {
    const { text } = mount(
      importRow({
        current: [{ k: 't', v: 'Facturation' }],
        csv: [{ k: 't', v: 'Facturation et paiement' }],
      }),
      'changed',
    );
    expect(text()).toContain('0 words removed · 2 words added');
  });

  it('flags a changed source and lists the warnings; omits the source check when unknown', () => {
    const changed = mount(
      importRow({ checks: { placeholders: true, sourceUnchanged: false }, warnings: ['Too long'] }),
      'warning',
    );
    const marks = [...changed.el.querySelectorAll('.check')].map((c) => c.textContent!.trim());
    expect(marks).toEqual([
      '✓ Placeholders and markup match source',
      '! Source changed since export',
      '! Too long',
    ]);
    const unknown = mount(
      importRow({ checks: { placeholders: true, sourceUnchanged: null } }),
      'changed',
    );
    expect(unknown.el.querySelectorAll('.check').length).toBe(1);
  });

  it('toggles the include box unless read-only', () => {
    const live = mount(importRow(), 'changed');
    const box = live.el.querySelector<HTMLElement>('.include')!;
    expect(box.getAttribute('aria-checked')).toBe('true');
    box.click();
    expect(live.toggles).toEqual([1]);

    const done = mount(importRow(), 'applied', true);
    done.el.querySelector<HTMLElement>('.include')!.click();
    expect(done.toggles).toEqual([]);
  });

  it('offers a conflict as two radio cards against the export', () => {
    const { el, text, resolved } = mount(rowOf('account.delete_confirm'), 'decide');
    expect(text()).toContain(
      'This unit changed in Lexi after the export. Choose which version to keep.',
    );
    expect(text()).toContain('At export · 13:14');
    expect(text()).toContain('Hesabınız silinsin mi?');
    expect(text()).toContain('Highlights show each version against the export.');
    expect(el.querySelector('.checks')).toBeNull();
    const cards = [...el.querySelectorAll<HTMLElement>('lx-radio-card')];
    expect(cards.map((c) => c.querySelector('.title')?.textContent?.trim())).toEqual([
      'Use CSV',
      'Keep current',
    ]);
    expect(cards[0]!.textContent).toContain('reviewer');
    expect(cards[1]!.textContent).toContain('edited in Grid');
    expect(cards.every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true);
    cards[1]!.click();
    expect(resolved).toEqual(['current']);
  });

  it('reaches an undecided conflict by Tab and decides it with Space or the arrows', () => {
    const { el, fixture, resolved } = mount(rowOf('account.delete_confirm'), 'decide');
    const cards = [...el.querySelectorAll<HTMLElement>('lx-radio-card')];
    expect(cards.map((c) => c.getAttribute('tabindex'))).toEqual(['0', '-1']);
    const key = (target: HTMLElement, k: string) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
      );
    key(cards[0]!, ' ');
    key(cards[0]!, 'ArrowDown');
    expect(resolved).toEqual(['csv', 'current']);
    // Once the page records the choice, the chosen card is the tab stop.
    fixture.componentRef.setInput('chip', 'keepCurrent');
    fixture.detectChanges();
    expect(cards.map((c) => c.getAttribute('tabindex'))).toEqual(['-1', '0']);
  });

  it('shows a cell the export wrote empty as "empty" in the At export card', () => {
    const { el } = mount({ ...rowOf('account.delete_confirm'), exported: [] }, 'decide');
    const empty = el.querySelector('.card--tight .exported--empty');
    expect(empty?.textContent?.trim()).toBe('empty');
  });

  it('marks the chosen version and ignores clicks once read-only', () => {
    const { el, text, resolved } = mount(rowOf('account.delete_confirm'), 'applied', true);
    // The question is settled once applied; the notice no longer asks it.
    expect(text()).toContain('This unit changed in Lexi after the export.');
    expect(text()).not.toContain('Choose which version to keep');
    const cards = [...el.querySelectorAll<HTMLElement>('lx-radio-card')];
    expect(cards[0]!.getAttribute('aria-checked')).toBe('true');
    cards[1]!.click();
    expect(resolved).toEqual([]);
  });

  it('explains a row that cannot be imported', () => {
    const blocked = mount(rowOf('orders.status_shipped'), 'blocked');
    expect(blocked.el.querySelector('.reason')?.getAttribute('data-tone')).toBe('blocked');
    expect(blocked.text()).toContain('Unknown locale "tr-TR"');
    expect(blocked.text()).toContain('In CSV');
    expect(blocked.text()).toContain('Kargoya verildi');
    expect(blocked.text()).toContain(
      'This row is left out. Fix it in the CSV and choose the file again; the other rows are not affected.',
    );
    // The unit does not exist, so there is no source to show.
    expect(blocked.text()).not.toContain('Source ·');

    const skipped = mount(rowOf('checkout.card_label'), 'skipped');
    expect(skipped.el.querySelector('.reason')?.getAttribute('data-tone')).toBe('skipped');
    expect(skipped.el.querySelector('.csv--empty')?.textContent?.trim()).toBe('empty cell');
  });
});
