// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { parseTokenText, tokenText, type SegmentDto } from '../src/index.js';

const t = (v: string): SegmentDto => ({ k: 't', v });
const p = (id: string, equivText?: string): SegmentDto =>
  equivText === undefined ? { k: 'p', id } : { k: 'p', id, equivText };
const g = (id: string, children: SegmentDto[]): SegmentDto => ({ k: 'g', id, children });

const FIXTURE: SegmentDto[] = [
  t('Hello '),
  p('INTERPOLATION', '{{ name }}'),
  t(', you have '),
  p('LINE_BREAK'),
  g('START_BOLD_TEXT', [t('bold '), p('INTERPOLATION_1', '{{ count }}')]),
  t(' items'),
];

describe('tokenText', () => {
  it('numbers placeholders and groups depth-first in document order', () => {
    expect(tokenText(FIXTURE)).toBe(
      'Hello {1:{{ name }}}, you have {2:LINE_BREAK}{3}bold {4:{{ count }}}{/3} items',
    );
  });
});

describe('parseTokenText', () => {
  it('round-trips tokenText', () => {
    expect(parseTokenText(tokenText(FIXTURE), FIXTURE)).toEqual({ ok: true, segments: FIXTURE });
  });

  it('ignores the label inside a token', () => {
    const ref = [t('Hi '), p('INTERPOLATION', '{{ name }}')];
    const r = parseTokenText('Hi {1:{{ wrong }}}', ref);
    expect(r).toEqual({ ok: true, segments: ref });
  });

  it('keeps a literal brace that is not a token as text', () => {
    expect(parseTokenText('a {b} c', [])).toEqual({ ok: true, segments: [t('a {b} c')] });
  });

  it('returns no segments for an empty string', () => {
    expect(parseTokenText('', [])).toEqual({ ok: true, segments: [] });
  });

  it('rejects an unknown placeholder', () => {
    expect(parseTokenText('x {2:y}', [p('A')])).toEqual({
      ok: false,
      reason: 'Unknown placeholder {2}',
    });
  });

  it('rejects a missing placeholder', () => {
    expect(parseTokenText('x', [p('A')])).toEqual({
      ok: false,
      reason: 'Placeholder {1} is missing',
    });
  });

  it('rejects a placeholder that appears twice', () => {
    expect(parseTokenText('{1:A}{1:A}', [p('A')])).toEqual({
      ok: false,
      reason: 'Placeholder {1} appears twice',
    });
  });

  it('rejects an unclosed group', () => {
    expect(parseTokenText('{1}text', [g('G', [t('text')])])).toEqual({
      ok: false,
      reason: 'Unclosed {1}',
    });
  });

  it('rejects a stray closing token', () => {
    expect(parseTokenText('text{/1}', [g('G', [])])).toEqual({
      ok: false,
      reason: 'Stray {/1}',
    });
  });

  it('rejects a closing token numbered 0 as stray instead of throwing', () => {
    for (const text of ['{/0}', '{/00}']) {
      expect(parseTokenText(text, [])).toEqual({ ok: false, reason: 'Stray {/0}' });
    }
  });

  it('reports the innermost open group when closers are crossed', () => {
    const ref = [g('A', [g('B', [t('x')])])];
    expect(parseTokenText('{1}{2}x{/1}{/2}', ref)).toEqual({
      ok: false,
      reason: 'Unclosed {2}',
    });
  });
});
