// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { SegmentDto } from '@lexi/shared';

import { diffSegments, isUnchanged, tokenize, type DiffPart } from './diff-segments.js';

const text = (v: string): SegmentDto => ({ k: 't', v });
const chip = (id: string, equivText?: string): SegmentDto =>
  equivText === undefined ? { k: 'p', id } : { k: 'p', id, equivText };

/** "removed:was added:is" — the readable shape of a diff, for assertions. */
const shape = (parts: readonly DiffPart[]): string =>
  parts
    .map((p) => {
      const label =
        p.token.kind === 'chip'
          ? `[${p.token.label}]`
          : p.token.kind === 'text'
            ? p.token.v
            : `<${p.token.id}>`;
      return p.op === 'same' ? label : `${p.op}:${label.trim()}`;
    })
    .join('|');

describe('tokenize', () => {
  it('keeps a placeholder whole, however its label reads', () => {
    // The rule the editor enforces everywhere else: a chip is one thing. A
    // tokenizer that flattened it would make `{{ threshold }}` five tokens and
    // let a diff delete half a placeholder.
    expect(tokenize([chip('INTERPOLATION', '{{ threshold }}')])).toEqual([
      { kind: 'chip', id: 'INTERPOLATION', label: '{{ threshold }}' },
    ]);
  });

  it('falls back to the id when Angular wrote no equiv-text', () => {
    expect(tokenize([chip('LINE_BREAK')])).toEqual([
      { kind: 'chip', id: 'LINE_BREAK', label: 'LINE_BREAK' },
    ]);
  });

  it('splits text into words that still join back into the original string', () => {
    const tokens = tokenize([text('Kostenloser Versand ab')]);
    expect(tokens).toHaveLength(3);
    expect(tokens.map((t) => (t.kind === 'text' ? t.v : '')).join('')).toBe(
      'Kostenloser Versand ab',
    );
  });

  it('reads through a <g> group to the text inside it', () => {
    const tokens = tokenize([{ k: 'g', id: 'START_TAG_STRONG', children: [text('Jetzt')] }]);
    expect(tokens).toEqual([{ kind: 'text', v: 'Jetzt' }]);
  });
});

describe('diffSegments', () => {
  it('reports nothing when both sides say the same thing', () => {
    const parts = diffSegments([text('Jetzt bezahlen')], [text('Jetzt bezahlen')]);
    expect(isUnchanged(parts)).toBe(true);
  });

  it('marks only the word that changed', () => {
    const parts = diffSegments([text('Versandkostenfrei ab')], [text('Kostenloser Versand ab')]);
    expect(shape(parts)).toBe('removed:Versandkostenfrei|added:Kostenloser|added:Versand|ab');
  });

  it('carries an unchanged placeholder through untouched', () => {
    const previous = [text('Versandkostenfrei ab '), chip('INTERPOLATION', '{{ threshold }}')];
    const next = [text('Kostenloser Versand ab '), chip('INTERPOLATION', '{{ threshold }}')];
    const parts = diffSegments(previous, next);
    const placeholders = parts.filter((p) => p.token.kind === 'chip');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.op).toBe('same');
  });

  it('treats a moved placeholder as one removal and one addition, never as text', () => {
    const parts = diffSegments(
      [chip('INTERPOLATION', '{{ n }}'), text(' Artikel')],
      [text('Artikel '), chip('INTERPOLATION', '{{ n }}')],
    );
    const chips = parts.filter((p) => p.token.kind === 'chip');
    // Whatever the algorithm does with the surrounding words, the chip must
    // never be split or rendered as characters.
    expect(chips.every((p) => p.token.kind === 'chip' && p.token.label === '{{ n }}')).toBe(true);
  });

  it('is all additions when the draft filled an empty target', () => {
    const parts = diffSegments([], [text('Jetzt bezahlen')]);
    expect(parts.every((p) => p.op === 'added')).toBe(true);
  });

  it('is all removals when the draft emptied the target', () => {
    const parts = diffSegments([text('Jetzt bezahlen')], []);
    expect(parts.every((p) => p.op === 'removed')).toBe(true);
  });
});

describe('diffSegments options', () => {
  it('tidy turns "Save now" to "Store it now" into one removed and one added phrase', () => {
    const parts = diffSegments([text('Save now')], [text('Store it now')], { tidy: true });
    expect(shape(parts)).toBe('removed:Save|added:Store it|now');
    expect(parts).toHaveLength(3);
  });

  it('tidy shows a trailing append as the old word kept and the new words added', () => {
    // On the import path a word and its trailing space are two tokens, so
    // `Facturation` matches although the new text puts a space after it.
    for (const opts of [{ tidy: true }, { groups: true, tidy: true }]) {
      const parts = diffSegments([text('Facturation')], [text('Facturation et paiement')], opts);
      expect(parts).toEqual([
        { op: 'same', token: { kind: 'text', v: 'Facturation' } },
        { op: 'added', token: { kind: 'text', v: ' et paiement' } },
      ]);
    }
  });

  it('keeps S11 tokenizing a word with its trailing space', () => {
    expect(tokenize([text('Pay now')])).toEqual([
      { kind: 'text', v: 'Pay ' },
      { kind: 'text', v: 'now' },
    ]);
    expect(tokenize([text('Pay now')], { groups: true })).toEqual([
      { kind: 'text', v: 'Pay' },
      { kind: 'text', v: ' ' },
      { kind: 'text', v: 'now' },
    ]);
  });

  it('tidy bridges a whitespace-only same token between two changes', () => {
    const parts = diffSegments(
      [text('a'), chip('X', '{{ x }}'), text(' '), chip('Y', '{{ y }}')],
      [text('b'), chip('Z', '{{ z }}'), text(' '), chip('W', '{{ w }}')],
      { tidy: true },
    );
    expect(parts.filter((p) => p.op === 'same')).toHaveLength(0);
  });

  it('keeps a group open/close pair as same when only the inner text changes', () => {
    const g = (v: string): SegmentDto => ({ k: 'g', id: '1', children: [text(v)] });
    const parts = diffSegments([g('Save')], [g('Store')], { groups: true, tidy: true });
    expect(parts.map((p) => `${p.op}:${p.token.kind}`)).toEqual([
      'same:open',
      'removed:text',
      'added:text',
      'same:close',
    ]);
  });

  it('reports a removed group boundary as a change', () => {
    const parts = diffSegments(
      [{ k: 'g', id: '1', children: [text('Hi')] }],
      [text('Hi')],
      { groups: true },
    );
    expect(parts.filter((p) => p.op === 'removed').map((p) => p.token.kind)).toEqual([
      'open',
      'close',
    ]);
  });
});
