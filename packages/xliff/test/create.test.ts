// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { createXliffDocument } from '../src/create.js';
import { detectLocale, isTemplateFile } from '../src/locate.js';
import { scan } from '../src/scan.js';
import { angularXlf } from './fixtures.js';

/**
 * A Phrase checkout writes its files from nothing. They have to look like what
 * `ng extract-i18n` writes — byte for byte where the text allows — and read
 * back through the same scanner and locale detection every other file goes
 * through.
 */
describe('createXliffDocument', () => {
  it('writes the Angular 1.2 shape the fixtures describe', () => {
    const text = createXliffDocument({
      sourceLanguage: 'en',
      units: [
        { id: 'checkout.pay', source: 'Pay now', notes: ['The main button'] },
        { id: 'checkout.total', source: 'Total' },
      ],
    });
    expect(text).toBe(
      angularXlf({
        files: [
          {
            sourceLanguage: 'en',
            units: [
              { id: 'checkout.pay', source: 'Pay now', description: 'The main button' },
              { id: 'checkout.total', source: 'Total' },
            ],
          },
        ],
      }),
    );
  });

  it('writes empty new targets for a target file', () => {
    const text = createXliffDocument({
      sourceLanguage: 'en',
      targetLanguage: 'de',
      units: [{ id: 'a', source: 'A', emptyTarget: true }],
    });
    expect(text).toBe(
      angularXlf({
        files: [
          {
            sourceLanguage: 'en',
            targetLanguage: 'de',
            units: [{ id: 'a', source: 'A', target: '', state: 'new' }],
          },
        ],
      }),
    );
  });

  it('round-trips text, ids and notes through scan()', () => {
    const units = [
      { id: 'a&b "q"', source: 'Fish & <chips> for {amount}', notes: ['Plural key in Phrase'] },
      { id: 'plain', source: "It's" },
      { id: 'empty', source: '' },
    ];
    const doc = scan(createXliffDocument({ sourceLanguage: 'en-GB', units }));
    const file = doc.files[0]!;
    expect(file.attrs['source-language']).toBe('en-GB');
    expect(file.units.map((u) => [u.id, u.sourcePlain, u.notes.map((n) => n.text)])).toEqual(
      units.map((u) => [u.id, u.source, u.notes ?? []]),
    );
    // Placeholders stay literal; only the XML specials are escaped.
    expect(createXliffDocument({ sourceLanguage: 'en', units })).toContain(
      `<source>Fish &amp; &lt;chips&gt; for {amount}</source>`,
    );
  });

  it('makes the base a template and the targets locale files by name', () => {
    const base = scan(
      createXliffDocument({ sourceLanguage: 'en', units: [{ id: 'a', source: 'A' }] }),
    ).files[0]!;
    expect(isTemplateFile(base)).toBe(true);
    expect(detectLocale('messages.xlf', base).locale).toBeUndefined();

    const target = scan(
      createXliffDocument({
        sourceLanguage: 'en',
        targetLanguage: 'pt-BR',
        units: [{ id: 'a', source: 'A', emptyTarget: true }],
      }),
    ).files[0]!;
    expect(isTemplateFile(target)).toBe(false);
    expect(detectLocale('messages.pt-BR.xlf', target)).toMatchObject({
      locale: 'pt-BR',
      source: 'filename',
      conflictingAttr: undefined,
    });
  });
});
