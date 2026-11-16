// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { scan } from '../src/scan.js';
import {
  detectLocale,
  fileGroupOf,
  isTemplateFile,
  looksLikeLocaleDir,
  looksLikeLocaleTag,
  stripLocaleToken,
} from '../src/locate.js';
import { angularXlf, oneUnit } from './fixtures.js';
import { corpusEntries } from './corpus.js';

const fileOf = (raw: string, index = 0) => scan(raw).files[index]!;

/**
 * FR-1.2 / FR-1.2a / FR-1.2b and the FileGroup correlation of FR-2.2.
 *
 * Two things here are load-bearing and easy to get subtly wrong. The first is
 * precedence: the filename must beat `target-language`, because a copied
 * translation file keeps a stale attribute and silently trusting it is how a
 * translator ends up writing Portuguese into the Polish file. The second is
 * what counts as a locale token at all — see the `looksLikeLocaleTag` block.
 */
describe('looksLikeLocaleTag — the narrow shape, not what BCP-47 permits', () => {
  it.each(['de', 'fr', 'pl', 'ar', 'en-GB', 'pt-BR', 'zh-Hant', 'zh-Hant-TW', 'es-419'])(
    'accepts %s',
    (tag) => {
      expect(looksLikeLocaleTag(tag)).toBe(true);
    },
  );

  /**
   * The trap. A BCP-47 primary language subtag is 2-8 alpha characters, so
   * `Intl.getCanonicalLocales('messages')` succeeds and reports it as a valid
   * locale. Validating with Intl alone classifies the word "messages" as a
   * locale, which strips it out of every filename and collapses every group key
   * to the empty string.
   */
  it.each(['messages', 'template', 'checkout', 'locale', 'settings', 'catalog'])(
    'rejects the filename word %s, which Intl would accept as a language subtag',
    (word) => {
      expect(() => Intl.getCanonicalLocales(word)).not.toThrow();
      expect(looksLikeLocaleTag(word)).toBe(false);
    },
  );

  it.each(['', 'x', '123', 'de_DE', 'de-', '-de', 'not a tag'])('rejects %s', (junk) => {
    expect(looksLikeLocaleTag(junk)).toBe(false);
  });

  it('canonicalises case rather than demanding it', () => {
    expect(looksLikeLocaleTag('PT-br')).toBe(true);
  });
});

describe('stripLocaleToken — the filename half of a group key', () => {
  it.each([
    ['messages.de.xlf', 'messages', 'de'],
    ['messages.pt-BR.xlf', 'messages', 'pt-BR'],
    ['messages.xlf', 'messages', undefined],
    ['messages.xliff', 'messages', undefined],
    ['my.app.messages.fr.xlf', 'my.app.messages', 'fr'],
  ])('%s -> stem %s, locale %s', (name, stem, locale) => {
    expect(stripLocaleToken(name)).toEqual({ stem, locale });
  });

  it('does not mistake the stem for a locale when there is no locale token', () => {
    // 'messages' is 8 alpha characters — a legal language subtag by BCP-47.
    expect(stripLocaleToken('messages.xlf').locale).toBeUndefined();
  });
});

