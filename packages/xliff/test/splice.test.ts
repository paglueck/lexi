// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { applyEdits, type Edit } from '../src/splice.js';

const edit = (start: number, end: number, replacement: string): Edit => ({
  span: { start, end },
  replacement,
  reason: `test ${start}-${end}`,
});

describe('applyEdits', () => {
  it('returns the input unchanged when there are no edits', () => {
    const raw = '<a>hello</a>';
    expect(applyEdits(raw, [])).toBe(raw);
  });

  it('is identity for the empty string', () => {
    expect(applyEdits('', [])).toBe('');
  });

  it('replaces a single span', () => {
    expect(applyEdits('<a>hello</a>', [edit(3, 8, 'world')])).toBe('<a>world</a>');
  });

  it('applies several edits regardless of the order they are given in', () => {
    const raw = '<a>one</a><b>two</b>';
    const edits = [edit(13, 16, 'TWO'), edit(3, 6, 'ONE')];
    expect(applyEdits(raw, edits)).toBe('<a>ONE</a><b>TWO</b>');
  });

  it('supports zero-width insertion', () => {
    expect(applyEdits('<a></a>', [edit(3, 3, 'x')])).toBe('<a>x</a>');
  });

  it('supports two insertions at distinct points', () => {
    expect(applyEdits('<a></a><b></b>', [edit(3, 3, 'x'), edit(10, 10, 'y')])).toBe('<a>x</a><b>y</b>');
  });

  it('supports deletion', () => {
    expect(applyEdits('<a>gone</a>', [edit(3, 7, '')])).toBe('<a></a>');
  });

  it('allows two edits that merely touch', () => {
    expect(applyEdits('abcd', [edit(1, 2, 'X'), edit(2, 3, 'Y')])).toBe('aXYd');
  });

  it('rejects overlapping edits', () => {
    expect(() => applyEdits('abcdef', [edit(1, 4, 'X'), edit(3, 5, 'Y')])).toThrow(/overlap/i);
  });

  it('rejects two insertions at the same offset, because their order is ambiguous', () => {
    expect(() => applyEdits('ab', [edit(1, 1, 'X'), edit(1, 1, 'Y')])).toThrow(/overlap|ambiguous/i);
  });

  it('rejects an inverted span', () => {
    expect(() => applyEdits('abcdef', [edit(4, 2, 'X')])).toThrow(/inverted/i);
  });

  it('rejects a span outside the input', () => {
    expect(() => applyEdits('abc', [edit(2, 9, 'X')])).toThrow(/bounds/i);
    expect(() => applyEdits('abc', [edit(-1, 2, 'X')])).toThrow(/bounds/i);
  });

  it('does not mutate the edit array it is given', () => {
    const edits = [edit(3, 4, 'X'), edit(1, 2, 'Y')];
    const snapshot = [...edits];
    applyEdits('abcdef', edits);
    expect(edits).toEqual(snapshot);
  });

  it('names the offending edit in the error, so the failure is debuggable', () => {
    expect(() => applyEdits('abcdef', [edit(1, 4, 'X'), edit(3, 5, 'Y')])).toThrow(/test 3-5/);
  });
});
