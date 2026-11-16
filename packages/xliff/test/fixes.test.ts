// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { suggestFix } from '../src/fixes.js';
import { segmentsOfFragment, placeholderIds, plainText, type Segment } from '../src/segments.js';
import { validateSegments, DEFAULT_SEVERITIES, type RuleId } from '../src/validate.js';
import { ph } from './fixtures.js';

const ctx = { sourceLocale: 'en-GB', targetLocale: 'de', severities: DEFAULT_SEVERITIES };

const link = {
  open: '<x id="START_LINK" ctype="x-a" equiv-text="&lt;a&gt;"/>',
  close: '<x id="CLOSE_LINK" ctype="x-a" equiv-text="&lt;/a&gt;"/>',
};

const fixFor = (source: string, target: string, rule: RuleId) => {
  const s = segmentsOfFragment(source);
  const t = segmentsOfFragment(target);
  const finding = validateSegments(s, t, ctx).find((f) => f.rule === rule);
  expect(finding, `expected ${rule} to fire`).toBeDefined();
  return { fix: suggestFix(s, t, finding!, ctx), source: s };
};

const ids = (segments: readonly Segment[] | undefined) => placeholderIds(segments ?? []);

describe('validate: placeholder findings carry their ids', () => {
  it('names the missing and the unexpected ids', () => {
    const s = segmentsOfFragment(`Hi ${ph.interpolation(0)} ${ph.lineBreak()}`);
    const t = segmentsOfFragment(`Hallo ${ph.interpolation(1)}`);
    const finding = validateSegments(s, t, ctx).find((f) => f.rule === 'placeholder.mismatch');
    expect(finding?.placeholders).toEqual({ missing: ['INTERPOLATION', 'LINE_BREAK'], unexpected: ['INTERPOLATION_1'] });
  });

  it('leaves them off every other rule', () => {
    const s = segmentsOfFragment('Save.');
    const t = segmentsOfFragment('Speichern');
    const findings = validateSegments(s, t, ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.placeholders === undefined)).toBe(true);
  });
});

describe('suggestFix: insert at an edge', () => {
  it('closes a link the source closes at the end', () => {
    const { fix } = fixFor(
      `I accept the ${link.open}terms and conditions${link.close}`,
      `Ich akzeptiere die ${link.open}AGB`,
      'placeholder.mismatch',
    );
    expect(fix?.kind).toBe('insert-edge');
    expect(ids(fix?.segments)).toEqual(['START_LINK', 'CLOSE_LINK']);
    expect(fix?.explanation).toContain('AGB');
    expect(fix?.origin).toBe('from source tag pairing');
    expect(fix?.changed).toEqual([fix!.segments.length - 1]);
  });

  it('goes before the terminal punctuation the source also has after it', () => {
    const { fix } = fixFor(`Hello ${ph.interpolation(0)}.`, 'Hallo.', 'placeholder.mismatch');
    expect(plainText(fix!.segments)).toBe('Hallo{{ value }}.');
  });

  it('goes to the start when the source opens with it', () => {
    const { fix } = fixFor(`${ph.interpolation(0)} results`, 'Ergebnisse', 'placeholder.mismatch');
    expect(ids(fix?.segments)).toEqual(['INTERPOLATION']);
    expect(fix?.segments[0]?.k).toBe('p');
  });

  it('offers nothing for a placeholder from the middle of the sentence', () => {
    const { fix } = fixFor(`Pay ${ph.interpolation(0)} now`, 'Jetzt bezahlen', 'placeholder.mismatch');
    expect(fix).toBeNull();
  });
});

describe('suggestFix: rename', () => {
  it('renames the one unexpected id to the one missing id, with the source bytes', () => {
    const { fix, source } = fixFor(`You have ${ph.icu('{count, plural, other {…}}')}`, `Masz <x id="ICU_1" equiv-text="x"/>`, 'placeholder.mismatch');
    expect(fix?.kind).toBe('rename');
    expect(ids(fix?.segments)).toEqual(['ICU']);
    const replaced = fix!.segments[fix!.changed[0]!];
    expect(replaced).toBe(source.find((s) => s.k === 'p'));
  });

  it('offers nothing when two placeholders are missing', () => {
    const { fix } = fixFor(`${ph.interpolation(0)} and ${ph.interpolation(1)}`, `${ph.interpolation(2)} und`, 'placeholder.mismatch');
    expect(fix).toBeNull();
  });

  it('offers nothing for a duplicated placeholder', () => {
    const { fix } = fixFor(`Use ${ph.interpolation(0)}`, `${ph.interpolation(0)} nutzen ${ph.interpolation(0)}`, 'placeholder.mismatch');
    expect(fix).toBeNull();
  });
});

describe('suggestFix: whitespace', () => {
  it('copies the source edges onto a plain text target', () => {
    const { fix } = fixFor(' Total: ', 'Summe:', 'whitespace.edges');
    expect(plainText(fix!.segments)).toBe(' Summe: ');
  });

  it('adds a text segment beside a placeholder at the edge', () => {
    const { fix } = fixFor(`${ph.interpolation(0)} items `, `${ph.interpolation(0)} Artikel`, 'whitespace.edges');
    expect(plainText(fix!.segments)).toBe('{{ value }} Artikel ');
  });

  it('never offers a fix for a rule it does not know', () => {
    const s = segmentsOfFragment('Save.');
    const t = segmentsOfFragment('Speichern');
    const finding = validateSegments(s, t, ctx).find((f) => f.rule === 'punctuation.terminal')!;
    expect(suggestFix(s, t, finding, ctx)).toBeNull();
  });
});
