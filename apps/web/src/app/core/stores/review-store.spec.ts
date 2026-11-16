// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { UnitDetail, UnitTarget } from '@lexi/shared';

import { mergeQueue, redraftInstruction, resolveTarget } from './review-store.js';
import type { Draft } from './draft-store.js';

/**
 * The three pure rules the Review screen (S11, M14) turns on, extracted so they
 * are testable without Angular DI — the same pattern `nextSelectedIndex` uses
 * in `units-store.spec.ts`.
 */

const target = (over: Partial<UnitTarget> = {}): UnitTarget => ({
  locale: 'de',
  isRtl: false,
  state: 'draftMachine',
  missing: false,
  noFile: false,
  newFile: null,
  segments: [{ k: 't', v: 'Jetzt bezahlen' }],
  findings: [],
  missingPlaceholders: [],
  charCount: 15,
  previous: null,
  origin: null,
  reviewReasons: [],
  ...over,
});

const detail = (targets: readonly UnitTarget[]): UnitDetail => ({
  rowId: 'messagespay',
  unitId: 'pay',
  group: 'messages',
  customId: false,
  isIcu: false,
  sourceLocale: 'en-GB',
  source: [{ k: 't', v: 'Pay now' }],
  notes: [],
  locations: [],
  targets: [...targets],
  files: { de: 'messages.de.xlf' },
  notesFile: 'messages.xlf',
  notesFileIsTemplate: true,
  notesPending: false,
});

const noDraft = (): undefined => undefined;

describe('resolveTarget', () => {
  it('is undefined with no detail loaded yet', () => {
    expect(resolveTarget(undefined, 'de', noDraft)).toBeUndefined();
  });

  it('is undefined with no locale selected', () => {
    expect(resolveTarget(detail([target()]), null, noDraft)).toBeUndefined();
  });

  it('is undefined when the unit has no column for this locale', () => {
    expect(resolveTarget(detail([target({ locale: 'fr' })]), 'de', noDraft)).toBeUndefined();
  });

  it('reads the server copy when nothing is pending', () => {
    const server = target();
    expect(resolveTarget(detail([server]), 'de', noDraft)).toBe(server);
  });

  it('prefers a pending draft over the server copy', () => {
    const server = target({ segments: [{ k: 't', v: 'Jetzt bezahlen' }] });
    const edited = target({ segments: [{ k: 't', v: 'Sofort bezahlen' }] });
    const draft: Draft = { rowId: 'messagespay', locale: 'de', target: edited };
    const result = resolveTarget(detail([server]), 'de', (rowId, locale) =>
      rowId === draft.rowId && locale === draft.locale ? draft : undefined,
    );
    expect(result).toBe(edited);
  });
});

describe('mergeQueue', () => {
  it('drops a row the reload no longer returns', () => {
    expect(mergeQueue(['a', 'b', 'c'], ['a', 'c'], new Set())).toEqual(['a', 'c']);
  });

  it('keeps a DECIDED row exactly where it was', () => {
    // The queue has to shrink — handling an item removes it from the open count
    // and Next must never land back on it — but S11 keeps the row drawn at half
    // opacity so a decision can be revisited. Dropping it would make the list
    // jump under the cursor every time somebody accepted something.
    expect(mergeQueue(['a', 'b', 'c'], ['a', 'c'], new Set(['b']))).toEqual(['a', 'b', 'c']);
  });

  it('appends genuinely new rows rather than interleaving them', () => {
    expect(mergeQueue(['a', 'b'], ['a', 'b', 'z'], new Set())).toEqual(['a', 'b', 'z']);
  });

  it('never repeats a row that is both kept and returned', () => {
    expect(mergeQueue(['a'], ['a'], new Set(['a']))).toEqual(['a']);
  });

  it('starts from the reload when nothing is on screen yet', () => {
    expect(mergeQueue([], ['a', 'b'], new Set())).toEqual(['a', 'b']);
  });
});

describe('redraftInstruction', () => {
  it('names every chosen reason, so the model is told what to fix', () => {
    expect(redraftInstruction(['Ignores glossary', 'Too long'])).toContain(
      'Ignores glossary; Too long',
    );
  });

  it('still says the draft was rejected when no reason was given', () => {
    expect(redraftInstruction([])).toContain('rejected');
  });
});
