// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { segmentsOf, composeSegments, editedText, placeholderIds, plainText, textOnly } from '../src/segments.js';
import { scan } from '../src/scan.js';
import { sliceSpan } from '../src/model.js';
import { oneUnit, ph } from './fixtures.js';
import { corpusEntries } from './corpus.js';

const segsOfSource = (sourceXml: string) => {
  const raw = oneUnit({ id: 'a', source: sourceXml });
  const unit = scan(raw).files[0]!.units[0]!;
  return { raw, segments: segmentsOf(raw, unit.source.innerSpan) };
};

describe('segmentsOf — decomposition', () => {
  it('returns a single text segment for plain text', () => {
    const { segments } = segsOfSource('Hello world');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ k: 't', v: 'Hello world' });
  });

  it('returns nothing for empty content', () => {
    expect(segsOfSource('').segments).toEqual([]);
  });

  it('splits text around a placeholder', () => {
    const { segments } = segsOfSource(`You have ${ph.interpolation(0, '{{ n }}')} invoices`);
    expect(segments.map((s) => s.k)).toEqual(['t', 'p', 't']);
    expect(segments[1]).toMatchObject({ k: 'p', id: 'INTERPOLATION', equivText: '{{ n }}' });
  });

  it('keeps the placeholder tag as its exact original bytes', () => {
    const tag = ph.startTag('strong');
    const { segments } = segsOfSource(`a${tag}b`);
    expect(segments[1]).toMatchObject({ k: 'p', raw: tag });
  });

  it('reads ctype from the placeholder', () => {
    const { segments } = segsOfSource(ph.startTag('span'));
    expect(segments[0]).toMatchObject({ ctype: 'x-span' });
  });

  it('leaves equivText undefined when the placeholder has none', () => {
    const { segments } = segsOfSource('<x id="CUSTOM"/>');
    expect(segments[0]).toMatchObject({ k: 'p', id: 'CUSTOM' });
    expect((segments[0] as { equivText?: string }).equivText).toBeUndefined();
  });

  it('decodes text but records its raw span', () => {
    const { raw, segments } = segsOfSource('a&amp;b &lt;c&gt;');
    expect(segments[0]).toMatchObject({ k: 't', v: 'a&b <c>' });
    expect(sliceSpan(raw, segments[0]!.span!)).toBe('a&amp;b &lt;c&gt;');
  });

  it('coalesces text that the parser reports in fragments', () => {
    const { segments } = segsOfSource(`x&#39;y&apos;z`);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ v: `x'y'z` });
  });

  it('represents a paired <g> as a group with children', () => {
    const { segments } = segsOfSource('Click <g id="g1">here <x id="N"/></g> now');
    expect(segments.map((s) => s.k)).toEqual(['t', 'g', 't']);
    const group = segments[1] as { k: 'g'; id: string; children: readonly { k: string }[] };
    expect(group.id).toBe('g1');
    expect(group.children.map((c) => c.k)).toEqual(['t', 'p']);
  });

  it('handles adjacent placeholders with no text between them', () => {
    const { segments } = segsOfSource(`${ph.startTag('b')}${ph.closeTag('b')}`);
    expect(segments.map((s) => s.k)).toEqual(['p', 'p']);
  });
});

describe('composeSegments — the identity that makes editing safe', () => {
  it.each([
    'Hello world',
    '',
    `You have ${ph.interpolation(0, '{{ n }}')} invoices`,
    `${ph.startTag('strong')}bold${ph.closeTag('strong')}`,
    'a&amp;b &lt;c&gt; &apos;d&apos; &quot;e&quot;',
    'a&amp;amp;b',
    'Click <g id="g1">here <x id="N"/></g> now',
    '1 > 0',
    `${ph.startTag('b')}${ph.closeTag('b')}`,
  ])('recomposes %j byte for byte', (sourceXml) => {
    const { segments } = segsOfSource(sourceXml);
    expect(composeSegments(segments, 'angular')).toBe(sourceXml);
  });

  it('recomposes every source and target in the corpus byte for byte', () => {
    let checked = 0;
    for (const [, raw] of corpusEntries()) {
      for (const file of scan(raw).files) {
        for (const unit of file.units) {
          for (const ref of [unit.source, unit.target]) {
            if (!ref || ref.selfClosing) continue;
            const original = sliceSpan(raw, ref.innerSpan);
            expect(composeSegments(segmentsOf(raw, ref.innerSpan), 'angular')).toBe(original);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('escapes text that was edited, while leaving untouched text byte-identical', () => {
    const { segments } = segsOfSource('a&#39;b');
    // Untouched: the original numeric entity survives.
    expect(composeSegments(segments, 'angular')).toBe('a&#39;b');
    // Edited: re-escaped with Angular's rule.
    const edited = segments.map((s) => (s.k === 't' ? editedText(`a'b!`) : s));
    expect(composeSegments(edited, 'angular')).toBe('a&apos;b!');
  });
});

describe('derived views', () => {
  it('lists placeholder ids in document order, including inside groups', () => {
    const { segments } = segsOfSource(`${ph.interpolation(0)}<g id="g1"><x id="INNER"/></g>${ph.interpolation(1)}`);
    expect(placeholderIds(segments)).toEqual(['INTERPOLATION', 'INNER', 'INTERPOLATION_1']);
  });

  it('renders plain text with placeholders shown as their equiv-text', () => {
    const { segments } = segsOfSource(`You have ${ph.interpolation(0, '{{ n }}')} left`);
    expect(plainText(segments)).toBe('You have {{ n }} left');
  });

  it('renders text-only content with placeholders dropped', () => {
    const { segments } = segsOfSource(`You have ${ph.interpolation(0, '{{ n }}')} left`);
    expect(textOnly(segments)).toBe('You have  left');
  });
});
