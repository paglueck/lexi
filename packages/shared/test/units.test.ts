// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { ROW_ID_SEP, rowIdOf, splitRowId } from '../src/constants.js';
import {
  ReviewPatchSchema,
  SegmentSchema,
  UnitTargetSchema,
  UnitsQueryRequestSchema,
  type SegmentDto,
} from '../src/units.js';

describe('row ids', () => {
  it('round-trips a group and a unit id', () => {
    expect(splitRowId(rowIdOf('messages', '8f2c1a09b3e7'))).toEqual({
      group: 'messages',
      unitId: '8f2c1a09b3e7',
    });
  });

  it('keeps the two halves of a duplicated id apart', () => {
    // The case edge/two-files.xlf exists for: one id, two <file> elements.
    const a = rowIdOf('messages', 'checkout.pay_now');
    const b = rowIdOf('checkout', 'checkout.pay_now');
    expect(a).not.toEqual(b);
    expect(splitRowId(a).group).toBe('messages');
    expect(splitRowId(b).group).toBe('checkout');
  });

  it('survives a @@customId full of dots and dashes', () => {
    const id = 'checkout.free-shipping.banner_v2';
    expect(splitRowId(rowIdOf('catalog', id)).unitId).toBe(id);
  });

  it('splits on the FIRST separator, so a separator in the id cannot corrupt the group', () => {
    // Not reachable from a well-formed XLIFF file — the separator is illegal in
    // an XML Name — but the parser must not silently mis-attribute if it were.
    const rowId = rowIdOf('messages', 'weird' + ROW_ID_SEP + 'id');
    expect(splitRowId(rowId)).toEqual({ group: 'messages', unitId: 'weird' + ROW_ID_SEP + 'id' });
  });

  it('survives percent-encoding, which is how the detail route carries it', () => {
    const rowId = rowIdOf('messages', '8f2c1a09b3e7');
    expect(decodeURIComponent(encodeURIComponent(rowId))).toBe(rowId);
  });
});

describe('SegmentSchema', () => {
  it('parses a nested <g> group, so the recursive getter really recurses', () => {
    const nested: SegmentDto = {
      k: 'g',
      id: 'START_TAG_SPAN',
      children: [
        { k: 't', v: 'You have ' },
        { k: 'p', id: 'INTERPOLATION', equivText: '{{ invoiceCount }}' },
        { k: 'g', id: 'START_TAG_STRONG', children: [{ k: 't', v: 'invoices' }] },
      ],
    };
    expect(SegmentSchema.parse(nested)).toEqual(nested);
  });

  it('rejects a segment carrying raw bytes', () => {
    // The whole point of the wire form: original bytes never cross it, because
    // a byte that round-trips through the client has passed through a
    // decode/encode cycle and escape(decode(x)) !== x in general.
    const withRaw = { k: 'p', id: 'INTERPOLATION', raw: '<x id="INTERPOLATION"/>' };
    const parsed = SegmentSchema.parse(withRaw) as Record<string, unknown>;
    expect(parsed['raw']).toBeUndefined();
  });
});

describe('UnitsQueryRequestSchema', () => {
  it('defaults every field, so an empty body is a valid "everything" query', () => {
    expect(UnitsQueryRequestSchema.parse({})).toEqual({
      search: '',
      scope: 'all',
      groups: [],
      locales: [],
      filters: [],
    });
  });

  it('refuses a filter that is not in the vocabulary', () => {
    expect(() => UnitsQueryRequestSchema.parse({ filters: ['notARule'] })).toThrow();
  });
});

describe('ReviewPatchSchema (M14)', () => {
  it('defaults the reasons, so a plain decision is a valid body', () => {
    expect(ReviewPatchSchema.parse({ decision: 'approve' })).toEqual({
      decision: 'approve',
      reasons: [],
    });
  });

  it('refuses a decision outside the vocabulary', () => {
    expect(() => ReviewPatchSchema.parse({ decision: 'maybe' })).toThrow();
  });

  it('refuses an unknown member rather than dropping it', () => {
    // zod strips unknown keys by default. A misspelled `decision` would then
    // arrive as "no decision stated", which reads as an ordinary grid edit and
    // silently mis-files the edit-rate metric.
    expect(() => ReviewPatchSchema.parse({ decision: 'reject', resaons: ['too-long'] })).toThrow();
  });
});

describe('UnitTargetSchema (M14)', () => {
  const base = {
    locale: 'de',
    isRtl: false,
    state: 'draftMachine',
    missing: false,
    noFile: false,
    newFile: null,
    segments: [{ k: 't', v: 'Jetzt bezahlen' }],
    findings: [],
    missingPlaceholders: [],
    charCount: 14,
    previous: null,
    origin: null,
    reviewReasons: [],
  };

  it('parses a target with no provenance at all', () => {
    expect(UnitTargetSchema.parse(base)).toMatchObject({ previous: null, origin: null });
  });

  it('parses a marker written before the provenance fields existed', () => {
    // `.lexi/state.json` is committed, so a project opened after a `git pull`
    // may carry M9-era records. Insisting on the newer fields would demote
    // every one of those drafts to a plain human edit.
    const parsed = UnitTargetSchema.parse({
      ...base,
      origin: { at: '2026-03-14T10:00:00.000Z', model: 'qwen2.5:14b', style: 'masked' },
    });
    expect(parsed.origin).toEqual({
      at: '2026-03-14T10:00:00.000Z',
      model: 'qwen2.5:14b',
      style: 'masked',
    });
  });
});
