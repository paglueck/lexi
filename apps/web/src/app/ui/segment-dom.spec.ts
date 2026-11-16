// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { SegmentDto } from '@lexi/shared';

import { FILLER, renderSegments, segmentsPlainText, serializeSegments } from './segment-dom.js';

/**
 * The editor's DOM layer, as far as jsdom can honestly go.
 *
 * WHAT IS DELIBERATELY NOT HERE: caret movement, `beforeinput`, composition and
 * drag. jsdom implements none of them faithfully, so a test of those would pass
 * for the wrong reason — which is worse than not testing them, because it looks
 * like coverage. They were verified in a real browser instead; see
 * docs/architecture.md (segment editor).
 *
 * What a `childNodes` walk does is the same everywhere, so the serializer, the
 * filler-node strategy and the round trip belong here.
 */

const host = (): HTMLElement => document.createElement('div');

const CHIP: SegmentDto = { k: 'p', id: 'INTERPOLATION', equivText: '{{ count }}' };

describe('renderSegments', () => {
  it('renders a placeholder as a non-editable chip carrying its id', () => {
    const el = host();
    renderSegments(el, [{ k: 't', v: 'You have ' }, CHIP]);

    const chip = el.querySelector('[data-ph]');
    expect(chip?.getAttribute('data-ph')).toBe('INTERPOLATION');
    expect(chip?.getAttribute('contenteditable')).toBe('false');
    expect(chip?.textContent).toBe('{{ count }}');
  });

  it('uses the same .lx-chip class the grid emits as raw markup', () => {
    // The kit promise from M2, now checked from the editor's end too: one CSS
    // rule styles the chip in the grid, the panel and the editor alike.
    const el = host();
    renderSegments(el, [CHIP]);
    expect(el.querySelector('.lx-chip')).not.toBeNull();
  });

  it('puts a text node on both sides of a chip so the caret has somewhere to land', () => {
    const el = host();
    renderSegments(el, [CHIP]);

    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.firstChild?.nodeValue).toBe(FILLER);
  });

  it('separates two adjacent chips, which is where the caret is otherwise trapped', () => {
    const el = host();
    renderSegments(el, [
      { k: 'p', id: 'START_TAG_B', equivText: '<b>' },
      { k: 'p', id: 'CLOSE_TAG_B', equivText: '</b>' },
    ]);
    const chips = el.querySelectorAll('[data-ph]');
    expect(chips[0]?.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(chips[0]?.nextSibling).toBe(chips[1]?.previousSibling);
  });
});

describe('serializeSegments', () => {
  const roundTrip = (segments: readonly SegmentDto[]): SegmentDto[] => {
    const el = host();
    renderSegments(el, segments);
    return serializeSegments(el);
  };

  it('round-trips text and chips', () => {
    const value: SegmentDto[] = [{ k: 't', v: 'You have ' }, CHIP, { k: 't', v: ' invoices' }];
    expect(roundTrip(value)).toEqual(value);
  });

  it('round-trips a nested <g> group', () => {
    const value: SegmentDto[] = [
      { k: 't', v: 'Read the ' },
      { k: 'g', id: 'LINK', children: [{ k: 't', v: 'terms' }, CHIP] },
      { k: 't', v: ' please' },
    ];
    expect(roundTrip(value)).toEqual(value);
  });

  it('strips the filler characters, so they never reach a file', () => {
    const out = roundTrip([CHIP]);
    expect(JSON.stringify(out)).not.toContain(FILLER);
    expect(out).toEqual([CHIP]);
  });

  it('coalesces text the browser split, which it does freely as the caret moves', () => {
    const el = host();
    el.appendChild(document.createTextNode('Jetzt '));
    el.appendChild(document.createTextNode('bezahlen'));
    expect(serializeSegments(el)).toEqual([{ k: 't', v: 'Jetzt bezahlen' }]);
  });

  it('keeps pasted markup as TEXT rather than inventing a placeholder', () => {
    // The one thing the client must never do. A fabricated id is refused by the
    // server, but it should never get that far.
    const el = host();
    el.appendChild(document.createTextNode('<x id="EVIL"/>'));
    expect(serializeSegments(el)).toEqual([{ k: 't', v: '<x id="EVIL"/>' }]);
  });

  it('takes the text out of foreign markup a paste slipped through, and drops the markup', () => {
    const el = host();
    const b = document.createElement('b');
    b.textContent = 'bold';
    el.appendChild(b);
    expect(serializeSegments(el)).toEqual([{ k: 't', v: 'bold' }]);
  });

  it('ignores a trailing <br>, which browsers add as their own filler', () => {
    const el = host();
    el.appendChild(document.createTextNode('Hallo'));
    el.appendChild(document.createElement('br'));
    expect(serializeSegments(el)).toEqual([{ k: 't', v: 'Hallo' }]);
  });

  it('reports an emptied field as no segments at all', () => {
    const el = host();
    renderSegments(el, []);
    expect(serializeSegments(el)).toEqual([]);
  });
});

describe('segmentsPlainText', () => {
  it('counts a chip as its label, matching the engine plainText', () => {
    expect(segmentsPlainText([{ k: 't', v: 'You have ' }, CHIP])).toBe('You have {{ count }}');
  });

  it('descends into groups', () => {
    expect(segmentsPlainText([{ k: 'g', id: 'L', children: [{ k: 't', v: 'terms' }] }])).toBe(
      'terms',
    );
  });
});
