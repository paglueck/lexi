// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The target language of an XLIFF document set to `language`, as text — for
 * the copy a Phrase push uploads, never for the file on disk.
 *
 * Phrase reads the locale of an XLIFF upload from the file and looks it up by
 * NAME, creating a locale when none matches. A file that says `de` for the
 * locale Phrase calls "Developer-German" (code `de`) would make a new locale
 * `de`. lexi asks Phrase to use `locale_id` instead (`override_file_language`);
 * writing the locale's name into the upload as well means the two can never
 * point at different locales.
 *
 * XLIFF 1.2: `target-language` on every `<file>`, added where missing.
 * XLIFF 2.x: `trgLang` on `<xliff>`. Nothing else in the text is touched.
 */
export function withXliffTargetLanguage(text: string, language: string): string {
  const value = escapeAttr(language);
  if (/<xliff\b[^>]*\bversion\s*=\s*["']2\./.test(text)) {
    return text.replace(/<xliff\b[^>]*>/, (tag) => setAttr(tag, 'trgLang', value));
  }
  return text.replace(/<file\b[^>]*>/g, (tag) => setAttr(tag, 'target-language', value));
}

/** `attr="value"` in one start tag, replacing the attribute or adding it. */
function setAttr(tag: string, attr: string, value: string): string {
  const existing = new RegExp(`(\\s${attr}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  // Replacer functions, so a `$` in the value is never read as a pattern.
  if (existing.test(tag))
    return tag.replace(existing, (_, before: string) => `${before}"${value}"`);
  // `<file …/>` or `<file …>`: the attribute goes before the closing.
  return tag.replace(/\s*(\/?)>$/, (_, slash: string) => ` ${attr}="${value}"${slash}>`);
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Which of XLIFF's two languages a file is pushed for. `source`: the
 * extraction template — no target language, or the same as the source
 * (FR-1.2a), so its `<source>` texts are what it carries. `target`: a
 * translation file, whose `<target>` texts are.
 */
export type XliffSide = 'source' | 'target';

export function xliffSide(text: string): XliffSide {
  const v2 = /<xliff\b[^>]*\bversion\s*=\s*["']2\./.test(text);
  const tag = (v2 ? /<xliff\b[^>]*>/ : /<file\b[^>]*>/).exec(text)?.[0] ?? '';
  const source = attr(tag, v2 ? 'srcLang' : 'source-language');
  const target = attr(tag, v2 ? 'trgLang' : 'target-language');
  return target === null || target === '' || target === source ? 'source' : 'target';
}

/**
 * The XLIFF upload options a push sends so that Phrase uses `locale_id` — and
 * nothing else — for the file. Phrase refuses a fixed language ("the file
 * contains more than one source or target languages") unless one of the two
 * sides is ignored, so the side not pushed is excluded: a translation upload
 * no longer rewrites the source texts on the way, either.
 */
export function xliffUploadOptions(
  side: XliffSide,
): Record<
  'override_file_language' | 'ignore_source_translations' | 'ignore_target_translations',
  boolean
> {
  return {
    override_file_language: true,
    ignore_source_translations: side === 'target',
    ignore_target_translations: side === 'source',
  };
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m === null ? null : (m[1] ?? m[2] ?? '').trim();
}
