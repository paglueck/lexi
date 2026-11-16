// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { LxButton } from './button.js';
import { ICON_NAMES, LxIcon } from './icon.js';

// Resolved from the working directory, not import.meta.url: the Angular test
// builder virtualises module URLs (same note as tokens.spec.ts).
const APP = join(process.cwd(), 'src', 'app');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ((p.endsWith('.html') || p.endsWith('.ts')) && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

@Component({
  imports: [LxButton, LxIcon],
  template: `
    @for (name of names; track name) {
      <button type="button" lx-button variant="ghost" size="xs" iconOnly [attr.aria-label]="name">
        <lx-icon [name]="name" />
      </button>
    }
  `,
})
class Host {
  readonly names = ICON_NAMES;
}

describe('LxIcon', () => {
  it('renders every icon as a decorative, currentColor SVG with at least one path', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const svgs = [...(fixture.nativeElement as HTMLElement).querySelectorAll('lx-icon svg')];

    expect(svgs).toHaveLength(ICON_NAMES.length);
    for (const svg of svgs) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('stroke')).toBe('currentColor');
      expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
      for (const path of svg.querySelectorAll('path')) {
        expect(path.getAttribute('d')).toMatch(/^[Mm]/);
      }
    }
  });

  it('marks an icon-only button so the square geometry applies', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(button.hasAttribute('data-icon-only')).toBe(true);
    expect(button.getAttribute('data-variant')).toBe('ghost');
  });
});

/**
 * An icon-only button has no visible text, so without an `aria-label` a screen
 * reader announces it as "button" and nothing else. A static scan rather than a
 * render test, because the rule has to hold for every template in the app, not
 * for the ones a test happens to mount.
 */
describe('icon-only buttons', () => {
  it('always carry an aria-label', () => {
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<(?:button|a)\b[^>]*\biconOnly\b[^>]*>/g)) {
        if (!/\baria-label\b|\[attr\.aria-label\]/.test(m[0])) {
          offenders.push(`${file.slice(APP.length + 1)}: ${m[0].replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
