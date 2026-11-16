// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { escapeText, ESCAPE_POLICIES } from '../src/escape.js';
import { escapeXmlLikeAngular } from './fixtures.js';

describe('escapeText — angular policy', () => {
  it('escapes all five predefined entities, matching @angular/compiler', () => {
    expect(escapeText(`& " ' < >`, 'angular')).toBe('&amp; &quot; &apos; &lt; &gt;');
  });

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    expect(escapeText('&lt;', 'angular')).toBe('&amp;lt;');
  });

  it('agrees with an independent reimplementation of Angular\'s rule', () => {
    const samples = [
      `it's fine`, 'a & b', '<strong>', 'say "hi"', 'plain', '', '&amp;',
      'Grüße & Küsse', 'مرحبا & أهلا', '日本語 & 英語', '𝒜 & ℬ',
    ];
    for (const s of samples) expect(escapeText(s, 'angular')).toBe(escapeXmlLikeAngular(s));
  });

  it('leaves non-ASCII text alone', () => {
    expect(escapeText('Grüße — 日本語 — مرحبا — 😀', 'angular')).toBe('Grüße — 日本語 — مرحبا — 😀');
  });

  it('round-trips through a decode back to the original', () => {
    const original = `Tom & Jerry's "<b>" show`;
    const escaped = escapeText(original, 'angular');
    const decoded = escaped
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(original);
  });
});

describe('escapeText — minimal policy', () => {
  it('escapes only the three characters XML requires in element content', () => {
    expect(escapeText(`& " ' < >`, 'minimal')).toBe(`&amp; " ' &lt; &gt;`);
  });
});

describe('ESCAPE_POLICIES', () => {
  it('lists exactly the supported policies', () => {
    expect([...ESCAPE_POLICIES]).toEqual(['angular', 'minimal']);
  });
});
