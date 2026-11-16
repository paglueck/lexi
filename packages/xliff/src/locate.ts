// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { XlfFile } from './scan.js';

/**
 * Where a file's locale was worked out from, and how the pieces of a project
 * correlate with each other.
 *
 * Pure string and metadata work, no I/O — which is why it lives in the engine
 * rather than in the server: the setup wizard, the gap analysis and the tests
 * all need exactly the same answers.
 *
 * Two rules drive everything here, both from the requirements:
 *
 *  - **The filename beats `target-language`** (FR-1.2). A translation file is
 *    made by copying another one, and the copy keeps the old attribute. Trusting
 *    the attribute is how Portuguese ends up in the Polish file; surfacing the
 *    disagreement (FR-1.2b) is the most useful thing the wizard does.
 *  - **`original` is ignored.** Angular writes `ng2.template` on every file of
 *    every locale, so it identifies nothing.
 */

/** How `detectLocale` arrived at its answer. Rendered verbatim in the wizard. */
export const LOCALE_SOURCES = ['filename', 'directory', 'attribute', 'none'] as const;
export type LocaleSource = (typeof LOCALE_SOURCES)[number];

export interface LocaleDetection {
  /** Canonical BCP-47 form (`pt-BR`, not `pt-br`), or undefined when unknown. */
  readonly locale: string | undefined;
  readonly source: LocaleSource;
  /**
   * The `target-language` as written, when it disagrees with what the path says
   * (FR-1.2b). Undefined when they agree, when there is no attribute, or when
   * the attribute is itself what we detected from.
   */
  readonly conflictingAttr: string | undefined;
}

/**
 * The shape a locale token actually takes, which is far narrower than BCP-47.
 *
 * This regex is the whole point of the function. A BCP-47 primary language
 * subtag is 2-8 alpha characters, so `Intl.getCanonicalLocales('messages')`
 * succeeds — validating with Intl alone classifies the word "messages" as a
 * locale, strips it out of every filename, and collapses every group key to the
 * empty string. Restricting the language subtag to 2-3 characters excludes the
 * English words that appear in these filenames while keeping every tag anyone
 * actually ships.
 */
const LOCALE_SHAPE = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i;

/**
 * Directory names that are structurally valid language tags but never mean a
 * locale in a source repository.
 *
 * `Intl.getCanonicalLocales` checks well-formedness, not the IANA registry, so
 * it happily canonicalises `src` (which really is Logudorese Sardinian), `app`,
 * `lib`, `api`, `ui` and eighteen more. Without this list `src/messages.xlf` is
 * read as a Sardinian translation, and since `src/` is where Angular projects
 * keep everything, that is not an edge case — it is the common case.
 *
 * Only ever applied to DIRECTORY segments. A filename token like
 * `messages.src.xlf` was written by someone who meant it.
 */
const NON_LOCALE_DIRS = new Set([
  'src', 'lib', 'bin', 'app', 'dev', 'doc', 'tmp', 'www', 'api', 'web', 'out',
  'etc', 'var', 'usr', 'opt', 'js', 'ts', 'ui', 'db', 'io', 'qa',
]);

/**
 * True for a path segment that is a locale tag, false for `messages`.
 *
 * Both halves are required: the regex rejects English words too long to be a
 * language subtag, and Intl rejects structurally-plausible nonsense.
 */
export function looksLikeLocaleTag(token: string): boolean {
  if (!LOCALE_SHAPE.test(token)) return false;
  try {
    return Intl.getCanonicalLocales(token).length === 1;
  } catch {
    return false;
  }
}

/** As above, but for a directory segment, where the repo-word collisions bite. */
export function looksLikeLocaleDir(segment: string): boolean {
  return !NON_LOCALE_DIRS.has(segment.toLowerCase()) && looksLikeLocaleTag(segment);
}

/** `pt-br` -> `pt-BR`. Falls back to the input if Intl will not take it. */
function canonical(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? tag;
  } catch {
    return tag;
  }
}

/** Same locale, written differently. `pt-br` and `pt-BR` must not read as a conflict. */
const sameLocale = (a: string, b: string): boolean =>
  canonical(a).toLowerCase() === canonical(b).toLowerCase();

const XLIFF_EXT = /\.(xlf|xliff)$/i;

/** `a\b\c` -> `a/b/c`, and `./a` -> `a`, so equal paths compare equal. */
const normalisePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

export interface StrippedName {
  /** The filename without its extension and without any locale token. */
  readonly stem: string;
  /** The locale token that was removed, canonicalised. */
  readonly locale: string | undefined;
}

/**
 * Split `messages.pt-BR.xlf` into `messages` + `pt-BR`.
 *
 * Only the LAST dot-separated segment before the extension is considered, so
 * `my.app.messages.fr.xlf` keeps its dotted stem intact.
 */
