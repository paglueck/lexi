// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { pluralCategoriesFor, assertFullIcu, missingPluralCategories } from '../src/icu/plurals.js';

describe('pluralCategoriesFor', () => {
  it.each([
    ['en-GB', ['one', 'other']],
    ['de', ['one', 'other']],
    ['fr', ['many', 'one', 'other']],
    ['pl', ['few', 'many', 'one', 'other']],
    ['ru', ['few', 'many', 'one', 'other']],
    ['cs', ['few', 'many', 'one', 'other']],
    ['ar', ['few', 'many', 'one', 'other', 'two', 'zero']],
    ['ja', ['other']],
    ['lt', ['few', 'many', 'one', 'other']],
    ['sl', ['few', 'one', 'other', 'two']],
    ['cy', ['few', 'many', 'one', 'other', 'two', 'zero']],
  ])('returns the cardinal categories for %s', (locale, expected) => {
    expect([...pluralCategoriesFor(locale, 'plural')].sort()).toEqual(expected);
  });

  it('returns a different set for ordinals', () => {
    expect([...pluralCategoriesFor('en-GB', 'selectordinal')].sort()).toEqual(['few', 'one', 'other', 'two']);
    expect([...pluralCategoriesFor('de', 'selectordinal')].sort()).toEqual(['other']);
  });

  it('falls back to the bare language when a region is unknown', () => {
    expect([...pluralCategoriesFor('pt-BR', 'plural')].sort()).toEqual(['many', 'one', 'other']);
  });

  it('degrades to just "other" for an unusable tag rather than throwing', () => {
    expect([...pluralCategoriesFor('not a locale', 'plural')]).toEqual(['other']);
  });
});

describe('assertFullIcu', () => {
  it('confirms this runtime has full ICU data', () => {
    // Without it, every locale collapses to English and FR-PH-5 would silently
    // report "all good" for Polish — exactly the failure the rule exists to catch.
    expect(() => assertFullIcu()).not.toThrow();
  });
});

describe('missingPluralCategories', () => {
  it('reports nothing when every category is covered', () => {
    expect(missingPluralCategories('pl', 'plural', ['one', 'few', 'many', 'other'])).toEqual([]);
  });

  it('reports the categories Polish needs but English-shaped ICU omits', () => {
    expect(missingPluralCategories('pl', 'plural', ['one', 'other'])).toEqual(['few', 'many']);
  });

  it('does not let an explicit =1 selector satisfy the "one" category', () => {
    // ICU matches exact selectors first and only then falls back to keywords,
    // so "=1" covers the value 1 but leaves "one" unhandled for 21, 31, …
    expect(missingPluralCategories('en-GB', 'plural', ['=1', 'other'])).toEqual(['one']);
  });

  it('accepts explicit selectors alongside full keyword coverage', () => {
    expect(missingPluralCategories('en-GB', 'plural', ['=0', 'one', 'other'])).toEqual([]);
  });

  it('always requires "other"', () => {
    expect(missingPluralCategories('ja', 'plural', [])).toEqual(['other']);
    expect(missingPluralCategories('ja', 'plural', ['other'])).toEqual([]);
  });

  it('reports all six categories Arabic needs', () => {
    expect(missingPluralCategories('ar', 'plural', ['one', 'other']).sort())
      .toEqual(['few', 'many', 'two', 'zero']);
  });
});

describe('deadPluralCategories', () => {
  it('flags a branch the target locale can never select', async () => {
    const { deadPluralCategories } = await import('../src/icu/plurals.js');
    expect(deadPluralCategories('de', 'plural', ['one', 'few', 'other'])).toEqual(['few']);
    expect(deadPluralCategories('de', 'plural', ['one', 'other'])).toEqual([]);
    expect(deadPluralCategories('de', 'plural', ['=0', 'one', 'other'])).toEqual([]);
  });
});
