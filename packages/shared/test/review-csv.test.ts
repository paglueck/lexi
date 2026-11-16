// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { parseReviewCsv, ReportQuerySchema } from '../src/index.js';

const LOCALES = ['de', 'fr'];

describe('parseReviewCsv', () => {
  it('reads a semicolon file with a BOM, one row per locale column', () => {
    const text =
      '\ufeffUnit ID;Description;Export;Source;de;fr\r\n' +
      'greeting;Shown on login;exp-1;Hello;Hallo;Bonjour\r\n' +
      'bye;;exp-1;Bye;;Salut\r\n';
    expect(parseReviewCsv('r.csv', text, LOCALES)).toEqual({
      name: 'r.csv',
      delimiter: ';',
      columns: [
        { name: 'Unit ID', recognised: true },
        { name: 'Description', recognised: true },
        { name: 'Export', recognised: true },
        { name: 'Source', recognised: true },
        { name: 'de', recognised: true },
        { name: 'fr', recognised: true },
      ],
      rows: [
        { line: 2, unitId: 'greeting', locale: 'de', translation: 'Hallo', exportId: 'exp-1' },
        { line: 2, unitId: 'greeting', locale: 'fr', translation: 'Bonjour', exportId: 'exp-1' },
        { line: 3, unitId: 'bye', locale: 'de', translation: '', exportId: 'exp-1' },
        { line: 3, unitId: 'bye', locale: 'fr', translation: 'Salut', exportId: 'exp-1' },
      ],
    });
  });

  it('reads a comma file with one locale and without an Export column', () => {
    const r = parseReviewCsv('r.csv', 'Unit ID,de\nhello,Hallo\n', LOCALES);
    expect(r).toMatchObject({
      delimiter: ',',
      rows: [{ line: 2, unitId: 'hello', locale: 'de', translation: 'Hallo', exportId: null }],
    });
  });

  it('ignores a column that is not a project locale', () => {
    const r = parseReviewCsv('r.csv', 'Unit ID,de,nl,Reviewer note\nhello,Hallo,Hoi,ok\n', LOCALES);
    expect(r).toMatchObject({
      columns: [
        { name: 'Unit ID', recognised: true },
        { name: 'de', recognised: true },
        { name: 'nl', recognised: false },
        { name: 'Reviewer note', recognised: false },
      ],
      rows: [{ locale: 'de', translation: 'Hallo' }],
    });
    expect((r as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('needs a Unit ID and a locale column, and rejects the old Locale/Translation layout', () => {
    const error = 'The file needs a Unit ID column and a column per locale (e.g. de-DE).';
    expect(parseReviewCsv('r.csv', 'de\nHallo\n', LOCALES)).toEqual({ error });
    expect(parseReviewCsv('r.csv', 'Unit ID,Source\nhello,Hello\n', LOCALES)).toEqual({ error });
    expect(
      parseReviewCsv('r.csv', 'Unit ID,Locale,Translation\nhello,de,Hallo\n', LOCALES),
    ).toEqual({ error });
  });

  it('keeps a newline inside a quoted translation', () => {
    const r = parseReviewCsv('r.csv', 'Unit ID,de\nhello,"Zeile 1\nZeile 2"\n', LOCALES);
    expect(r).toMatchObject({ rows: [{ translation: 'Zeile 1\nZeile 2' }] });
  });

  it('matches fixed header names case-insensitively and trimmed', () => {
    const r = parseReviewCsv('r.csv', ' unit id , de ,EXPORT\nhello,Hallo,exp-1\n', LOCALES);
    expect(r).toMatchObject({
      rows: [{ unitId: 'hello', locale: 'de', translation: 'Hallo', exportId: 'exp-1' }],
    });
  });

  it('skips lines without a unit and tolerates trailing empty columns', () => {
    const r = parseReviewCsv('r.csv', 'Unit ID;de;;\r\nhello;Hallo;;\r\n;;;\r\n', LOCALES);
    expect(r).toMatchObject({
      columns: [
        { name: 'Unit ID', recognised: true },
        { name: 'de', recognised: true },
      ],
      rows: [{ line: 2, unitId: 'hello' }],
    });
    expect((r as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

describe('ReportQuerySchema', () => {
  it('defaults split to single', () => {
    expect(ReportQuerySchema.parse({}).split).toBe('single');
    expect(ReportQuerySchema.parse({ split: 'perLocale' }).split).toBe('perLocale');
  });
});
