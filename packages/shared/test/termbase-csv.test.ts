// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import {
  applyImport,
  detectDelimiter,
  diffImport,
  parseCsv,
  parseTermCsv,
  stringifyCsv,
  termPromptLine,
  termsToCsv,
} from '../src/termbase-csv.js';
import type { Term } from '../src/termbase.js';

const LOCALES = ['de', 'fr', 'ar'];

const term = (over: Partial<Term> & { term: string }): Term => ({
  id: over.term,
  note: '',
  dnt: false,
  translations: {},
  ...over,
});

describe('parseCsv / stringifyCsv (RFC 4180)', () => {
  it('reads quotes, escaped quotes, commas and newlines inside a field, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\nlast,,\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'two\nlines'],
      ['last', '', ''],
    ]);
  });

  it('round-trips anything it writes', () => {
    const rows = [
      ['id', 'term', 'note'],
      ['1', 'promo, code', 'He said "no"'],
      ['2', ' padded ', 'line\r\nbreak'],
      ['3', 'سلة', ''],
    ];
    expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
  });

  it('splits on a semicolon when asked, quoting a field that holds one and leaving commas alone', () => {
    const rows = [
      ['id', 'note'],
      ['a', 'x; y'],
      ['b', 'x, y'],
    ];
    expect(stringifyCsv(rows, ';')).toBe('id;note\r\na;"x; y"\r\nb;x, y\r\n');
  });
});

describe('parseTermCsv', () => {
  it('maps project locales, reports unknown columns and accepts every dnt spelling', () => {
    const csv = [
      'term,note,dnt,de,fr,es',
      'invoice,Billing document,no,Rechnung,Facture,Factura',
      'API,,yes,,,',
      'Pay,,TRUE,,,',
      'cart,,0,Warenkorb,,',
    ].join('\n');
    const parsed = parseTermCsv(csv, LOCALES);
    expect(parsed.errors).toEqual([]);
    expect(parsed.recognised).toEqual(['term', 'note', 'dnt', 'de', 'fr']);
    expect(parsed.ignored).toEqual(['es']);
    expect(parsed.rows.map((r) => [r.term, r.dnt])).toEqual([
      ['invoice', false],
      ['API', true],
      ['Pay', true],
      ['cart', false],
    ]);
    expect(parsed.rows[0]?.translations).toEqual({ de: 'Rechnung', fr: 'Facture' });
  });

  it('drops the locale cells of a DNT row on import, but keeps them for the stored file', () => {
    const csv = 'term,dnt,de\nWorkspace,yes,Arbeitsbereich\n';
    expect(parseTermCsv(csv, LOCALES).rows[0]?.translations).toEqual({});
    expect(parseTermCsv(csv, null, { stored: true }).rows[0]?.translations).toEqual({
      de: 'Arbeitsbereich',
    });
  });

  it('refuses a file without a term column, a bad dnt value and a duplicate term', () => {
    expect(parseTermCsv('name,de\nx,y\n', LOCALES).errors).toEqual([
      'The header row needs a "term" column.',
    ]);
    const parsed = parseTermCsv('term,dnt\na,maybe\nb,no\nB,no\n', LOCALES);
    expect(parsed.errors).toEqual([
      'Line 2: dnt must be yes/no, true/false or 1/0, not "maybe".',
      'Line 4: "B" appears more than once.',
    ]);
  });
});

describe('termsToCsv', () => {
  it('writes project locales in order and keeps a locale that is no longer a project locale', () => {
    const terms = [
      term({
        id: 't1',
        term: 'checkout',
        note: 'noun, always',
        translations: { de: 'Kasse', es: 'Caja' },
      }),
      term({ id: 't2', term: 'Workspace', dnt: true, translations: { fr: 'Espace' } }),
    ];
    const csv = termsToCsv(terms, LOCALES);
    expect(csv.split('\r\n')[0]).toBe('id,term,note,dnt,de,fr,ar,es');
    const back = parseTermCsv(csv, null, { stored: true });
    expect(back.rows).toEqual([
      {
        id: 't1',
        term: 'checkout',
        note: 'noun, always',
        dnt: false,
        translations: { de: 'Kasse', es: 'Caja' },
      },
      { id: 't2', term: 'Workspace', note: '', dnt: true, translations: { fr: 'Espace' } },
    ]);
  });
});

