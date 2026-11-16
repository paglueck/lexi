// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Term Base matching (formerly the glossary), shared by the prompt (which terms to inject, FR-5.9) and
 * validation (which terms a target ignored, FR-8.1) — one matcher, so the model
 * is never told about a term the checks would not hold it to, or the reverse.
 *
 * Lives in the engine because `validate.ts` does, and the engine stays pure:
 * the server hands it plain terms rather than the wire schema.
 */

/**
 * What a check needs to know about one term, for one locale.
 *
 * An empty `translation` on a term that is not DNT is not "nothing to check":
 * the Term Base's fallback rule says that locale keeps the source term as
 * written, the same as DNT does everywhere.
 */
export interface GlossaryCheck {
  readonly term: string;
  /** Resolved for the target locale (`usableTranslation`); empty when there is none. */
  readonly translation: string;
  readonly dnt: boolean;
}

/**
 * The translation for this locale, falling back to the language.
 *
 * Same rule as the style guides' `pt-BR.md` before `pt.md`: an entry written
 * for the exact locale is the one its author meant, and falling back lets a
 * team keep one Portuguese row for both regions.
 */
export function usableTranslation(translations: Readonly<Record<string, string>>, locale: string): string {
  const exact = translations[locale];
  if (exact !== undefined && exact.trim() !== '') return exact;
  const language = locale.split('-')[0] ?? locale;
  const fallback = translations[language];
  return fallback !== undefined && fallback.trim() !== '' ? fallback : '';
}

/**
 * Does a SOURCE text contain the term? Always case-sensitive — `Workspace` the
 * product is not `workspace` the noun, and a term written lower-case is the
 * one its author meant. Word-shaped terms match on boundaries (`cart` is not in
 * `carton`); a term with spaces, punctuation or CJK edges falls back to a
 * substring, because a word boundary means nothing there.
 */
export function appearsIn(text: string, term: { readonly term: string }): boolean {
  const needle = term.term.trim();
  const haystack = text;
  if (needle === '') return false;

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!bounded(needle) || isWholeWord(haystack, at, needle.length)) return true;
    from = at + 1;
  }
}

/**
 * Does a TARGET text contain the required wording? A plain, case-insensitive
 * substring, deliberately unlike `appearsIn`: German compounds "Konto" into
 * "Kontoübersicht", Finnish and Turkish agglutinate, and a boundary check
 * would report every one of them as the glossary being ignored. A sentence-
 * initial capital is the same term, too.
 */
export function containsLoosely(text: string, wording: string): boolean {
  const needle = wording.trim().toLowerCase();
  return needle !== '' && text.toLowerCase().includes(needle);
}

/** A term whose own edges are word characters is one a boundary applies to. */
const bounded = (needle: string): boolean =>
  WORD.test(needle[0] ?? '') && WORD.test(needle[needle.length - 1] ?? '');

const WORD = /[\p{L}\p{N}_]/u;

function isWholeWord(haystack: string, at: number, length: number): boolean {
  const before = at === 0 ? '' : (haystack[at - 1] ?? '');
  const after = haystack[at + length] ?? '';
  return !WORD.test(before) && !WORD.test(after);
}