describe('detectLocale — filename beats target-language (FR-1.2)', () => {
  const de = oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' }, { targetLanguage: 'de' });

  it('reads the locale out of the filename', () => {
    expect(detectLocale('messages.de.xlf', fileOf(de))).toMatchObject({
      locale: 'de',
      source: 'filename',
    });
  });

  it('falls back to the parent directory when the filename carries no token', () => {
    expect(detectLocale('de/messages.xlf', fileOf(de))).toMatchObject({
      locale: 'de',
      source: 'directory',
    });
  });

  it('falls back to target-language only when the path says nothing', () => {
    expect(detectLocale('locale/messages.xlf', fileOf(de))).toMatchObject({
      locale: 'de',
      source: 'attribute',
    });
  });

  it('does not read src/messages.xlf as Sardinian', () => {
    const bare = oneUnit({ id: 'a', source: 'Hi' }, {});
    expect(detectLocale('src/messages.xlf', fileOf(bare)).source).toBe('none');
  });

  it('reports no locale at all rather than inventing one', () => {
    const noAttr = oneUnit({ id: 'a', source: 'Hi' }, {});
    expect(detectLocale('locale/messages.xlf', fileOf(noAttr))).toMatchObject({
      locale: undefined,
      source: 'none',
    });
  });

  /**
   * FR-1.2b, and the single most valuable row the setup wizard shows: a file
   * copied from messages.pt.xlf and renamed keeps target-language="pt".
   */
  it('flags a stale target-language that disagrees with the filename', () => {
    const stale = oneUnit({ id: 'a', source: 'Hi', target: 'Ola' }, { targetLanguage: 'pt' });
    expect(detectLocale('messages.pt-BR.xlf', fileOf(stale))).toEqual({
      locale: 'pt-BR',
      source: 'filename',
      conflictingAttr: 'pt',
    });
  });

  it('does not flag a conflict when the attribute agrees, case aside', () => {
    const agreeing = oneUnit({ id: 'a', source: 'Hi', target: 'Ola' }, { targetLanguage: 'pt-br' });
    expect(detectLocale('messages.pt-BR.xlf', fileOf(agreeing)).conflictingAttr).toBeUndefined();
  });

  it('never flags a conflict when the attribute is what we detected from', () => {
    expect(detectLocale('locale/messages.xlf', fileOf(de)).conflictingAttr).toBeUndefined();
  });
});

describe('fileGroupOf — correlating locales that share no path (FR-2.2)', () => {
  /**
   * The reason this function exists: messages.de.xlf and de/messages.xlf are
   * different paths holding the same keys. Nothing downstream can count a gap
   * until both land in one group.
   */
  it.each([
    ['messages.de.xlf', 'messages'],
    ['de/messages.xlf', 'messages'],
    ['messages.xlf', 'messages'],
    ['messages.pt-BR.xlf', 'messages'],
    ['pt-BR/messages.xlf', 'messages'],
  ])('%s -> %s', (path, group) => {
    expect(fileGroupOf(path)).toBe(group);
  });

  it('keeps feature modules apart, so split files stay disambiguated (FR-1.4)', () => {
    expect(fileGroupOf('checkout/messages.pl.xlf')).toBe('checkout/messages');
    expect(fileGroupOf('checkout/messages.de.xlf')).toBe('checkout/messages');
    expect(fileGroupOf('messages.de.xlf')).not.toBe(fileGroupOf('checkout/messages.de.xlf'));
  });

  it('strips only the immediate parent, so ordinary directories survive', () => {
    expect(fileGroupOf('src/locale/de/messages.xlf')).toBe('src/locale/messages');
    expect(fileGroupOf('src/app/messages.xlf')).toBe('src/app/messages');
  });

  it('normalises separators and leading ./ so equal paths group equally', () => {
    expect(fileGroupOf('./de/messages.xlf')).toBe(fileGroupOf('de/messages.xlf'));
  });

  /**
   * Intl checks well-formedness, not the IANA registry, so `src` canonicalises
   * cleanly (it really is Logudorese Sardinian). Since src/ is where Angular
   * projects keep everything, treating it as a locale directory would mangle
   * the common case, not an edge case.
   */
  it('does not treat src/ and friends as locale directories', () => {
    expect(fileGroupOf('src/messages.xlf')).toBe('src/messages');
    expect(fileGroupOf('app/messages.xlf')).toBe('app/messages');
  });
});