export function stripLocaleToken(fileName: string): StrippedName {
  const withoutExt = fileName.replace(XLIFF_EXT, '');
  const cut = withoutExt.lastIndexOf('.');
  if (cut <= 0) return { stem: withoutExt, locale: undefined };

  const candidate = withoutExt.slice(cut + 1);
  if (!looksLikeLocaleTag(candidate)) return { stem: withoutExt, locale: undefined };
  return { stem: withoutExt.slice(0, cut), locale: canonical(candidate) };
}

/**
 * Work out one `<file>` element's locale.
 *
 * Takes an `XlfFile` rather than a path alone because a document may hold more
 * than one `<file>`, each with its own `target-language` — legal XLIFF, and a
 * correlation hazard if anything keys by path.
 */
export function detectLocale(relPath: string, file: XlfFile): LocaleDetection {
  const segments = normalisePath(relPath).split('/');
  const fileName = segments.pop() ?? '';
  const attr = file.attrs['target-language'];

  const fromName = stripLocaleToken(fileName).locale;
  // The IMMEDIATE parent only, which is what FR-1.2 says ("the parent directory
  // name"). Scanning the whole path for a locale-ish segment reads
  // `src/locale/de/...` correctly but also mangles every path that merely
  // passes through a two- or three-letter directory.
  const parent = segments.at(-1);
  const fromDir = parent !== undefined && looksLikeLocaleDir(parent) ? canonical(parent) : undefined;

  const pathLocale = fromName ?? fromDir;
  if (pathLocale !== undefined) {
    return {
      locale: pathLocale,
      source: fromName === undefined ? 'directory' : 'filename',
      // The FR-1.2b warning row. Only a real disagreement counts — a difference
      // of casing is not one.
      conflictingAttr:
        attr !== undefined && attr !== '' && !sameLocale(attr, pathLocale) ? attr : undefined,
    };
  }

  if (attr !== undefined && attr !== '') {
    return { locale: canonical(attr), source: 'attribute', conflictingAttr: undefined };
  }

  return { locale: undefined, source: 'none', conflictingAttr: undefined };
}

/**
 * The key that correlates the same strings across locales.
 *
 * Locales cannot be correlated by path: `messages.de.xlf` and `de/messages.xlf`
 * are different paths holding the same keys, and until both land in one group
 * nothing downstream can count a gap. So the key is the path with every locale
 * token removed — from the filename and from any directory along the way — which
 * leaves the part that actually identifies the file.
 *
 * Feature modules keep their directory, so `checkout/messages.pl.xlf` groups as
 * `checkout/messages` and stays disambiguated from the root `messages` (FR-1.4).
 *
 * `locale` is this file's DETECTED locale, and it exists for one shape:
 * filenames that are nothing but a locale tag — `en-GB.xlf` beside `de-DE.xlf`,
 * which is what `ng extract-i18n --out-file=en-GB.xlf` produces and what a real
 * project turned out to use. Without it the two land in different groups, so no
 * row ever has a German column and every string reads as missing from a file
 * that plainly contains it.
 *
 * It is passed in rather than guessed because the guess is where the danger
 * lies: `app.xlf`, `src.xlf` and `ui.xlf` all pass the narrow shape check and
 * are obviously module names. A locale that DETECTION
 * returned — for these files, from `target-language` — is authority rather than
 * inference.
 */
export function fileGroupOf(relPath: string, locale?: string): string {
  const segments = normalisePath(relPath).split('/').filter((s) => s !== '');
  const fileName = segments.pop() ?? '';

  // Drop the immediate parent when it is a locale directory, and only then —
  // the same rule detection uses, so a file's group and its locale can never
  // disagree about which segment was the locale.
  const parent = segments.at(-1);
  const dirs = parent !== undefined && looksLikeLocaleDir(parent) ? segments.slice(0, -1) : segments;

  const stripped = stripLocaleToken(fileName);
  const stem =
    stripped.locale === undefined && locale !== undefined && sameLocale(stripped.stem, locale)
      ? ''
      : stripped.stem;

  return [...dirs, stem].filter((s) => s !== '').join('/');
}

/**
 * The extraction template (FR-1.2a): the file Angular regenerates on every
 * build, offered as the default source locale.
 *
 * Two conditions, and the second is the one that matters. `source-language ===
 * target-language` alone would also match a file someone translated into the
 * source language; the absence of any `<target>` is what makes it a template.
 * A self-closed `<target/>` counts as present, because that is what
 * `ng-extract-i18n-merge` writes into a file it has already taken over.
 */
export function isTemplateFile(file: XlfFile): boolean {
  const source = file.attrs['source-language'];
  const target = file.attrs['target-language'];

  const languagesAgree =
    target === undefined || target === '' || (source !== undefined && sameLocale(source, target));

  return languagesAgree && file.units.every((u) => u.target === undefined);
}
