// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import {
  EMPTY_SELECTION,
  cellsOf,
  colsAt,
  countOf,
  extendTo,
  isMultiple,
  isSelected,
  selectCell,
  selectRow,
  toggleCell,
  toggleRow,
} from './grid-selection-store.js';

/**
 * The spreadsheet rules of the grid's multi-selection, as pure functions over
 * (row, column) indexes — the part that is easy to get subtly wrong and hard to
 * see in a screenshot.
 */
const at = (row: number, col: number) => ({ row, col });
const list = (sel: Parameters<typeof cellsOf>[0]) => cellsOf(sel).map((c) => `${c.row}:${c.col}`);

describe('grid selection', () => {
  it('a plain click is one cell, not a multi-selection', () => {
    const sel = selectCell(at(2, 1));
    expect(list(sel)).toEqual(['2:1']);
    expect(isMultiple(sel)).toBe(false);
    expect(isMultiple(EMPTY_SELECTION)).toBe(false);
  });

  it('Shift+click spans the rectangle from the anchor, in either direction', () => {
    const sel = extendTo(selectCell(at(3, 2)), at(1, 0), 4);
    expect(list(sel)).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1', '2:2', '3:0', '3:1', '3:2']);
    expect(isMultiple(sel)).toBe(true);
  });

  it('a second Shift+click replaces the range rather than adding to it', () => {
    const first = extendTo(selectCell(at(0, 0)), at(3, 0), 4);
    const second = extendTo(first, at(1, 1), 4);
    expect(list(second)).toEqual(['0:0', '0:1', '1:0', '1:1']);
  });

  it('Cmd+click adds a cell and keeps the earlier range', () => {
    const range = extendTo(selectCell(at(0, 0)), at(1, 0), 4);
    const sel = toggleCell(range, at(5, 3));
    expect(list(sel)).toEqual(['0:0', '1:0', '5:3']);
  });

  it('Cmd+click on a marked cell takes it out, and again puts it back', () => {
    const range = extendTo(selectCell(at(0, 0)), at(1, 1), 4);
    const out = toggleCell(range, at(0, 1));
    expect(list(out)).toEqual(['0:0', '1:0', '1:1']);
    expect(isSelected(out, 0, 1)).toBe(false);
    expect(list(toggleCell(out, at(0, 1)))).toEqual(['0:0', '0:1', '1:0', '1:1']);
  });

  it('Shift+click after a Cmd+click extends from the new anchor and keeps the old range', () => {
    const sel = extendTo(toggleCell(selectCell(at(0, 0)), at(4, 2)), at(5, 2), 4);
    expect(list(sel)).toEqual(['0:0', '4:2', '5:2']);
  });

  it('the id column selects whole rows, and Shift extends by whole rows', () => {
    const one = selectRow(2, 3);
    expect(list(one)).toEqual(['2:0', '2:1', '2:2']);
    const span = extendTo(one, at(3, 0), 3);
    expect(list(span)).toEqual(['2:0', '2:1', '2:2', '3:0', '3:1', '3:2']);
  });

  it('Cmd+click on the id column toggles the whole row', () => {
    const base = selectCell(at(0, 0));
    const withRow = toggleRow(base, 1, 2);
    expect(list(withRow)).toEqual(['0:0', '1:0', '1:1']);
    expect(list(toggleRow(withRow, 1, 2))).toEqual(['0:0']);
  });

  it('overlapping ranges count each cell once', () => {
    const sel = extendTo(
      toggleCell(extendTo(selectCell(at(0, 0)), at(1, 1), 4), at(1, 1)),
      at(2, 2),
      4,
    );
    // (1,1) was taken out by the toggle, then covered again by the new range.
    expect(list(sel)).toEqual(['0:0', '0:1', '1:0', '1:1', '1:2', '2:1', '2:2']);
  });

  it('reports the marked columns of one row', () => {
    const sel = toggleCell(extendTo(selectCell(at(0, 0)), at(2, 1), 4), at(1, 3));
    expect(colsAt(sel, 1)).toEqual([0, 1, 3]);
    expect(colsAt(sel, 7)).toEqual([]);
  });

  it('answers "more than one" on a huge range without enumerating it', () => {
    const sel = extendTo(selectCell(at(0, 0)), at(19_999, 9), 10);
    expect(isMultiple(sel)).toBe(true);
  });

  it('counts by area for one range, and by enumeration for several', () => {
    const big = extendTo(selectCell(at(0, 0)), at(19_999, 9), 10);
    expect(countOf(big)).toBe(200_000);
    expect(countOf(toggleCell(big, at(5, 5)))).toBe(199_999);
    const two = toggleCell(extendTo(selectCell(at(0, 0)), at(1, 1), 4), at(3, 3));
    expect(countOf(two)).toBe(5);
    expect(countOf(EMPTY_SELECTION)).toBe(0);
  });
});