describe('looksLikeLocaleDir — the repo-word collisions', () => {
  it.each(['src', 'lib', 'bin', 'app', 'dev', 'api', 'web', 'ui', 'js', 'ts', 'db'])(
    'refuses %s as a locale directory even though Intl canonicalises it',
    (word) => {
      expect(Intl.getCanonicalLocales(word)).toHaveLength(1);
      expect(looksLikeLocaleTag(word)).toBe(true);
      expect(looksLikeLocaleDir(word)).toBe(false);
    },
  );

  it.each(['de', 'fr', 'pt-BR', 'zh-Hant'])('still accepts %s', (tag) => {
    expect(looksLikeLocaleDir(tag)).toBe(true);
  });
});

describe('isTemplateFile — FR-1.2a', () => {
  it('identifies the extraction template: languages agree and nothing has a target', () => {
    const template = oneUnit(
      { id: 'a', source: 'Hi' },
      { sourceLanguage: 'en-GB', targetLanguage: 'en-GB' },
    );
    expect(isTemplateFile(fileOf(template))).toBe(true);
  });

  it('identifies plain `ng extract-i18n` output, which has no target-language at all', () => {
    const bare = oneUnit({ id: 'a', source: 'Hi' }, {});
    expect(isTemplateFile(fileOf(bare))).toBe(true);
  });

  it('is not fooled by a same-language file that actually carries targets', () => {
    const withTarget = oneUnit(
      { id: 'a', source: 'Hi', target: 'Hi' },
      { sourceLanguage: 'en-GB', targetLanguage: 'en-GB' },
    );
    expect(isTemplateFile(fileOf(withTarget))).toBe(false);
  });

  it('counts a self-closed <target/> as a target, so a merged file is not a template', () => {
    const merged = oneUnit(
      { id: 'a', source: 'Hi', targetSelfClosing: true, state: 'new' },
      { sourceLanguage: 'en-GB', targetLanguage: 'en-GB' },
    );
    expect(isTemplateFile(fileOf(merged))).toBe(false);
  });

  it('rejects a translation file outright', () => {
    const translated = oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' }, { targetLanguage: 'de' });
    expect(isTemplateFile(fileOf(translated))).toBe(false);
  });
});

describe('multi-<file> documents are detected per <file>, not per path', () => {
  /**
   * Two <file> elements in one document is legal and, per the corpus, "a
   * correlation hazard": the attribute differs per file while the path does
   * not. Anything keyed by path alone silently merges two locales.
   */
  const twoLocales = angularXlf({
    files: [
      { targetLanguage: 'de', units: [{ id: 'shared', source: 'Hi', target: 'Hallo' }] },
      { targetLanguage: 'fr', units: [{ id: 'shared', source: 'Hi', target: 'Salut' }] },
    ],
  });

  it('reads each file element on its own terms', () => {
    const doc = scan(twoLocales);
    expect(detectLocale('messages.xlf', doc.files[0]!).locale).toBe('de');
    expect(detectLocale('messages.xlf', doc.files[1]!).locale).toBe('fr');
  });

  it('lets the filename override both, which is the documented precedence', () => {
    const doc = scan(twoLocales);
    expect(detectLocale('messages.es.xlf', doc.files[1]!)).toMatchObject({
      locale: 'es',
      source: 'filename',
      conflictingAttr: 'fr',
    });
  });
});

