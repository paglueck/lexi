// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readUnitState, xliffStateFor, shouldWriteState, UNIT_STATES } from '../src/state.js';
import { scan } from '../src/scan.js';
import { oneUnit } from './fixtures.js';

const unitOf = (raw: string) => {
  const doc = scan(raw);
  return { file: doc.files[0]!, unit: doc.files[0]!.units[0]! };
};

describe('readUnitState — the authoritative untranslated signal', () => {
  it('treats a missing <target> as untranslated regardless of anything else', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi' }));
    expect(readUnitState(unit)).toBe('untranslated');
  });

  it('treats an empty target as untranslated', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: '' }));
    expect(readUnitState(unit)).toBe('untranslated');
  });

  it('treats a whitespace-only target as untranslated', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: '   ' }));
    expect(readUnitState(unit)).toBe('untranslated');
  });

  it('treats a self-closed target as untranslated', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', targetSelfClosing: true, state: 'new' }));
    expect(readUnitState(unit)).toBe('untranslated');
  });

  it('ignores a state that claims translated when the target is empty', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: '  ', state: 'final' }));
    expect(readUnitState(unit)).toBe('untranslated');
  });

  it('counts a target that is only a placeholder as translated, not empty', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'x', target: '<x id="INTERPOLATION"/>' }));
    expect(readUnitState(unit)).not.toBe('untranslated');
  });

  it.each([
    ['new', 'untranslated'],
    ['needs-translation', 'untranslated'],
    ['needs-review-translation', 'needsReview'],
    ['needs-review-l10n', 'needsReview'],
    ['needs-l10n', 'needsReview'],
    ['needs-adaptation', 'needsReview'],
    ['needs-review-adaptation', 'needsReview'],
    ['translated', 'reviewed'],
    ['final', 'final'],
    ['signed-off', 'final'],
  ])('maps state="%s" to %s', (attr, expected) => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo', state: attr }));
    expect(readUnitState(unit)).toBe(expected);
  });

  it('falls back to reviewed when a target has content but no state', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' }));
    expect(readUnitState(unit)).toBe('reviewed');
  });

  it('treats an unrecognised state conservatively, as needing review', () => {
    const { unit } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo', state: 'whatever' }));
    expect(readUnitState(unit)).toBe('needsReview');
  });
});

describe('xliffStateFor — writing states back', () => {
  it.each([
    ['untranslated', 'new'],
    ['draftMachine', 'needs-review-translation'],
    ['needsReview', 'needs-review-translation'],
    ['reviewed', 'translated'],
    ['final', 'final'],
  ] as const)('writes %s as state="%s"', (internal, attr) => {
    expect(xliffStateFor(internal)).toBe(attr);
  });

  it('covers every internal state', () => {
    for (const s of UNIT_STATES) expect(typeof xliffStateFor(s)).toBe('string');
  });

  it('round-trips every written state back to an equivalent internal one', () => {
    for (const s of UNIT_STATES) {
      const raw = oneUnit({ id: 'a', source: 'Hi', target: 'Hallo', state: xliffStateFor(s) });
      const back = readUnitState(unitOf(raw).unit);
      // draftMachine is indistinguishable from needsReview in XLIFF 1.2 alone;
      // the machine-origin flag lives in .lexi/state.json.
      const expected = s === 'draftMachine' ? 'needsReview' : s;
      expect(back).toBe(expected === 'untranslated' ? 'untranslated' : expected);
    }
  });
});

describe('shouldWriteState — the auto policy', () => {
  it('writes state when the file already uses it', () => {
    const { file } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo', state: 'translated' }));
    expect(shouldWriteState('auto', file)).toBe(true);
  });

  it('stays out of a file that has no state attributes at all', () => {
    const { file } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' }));
    expect(shouldWriteState('auto', file)).toBe(false);
  });

  it('honours the explicit settings regardless of the file', () => {
    const { file } = unitOf(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' }));
    expect(shouldWriteState('always', file)).toBe(true);
    expect(shouldWriteState('never', file)).toBe(false);
  });
});
