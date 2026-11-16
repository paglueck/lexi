// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UNIT_STATES } from '@lexi/shared/constants';

import { LxStateBadge } from './badge.js';
import { STATE_LABEL } from './glyphs.js';

@Component({
  imports: [LxStateBadge],
  template: `
    @for (s of states; track s) {
      <lx-state-badge [state]="s" />
    }
  `,
})
class Host {
  readonly states = UNIT_STATES;
}

/**
 * FR-3.7 — state is never communicated by colour alone.
 *
 * The badge is built so that is structural rather than a habit: the glyph is
 * aria-hidden and the full state name always rides along in an sr-only span.
 * These assertions are what keep it that way.
 */
describe('LxStateBadge', () => {
  it('carries the full state name for every state', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const badges = [...(fixture.nativeElement as HTMLElement).querySelectorAll('lx-state-badge')];

    expect(badges).toHaveLength(UNIT_STATES.length);
    for (const [i, state] of UNIT_STATES.entries()) {
      expect(badges[i]!.textContent).toContain(STATE_LABEL[state]);
    }
  });

  it('hides the glyph from assistive technology and exposes the name instead', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const first = (fixture.nativeElement as HTMLElement).querySelector('lx-state-badge')!;

    expect(first.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(first.querySelector('.sr-only')?.textContent).toBe(STATE_LABEL.untranslated);
  });

  it('drives its colour purely through the data-state attribute', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const badges = [...(fixture.nativeElement as HTMLElement).querySelectorAll('lx-state-badge')];

    expect(badges.map((b) => b.getAttribute('data-state'))).toEqual([...UNIT_STATES]);
    expect(badges.every((b) => b.classList.contains('lx-badge'))).toBe(true);
  });

  it('adds the error overlay and says so in the accessible name', () => {
    @Component({
      imports: [LxStateBadge],
      template: `<lx-state-badge state="draftMachine" error />`,
    })
    class ErrorHost {}

    const fixture = TestBed.createComponent(ErrorHost);
    fixture.detectChanges();
    const badge = (fixture.nativeElement as HTMLElement).querySelector('lx-state-badge')!;

    // The error is an overlay ON a state, not a sixth state.
    expect(badge.getAttribute('data-state')).toBe('draftMachine');
    expect(badge.getAttribute('data-error')).toBe('true');
    expect(badge.textContent).toContain('validation error');
  });
});