describe('the corpus correlates as a project', () => {
  /**
   * The end-to-end claim M4 rests on: run every corpus file through detection
   * and grouping and the three `messages` files for de must land in one group,
   * with the pt-BR conflict surfaced rather than silently resolved.
   */
  const detected = corpusEntries()
    .filter(([path]) => !path.startsWith('edge/'))
    .map(([path, raw]) => {
      const file = scan(raw).files[0]!;
      return { path, group: fileGroupOf(path), ...detectLocale(path, file) };
    });

  it('puts both German naming schemes in one group', () => {
    const groups = new Map(detected.map((d) => [d.path, d.group]));
    expect(groups.get('de/messages.de.xlf')).toBe('messages');
    expect(groups.get('de/messages.xlf')).toBe('messages');
    expect(groups.get('pl/messages.pl.xlf')).toBe('messages');
  });

  it('keeps a non-locale directory in the key, so template/ is its own group', () => {
    // The corpus prefixes are naming conventions in a Record, not a real
    // layout; `template` is not a locale, so it is not stripped. In a real
    // project the template sits beside the translations as `messages.xlf`.
    expect(fileGroupOf('template/messages.xlf')).toBe('template/messages');
  });

  it('detects every locale in the corpus without inventing one', () => {
    const byPath = new Map(detected.map((d) => [d.path, d.locale]));
    expect(byPath.get('de/messages.de.xlf')).toBe('de');
    expect(byPath.get('de/messages.xlf')).toBe('de');
    expect(byPath.get('pl/messages.pl.xlf')).toBe('pl');
    expect(byPath.get('ar/messages.ar.xlf')).toBe('ar');
    expect(byPath.get('pt-BR/messages.pt-BR.xlf')).toBe('pt-BR');
  });

  it('finds exactly one stale target-language, and it is the pt-BR file', () => {
    const conflicts = detected.filter((d) => d.conflictingAttr !== undefined);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      path: 'pt-BR/messages.pt-BR.xlf',
      locale: 'pt-BR',
      conflictingAttr: 'pt',
    });
  });

  it('finds exactly the two extraction templates', () => {
    const templates = corpusEntries()
      .filter(([, raw]) => isTemplateFile(scan(raw).files[0]!))
      .map(([path]) => path);
    expect(templates).toEqual([
      'template/messages.xlf',
      'template/messages.no-target-language.xlf',
    ]);
  });
});

/**
 * The convention where the filename IS the locale: `en-GB.xlf`, `de-DE.xlf`,
 * side by side in one directory.
 *
 * `ng extract-i18n --out-file=en-GB.xlf` produces exactly this, and it is what
 * a real project turned out to use. Grouped by the stem alone, `en-GB.xlf` and
 * `de-DE.xlf` land in two DIFFERENT groups — so no row ever has a German
 * column, every unit reads as missing from a file that plainly contains it, and
 * nothing can be translated. That was a whole product broken by a filename.
 *
 * The locale is passed in rather than guessed, because the guess is where the
 * danger is: `app.xlf`, `src.xlf` and `ui.xlf` all pass the shape check and are
 * obviously module names. A detected locale — which for these files comes from
 * `target-language` — is authority rather than inference.
 */
describe('fileGroupOf — when the whole filename is the locale', () => {
  it.each([
    ['en-GB.xlf', 'en-GB', ''],
    ['de-DE.xlf', 'de-DE', ''],
    ['i18n/de.xlf', 'de', 'i18n'],
    ['src/locale/pt-BR.xliff', 'pt-BR', 'src/locale'],
  ])('%s with locale %s groups as "%s"', (path, locale, group) => {
    expect(fileGroupOf(path, locale)).toBe(group);
  });

  it('puts the source and the translation of such a pair in ONE group', () => {
    expect(fileGroupOf('en-GB.xlf', 'en-GB')).toBe(fileGroupOf('de-DE.xlf', 'de-DE'));
  });

  it('never strips a stem that merely looks like a locale but is not the file\'s', () => {
    // `app.xlf` in a project whose file says German: the name is not the locale,
    // so the stem stays and the file keeps its own group.
    expect(fileGroupOf('app.xlf', 'de')).toBe('app');
    expect(fileGroupOf('src.xlf', 'de')).toBe('src');
    // And with no locale known at all, nothing is stripped.
    expect(fileGroupOf('de-DE.xlf')).toBe('de-DE');
  });

  it('still strips a trailing token when there is a stem, locale or not', () => {
    expect(fileGroupOf('messages.de.xlf', 'de')).toBe('messages');
    expect(fileGroupOf('checkout/messages.pl.xlf', 'pl')).toBe('checkout/messages');
  });

  it('matches case-insensitively, as locale tags are compared everywhere else', () => {
    expect(fileGroupOf('DE-de.xlf', 'de-DE')).toBe('');
  });
});
