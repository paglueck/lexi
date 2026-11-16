// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/** The ICU argument types whose branches are selected by plural rules. */
export type PluralType = 'plural' | 'selectordinal';

export const CLDR_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type CldrCategory = (typeof CLDR_CATEGORIES)[number];

const cache = new Map<string, ReadonlySet<CldrCategory>>();

/**
 * The CLDR plural categories a locale actually uses.
 *
 * `Intl.PluralRules` is built into Node and carries the CLDR data, so no
 * dependency is needed. Categories come back as a set because the order of
 * `resolvedOptions().pluralCategories` is not specified by the spec.
 */
export function pluralCategoriesFor(locale: string, type: PluralType): ReadonlySet<CldrCategory> {
  const key = locale + '|' + type;
  const hit = cache.get(key);
  if (hit) return hit;

  let categories: ReadonlySet<CldrCategory>;
  try {
    const rules = new Intl.PluralRules(locale, { type: type === 'selectordinal' ? 'ordinal' : 'cardinal' });
    categories = new Set(rules.resolvedOptions().pluralCategories as CldrCategory[]);
  } catch {
    // An unusable tag should degrade to the one category every locale has rather
    // than fail the whole validation pass.
    categories = new Set<CldrCategory>(['other']);
  }
  cache.set(key, categories);
  return categories;
}

/**
 * Fail loudly if this runtime was built with small-ICU.
 *
 * Node ships full ICU by default, but a distro or self-built binary may not, and
 * there every locale collapses to English. Plural-coverage validation would then
 * report "all good" for Polish, silently, and only on some machines. That is
 * precisely the failure the rule exists to prevent, so it earns one startup check.
 */
export function assertFullIcu(): void {
  const polish = pluralCategoriesFor('pl', 'plural');
  if (polish.size !== 4) {
    throw new Error(
      'This Node build lacks full ICU data: Polish reports ' +
        polish.size +
        ' plural categories instead of 4. Plural-coverage validation would ' +
        'silently pass for every locale. Install a full-icu Node build.',
    );
  }
}

const isCategory = (selector: string): selector is CldrCategory =>
  (CLDR_CATEGORIES as readonly string[]).includes(selector);

/**
 * Categories the target locale needs that the given selectors do not cover.
 *
 * Explicit selectors (`=0`, `=1`) never satisfy a category: ICU matches exact
 * values first and only then falls back to keywords, so `=1` handles the value 1
 * while leaving `one` unhandled for 21, 31 and so on. In English that distinction
 * rarely bites; in Polish and Arabic it is the whole point of the rule.
 */
export function missingPluralCategories(
  locale: string,
  type: PluralType,
  selectors: readonly string[],
): CldrCategory[] {
  const present = new Set(selectors.filter(isCategory));
  const required = pluralCategoriesFor(locale, type);
  return CLDR_CATEGORIES.filter((c) => required.has(c) && !present.has(c));
}

/**
 * Keyword branches the target locale can never select, such as a `few` branch in
 * German. Harmless at runtime, but a reliable sign of a copy-paste from another
 * locale, so it is reported as a warning rather than an error.
 */
export function deadPluralCategories(
  locale: string,
  type: PluralType,
  selectors: readonly string[],
): CldrCategory[] {
  const required = pluralCategoriesFor(locale, type);
  return selectors.filter(isCategory).filter((c) => !required.has(c));
}
