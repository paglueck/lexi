// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { LxPlaceholderChip } from './placeholder-chip.js';

@Component({
  imports: [LxPlaceholderChip],
  template: `
    <span lx-chip label="{{ label }}" id="component"></span>
    <span class="lx-chip" id="raw">{{ label }}</span>
  `,
})
class Host {
  readonly label = '{{ user.name }}';
}

/**
 * The chip's one structural invariant.
 *
 * In M5 the grid renders chips as raw `<span class="lx-chip">` markup rather
 * than one component instance per chip. That only stays pixel-identical while
 * LxPlaceholderChip owns no styles of its own: the moment it does, Angular
 * stamps an _ngcontent attribute on its host and scopes the rule to it, and
 * every raw chip in the grid renders unstyled.
 *
 * Asserting the compiled component carries zero styles tests exactly that
 * mechanism — and unlike a computed-style comparison it does not need a real
 * browser to mean something.
 */
describe('LxPlaceholderChip', () => {
  it('declares no component styles, so raw .lx-chip markup renders identically', () => {
    const def = (LxPlaceholderChip as unknown as { ɵcmp: { styles: readonly string[] } }).ɵcmp;
    expect(def.styles).toEqual([]);
  });

  it('applies the global class rather than a scoped one', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const component = el.querySelector('#component')!;
    const raw = el.querySelector('#raw')!;

    expect(component.classList.contains('lx-chip')).toBe(true);
    expect(raw.classList.contains('lx-chip')).toBe(true);

    // No view-encapsulation attribute on either — same CSS rule reaches both.
    const scoped = (node: Element): string[] =>
      [...node.attributes].map((a) => a.name).filter((n) => n.startsWith('_ngcontent'));
    expect(scoped(component)).toEqual(scoped(raw));
  });

  it('renders the equiv-text label and exposes it as a tooltip', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const component = (fixture.nativeElement as HTMLElement).querySelector('#component')!;

    expect(component.textContent).toBe('{{ user.name }}');
    expect(component.getAttribute('title')).toBe('{{ user.name }}');
  });

  it('marks the missing variant as an interactive insert slot (FR-3.8)', () => {
    @Component({
      imports: [LxPlaceholderChip],
      template: `<span lx-chip missing label="X"></span>`,
    })
    class MissingHost {}

    const fixture = TestBed.createComponent(MissingHost);
    fixture.detectChanges();
    const chip = (fixture.nativeElement as HTMLElement).querySelector('span')!;

    expect(chip.getAttribute('data-variant')).toBe('missing');
    expect(chip.getAttribute('role')).toBe('button');
    expect(chip.getAttribute('tabindex')).toBe('0');
  });
});