describe('diffImport / applyImport', () => {
  const existing = [
    term({
      id: 'e1',
      term: 'invoice',
      note: 'Billing',
      translations: { de: 'Rechnung', fr: 'Facture' },
    }),
    term({ id: 'e2', term: 'basket', translations: { de: 'Warenkorb' } }),
    term({ id: 'e3', term: 'Workspace', dnt: true, translations: { de: 'Arbeitsbereich' } }),
  ];
  const rows = [
    { term: 'promo code', note: '', dnt: false, translations: { de: 'Aktionscode' } },
    { term: 'Invoice', note: 'Billing', dnt: false, translations: { de: 'Rechnung', fr: 'Note' } },
    { term: 'basket', note: '', dnt: false, translations: { de: 'Warenkorb' } },
    { term: 'workspace', note: 'Product name', dnt: true, translations: {} },
  ];

  it('matches by term case-insensitively and names what changed', () => {
    const preview = diffImport(existing, rows, LOCALES);
    expect(preview.map((p) => p.status)).toEqual(['new', 'update', 'unchanged', 'update']);
    expect(preview[1]?.changedLocales).toEqual(['fr']);
    expect(preview[3]).toMatchObject({ changedLocales: [], metaChanged: true });
  });

  it('puts new terms on top and overwrites updates, keeping stored translations under DNT', () => {
    let n = 0;
    const result = applyImport(existing, rows, LOCALES, 'overwrite', () => `n${++n}`);
    expect([result.added, result.updated, result.unchanged]).toEqual([1, 2, 1]);
    expect(result.terms.map((t) => t.id)).toEqual(['n1', 'e1', 'e2', 'e3']);
    expect(result.terms[1]?.translations).toEqual({ de: 'Rechnung', fr: 'Note' });
    expect(result.terms[3]).toMatchObject({
      note: 'Product name',
      translations: { de: 'Arbeitsbereich' },
    });
  });

  it('only adds in keep-existing mode', () => {
    const result = applyImport(existing, rows, LOCALES, 'keep', () => 'n');
    expect([result.added, result.updated, result.unchanged]).toEqual([1, 0, 3]);
    expect(result.terms.slice(1)).toEqual(existing);
  });
});

describe('termPromptLine', () => {
  it('writes the three cases the editor previews', () => {
    expect(termPromptLine({ term: 'Northwind', translation: '', dnt: true, note: '' }, 'de')).toBe(
      '- "Northwind": do not translate, keep exactly as written',
    );
    expect(
      termPromptLine({ term: 'checkout', translation: 'Kasse', dnt: false, note: '' }, 'de'),
    ).toBe('- "checkout" → "Kasse"');
    expect(
      termPromptLine({ term: 'checkout', translation: '', dnt: false, note: 'a noun' }, 'pl'),
    ).toBe('- "checkout": keep as written (no pl translation) (a noun)');
  });
});

describe('delimiters', () => {
  it('parses semicolon-separated files', () => {
    expect(parseCsv('a;b\r\n"x;y";z\r\n', ';')).toEqual([
      ['a', 'b'],
      ['x;y', 'z'],
    ]);
  });
  it('detectDelimiter picks ; for a European header', () => {
    expect(detectDelimiter('\ufeffUnit ID;Description;Locale;Translation\r\n')).toBe(';');
  });
  it('detectDelimiter picks , for a comma header', () => {
    expect(detectDelimiter('Unit ID,Locale,Translation\n')).toBe(',');
  });
  it('detectDelimiter ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"Unit; ID",Locale,Translation\n')).toBe(',');
  });
});
