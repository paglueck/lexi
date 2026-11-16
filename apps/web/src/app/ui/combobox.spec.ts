// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { LxCombobox } from './combobox.js';

@Component({
  imports: [LxCombobox],
  template: `<lx-combobox [options]="options" [(value)]="value" label="Locale" />`,
})
class Host {
  readonly options = ['de', 'fr', 'pt-BR', 'pl'];
  readonly value = signal('de');
}

const setup = () => {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, input: host.querySelector('input')! };
};

const options = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[role="option"]')].map((el) => el.textContent?.trim() ?? '');

/**
 * FR-1.3 — the setup wizard's locale cell must accept a manual override.
 *
 * The whole reason the cell is editable is that detection can be wrong, so the
 * assertions that matter are the ones about free text: a typed value survives,
 * and it survives even when it matches none of the suggestions.
 */
describe('LxCombobox', () => {
  it('offers every option once focused', () => {
    const { fixture, host, input } = setup();
    input.dispatchEvent(new Event('focus'));
    fixture.detectChanges();

    expect(options(host)).toEqual(['de', 'fr', 'pt-BR', 'pl']);
  });

  it('filters the list as the user types', () => {
    const { fixture, host, input } = setup();
    input.value = 'p';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(options(host)).toEqual(['pt-BR', 'pl']);
  });

  /** The requirement. A locale we never suggested must still be accepted. */
  it('keeps a value that matches no option at all', () => {
    const { fixture, input } = setup();
    input.value = 'zh-Hant';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('zh-Hant');
  });

  it('shows the full list rather than nothing when the text matches none', () => {
    const { fixture, host, input } = setup();
    input.value = 'zh-Hant';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // An empty menu would imply the typed value is being rejected. It is not.
    expect(options(host)).toHaveLength(4);
  });

  it('commits the highlighted option on Enter', () => {
    const { fixture, input } = setup();
    input.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    // Focus starts on the current value ('de'), so one step down is 'fr'.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('fr');
  });

  /**
   * Filtering on the value the cell already holds would open a menu of one.
   * The reason to open it is to pick something else.
   */
  it('shows every option when focused, not just the current value', () => {
    const { fixture, host, input } = setup();
    expect(fixture.componentInstance.value()).toBe('de');
    input.dispatchEvent(new Event('focus'));
    fixture.detectChanges();

    expect(options(host)).toHaveLength(4);
  });

  /** Otherwise Enter would overwrite a value the user deliberately typed. */
  it('leaves the value alone when Enter arrives with the menu closed', () => {
    const { fixture, input } = setup();
    input.value = 'zh-Hant';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('zh-Hant');
  });

  it('wires the ARIA relationship a combobox needs', () => {
    const { fixture, host, input } = setup();
    input.dispatchEvent(new Event('focus'));
    fixture.detectChanges();

    const list = host.querySelector('[role="listbox"]')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(
      host.querySelector('[role="option"]')!.id,
    );
  });

  it('gives each instance its own listbox id', () => {
    @Component({
      imports: [LxCombobox],
      template: `
        <lx-combobox [options]="o" value="" />
        <lx-combobox [options]="o" value="" />
      `,
    })
    class TwoHost {
      readonly o = ['de'];
    }

    const fixture = TestBed.createComponent(TwoHost);
    fixture.detectChanges();
    const inputs = [...(fixture.nativeElement as HTMLElement).querySelectorAll('input')];

    // Duplicate ids would point both comboboxes at the same listbox.
    expect(inputs[0]!.getAttribute('aria-controls')).not.toBe(
      inputs[1]!.getAttribute('aria-controls'),
    );
  });
});
