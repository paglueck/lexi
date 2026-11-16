// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * How to escape text we write back into a document.
 *
 * `angular` mirrors `@angular/compiler`'s `_ESCAPED_CHARS`, which escapes all five
 * predefined entities — including `'` and `"` — in element content as well as in
 * attribute values. Most serializers escape only `&`, `<` and `>`; matching
 * Angular matters because a target containing an apostrophe would otherwise
 * differ from what the next `ng extract-i18n` writes, and the difference shows up
 * as churn in every subsequent diff (NFR-8).
 *
 * `minimal` is the conservative XML-only rule, for projects whose files are not
 * produced by Angular's serializer.
 */
export const ESCAPE_POLICIES = ['angular', 'minimal'] as const;
export type EscapePolicy = (typeof ESCAPE_POLICIES)[number];

// The ampersand must be replaced first, or the ampersands introduced by the other
// replacements would themselves be escaped.
const ANGULAR_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/"/g, '&quot;'],
  [/'/g, '&apos;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
];

const MINIMAL_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
];

export function escapeText(text: string, policy: EscapePolicy): string {
  const map = policy === 'angular' ? ANGULAR_MAP : MINIMAL_MAP;
  return map.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}
