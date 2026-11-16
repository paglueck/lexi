// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { appearsIn, usableTranslation } from '../src/glossary-match.js';

describe('usableTranslation', () => {
  it('prefers the exact locale, then falls back to the language, and ignores blanks', () => {
    expect(usableTranslation({ 'pt-BR': 'Painel', pt: 'Quadro' }, 'pt-BR')).toBe('Painel');
    expect(usableTranslation({ de: 'Übersicht' }, 'de-DE')).toBe('Übersicht');
    expect(usableTranslation({ 'de-DE': '  ', de: 'Übersicht' }, 'de-DE')).toBe('Übersicht');
    expect(usableTranslation({ fr: 'Tableau' }, 'de')).toBe('');
  });
});

describe('appearsIn', () => {
  it('is always case-sensitive', () => {
    expect(appearsIn('Open your Workspace', { term: 'Workspace' })).toBe(true);
    expect(appearsIn('a shared workspace', { term: 'Workspace' })).toBe(false);
    expect(appearsIn('Checkout now', { term: 'checkout' })).toBe(false);
  });

  it('keeps word boundaries for word-shaped terms and never matches an empty term', () => {
    expect(appearsIn('Pack the carton', { term: 'cart' })).toBe(false);
    expect(appearsIn('Add to cart.', { term: 'cart' })).toBe(true);
    expect(appearsIn('anything', { term: '  ' })).toBe(false);
  });
});
