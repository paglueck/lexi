// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { maskSegments, restoreRaw, unmask, type MaskResult } from '../src/mask.js';
import { composeSegments, segmentsOf, placeholderIds, type Segment } from '../src/segments.js';
import { scan } from '../src/scan.js';
import { oneUnit, ph } from './fixtures.js';
import { corpusEntries } from './corpus.js';

const maskSource = (sourceXml: string): MaskResult => {
  const raw = oneUnit({ id: 'a', source: sourceXml });
  const unit = scan(raw).files[0]!.units[0]!;
  return maskSegments(segmentsOf(raw, unit.source.innerSpan));
};

describe('maskSegments', () => {
  it('replaces each placeholder with a numbered token', () => {
    const result = maskSource(`You have ${ph.interpolation(0, '{{ n }}')} invoices`);
    expect(result.masked).toBe('You have [[0]] invoices');
  });

  it('numbers tokens from zero in document order', () => {
    const result = maskSource(`${ph.startTag('b')}${ph.interpolation(0)} x${ph.closeTag('b')}`);
    expect(result.masked).toBe('[[0]][[1]] x[[2]]');
    expect(result.tokens.map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it('labels each token with its equiv-text for the prompt', () => {
    const result = maskSource(`${ph.startTag('strong')}${ph.interpolation(0, '{{ invoiceCount }}')}${ph.closeTag('strong')}`);
    expect(result.tokens.map((t) => t.label)).toEqual(['<strong>', '{{ invoiceCount }}', '</strong>']);
  });

  it('falls back to the id when a placeholder has no equiv-text', () => {
    expect(maskSource('<x id="CUSTOM"/>').tokens[0]!.label).toBe('CUSTOM');
  });

  it('shows the model decoded text, never escaped entities', () => {
    expect(maskSource('Tom &amp; Jerry &lt;b&gt;').masked).toBe('Tom & Jerry <b>');
  });

  it('masks group boundaries as separate tokens so the model can move them', () => {
    const result = maskSource('Click <g id="g1">here</g> now');
    expect(result.masked).toBe('Click [[0]]here[[1]] now');
  });

  it('produces no tokens for text with no placeholders', () => {
    const result = maskSource('Just words');
    expect(result.tokens).toEqual([]);
    expect(result.masked).toBe('Just words');
  });
});

describe('unmask — the happy paths', () => {
  it('restores a straight translation', () => {
    const result = maskSource(`You have ${ph.interpolation(0, '{{ n }}')} invoices`);
    const out = unmask('Sie haben [[0]] Rechnungen', result);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(composeSegments(out.segments, 'angular'))
      .toBe(`Sie haben ${ph.interpolation(0, '{{ n }}')} Rechnungen`);
  });

  it('accepts reordered tokens, because word order is the point', () => {
    const result = maskSource(`${ph.interpolation(0, '{{ a }}')} and ${ph.interpolation(1, '{{ b }}')}`);
    const out = unmask('[[1]] und [[0]]', result);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(placeholderIds(out.segments)).toEqual(['INTERPOLATION_1', 'INTERPOLATION']);
  });

  it('escapes the model\'s text exactly once', () => {
    const result = maskSource(`x ${ph.interpolation(0, '{{ n }}')}`);
    const out = unmask(`Tom & Jerry's "<b>" [[0]]`, result);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const composed = composeSegments(out.segments, 'angular');
    expect(composed).toContain('Tom &amp; Jerry&apos;s &quot;&lt;b&gt;&quot;');
    expect(composed).not.toContain('&amp;amp;');
  });

  it('restores placeholders as their exact original bytes', () => {
    const tag = ph.startTag('strong');
    const result = maskSource(`${tag}x`);
    const out = unmask('[[0]]y', result);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(composeSegments(out.segments, 'angular')).toBe(`${tag}y`);
  });

  it('accepts a translation with no placeholders when the source had none', () => {
    const out = unmask('Nur Worte', maskSource('Just words'));
    expect(out.ok).toBe(true);
  });

  it('round-trips every source in the corpus through mask and unmask', () => {
    let checked = 0;
    for (const [, raw] of corpusEntries()) {
      for (const file of scan(raw).files) {
        for (const unit of file.units) {
          const segments = segmentsOf(raw, unit.source.innerSpan);
          // A unit with an empty <source/> is never sent for translation, and an
          // empty model response is a rejection by design — see the 'empty' gate.
          if (segments.length === 0) continue;
          const masked = maskSegments(segments);
          const out = unmask(masked.masked, masked);
          expect(out.ok).toBe(true);
          if (out.ok) {
            // Compare through a reparse rather than on the segment list: restoring
            // flattens a <g> into its two boundary tokens, which is byte-correct but
            // structurally different until the bytes are read back.
            const composed = composeSegments(out.segments, 'angular');
            const probe = oneUnit({ id: 'p', source: 'x', target: composed });
            expect(scan(probe).files[0]!.units[0]!.targetPhIds).toEqual(placeholderIds(segments));
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('unmask — the gates', () => {
  const withTwo = () => maskSource(`${ph.interpolation(0, '{{ a }}')} and ${ph.interpolation(1, '{{ b }}')}`);

  it('rejects an index the source never had', () => {
    const out = unmask('[[0]] and [[9]]', withTwo());
    expect(out).toMatchObject({ ok: false, reason: 'token-out-of-range' });
  });

  it('rejects a dropped placeholder', () => {
    const out = unmask('nur [[0]]', withTwo());
    expect(out).toMatchObject({ ok: false, reason: 'placeholder-missing' });
    if (out.ok) return;
    expect(out.missing).toEqual(['INTERPOLATION_1']);
  });

  it('rejects a duplicated placeholder', () => {
    const out = unmask('[[0]] [[0]] [[1]]', withTwo());
    expect(out).toMatchObject({ ok: false, reason: 'placeholder-duplicated' });
  });

  it.each([
    ['[ [0] ] and [[1]]', 'spaced brackets'],
    ['((0)) and [[1]]', 'wrong bracket shape'],
    ['［［0］］ and [[1]]', 'full-width brackets'],
    ['[[0] and [[1]]', 'unbalanced bracket'],
  ])('rejects a malformed token: %s (%s)', (output) => {
    const out = unmask(output, withTwo());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // Either the token is simply missing or it is recognisably mangled; both are
    // rejections, but a mangled one earns its own reason so the retry prompt can
    // say "write the tokens exactly as [[0]]" rather than "you dropped one".
    expect(['malformed-token', 'placeholder-missing']).toContain(out.reason);
  });

  it('gives a malformed token its own reason when the count is otherwise right', () => {
    const out = unmask('[ [0] ] and [ [1] ]', withTwo());
    expect(out).toMatchObject({ ok: false, reason: 'malformed-token' });
  });

  it('rejects a model that wrote real XLIFF markup instead of tokens', () => {
    const out = unmask('[[0]] and <x id="INTERPOLATION_1" equiv-text="{{ b }}"/>', withTwo());
    expect(out).toMatchObject({ ok: false, reason: 'invented-markup' });
  });

  it('rejects escaped markup too', () => {
    const out = unmask('[[0]] and &lt;x id="X"/&gt; [[1]]', withTwo());
    expect(out).toMatchObject({ ok: false, reason: 'invented-markup' });
  });

  it('rejects an empty translation', () => {
    expect(unmask('   ', maskSource('Just words'))).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('reports which placeholders were missing and which were extra', () => {
    const out = unmask('[[0]] [[0]]', withTwo());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.missing).toEqual(['INTERPOLATION_1']);
  });

  it('never returns segments on a rejection, so a bad draft cannot be written by accident', () => {
    const out = unmask('nur [[0]]', withTwo());
    expect(out.ok).toBe(false);
    expect('segments' in out).toBe(false);
  });
});

/**
 * The other half of Appendix A's open question (requirements §11): can a
 * local model be trusted with the real `<x id="…" equiv-text="…"/>` markup
 * instead of `[[n]]` tokens? The answer needs a restore path for that shape
 * too, gated exactly as hard, or the comparison would be between a strict path
 * and a lenient one rather than between two prompts.
 */
describe('restoreRaw — the model answered in XLIFF markup', () => {
  const sourceOf = (sourceXml: string): Segment[] => {
    const raw = oneUnit({ id: 'a', source: sourceXml });
    const unit = scan(raw).files[0]!.units[0]!;
    return segmentsOf(raw, unit.source.innerSpan);
  };

  it('restores a translation that reproduced the element', () => {
    const source = sourceOf(`You have ${ph.interpolation(0, '{{ n }}')} invoices`);
    const out = restoreRaw(`Sie haben ${ph.interpolation(0, '{{ n }}')} Rechnungen`, source);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(composeSegments(out.segments, 'angular')).toBe(
      `Sie haben ${ph.interpolation(0, '{{ n }}')} Rechnungen`,
    );
  });

  /**
   * The point of the whole design: the model's bytes for a placeholder are
   * discarded and the source's are re-attached by id. So a model that
   * "helpfully" translated an equiv-text, dropped an attribute or reordered two
   * cannot change how that placeholder is spelled in the file.
   */
  it('re-attaches the SOURCE bytes, whatever the model wrote inside the tag', () => {
    const source = sourceOf(`Hallo ${ph.interpolation(0, '{{ name }}')}`);
    const out = restoreRaw('Hallo <x id="INTERPOLATION" equiv-text="{{ Name }}" ctype="x-invented"/>', source);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(composeSegments(out.segments, 'angular')).toBe(`Hallo ${ph.interpolation(0, '{{ name }}')}`);
  });

  it('restores a group, and re-escapes only the text the model wrote', () => {
    const source = sourceOf('Read <g id="g1">the terms &amp; conditions</g> now');
    const out = restoreRaw('Lesen Sie jetzt <g id="g1">die AGB & Hinweise</g>', source);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(composeSegments(out.segments, 'angular')).toBe(
      'Lesen Sie jetzt <g id="g1">die AGB &amp; Hinweise</g>',
    );
  });

  it('rejects an invented placeholder rather than fabricating a tag for it', () => {
    const source = sourceOf(`Hallo ${ph.interpolation(0)}`);
    const out = restoreRaw('Hallo <x id="INTERPOLATION"/> <x id="NOPE"/>', source);
    expect(out).toMatchObject({ ok: false, reason: 'unknown-placeholder' });
    if (out.ok) return;
    expect(out.extra).toEqual(['NOPE']);
  });

  it('rejects a dropped placeholder', () => {
    const source = sourceOf(`${ph.interpolation(0)} und ${ph.interpolation(1)}`);
    const out = restoreRaw('nur <x id="INTERPOLATION"/>', source);
    expect(out).toMatchObject({ ok: false, reason: 'placeholder-missing' });
    if (out.ok) return;
    expect(out.missing).toEqual(['INTERPOLATION_1']);
  });

  it('rejects a duplicated placeholder', () => {
    const source = sourceOf(`${ph.interpolation(0)} und ${ph.interpolation(1)}`);
    const out = restoreRaw('<x id="INTERPOLATION"/> <x id="INTERPOLATION"/> <x id="INTERPOLATION_1"/>', source);
    expect(out).toMatchObject({ ok: false, reason: 'placeholder-duplicated' });
  });

  /**
   * The failure mode raw markup has and masked tokens do not: a `<g>` the model
   * opened and never closed.
   *
   * It must be a refusal rather than a repair, and that is not automatic: the
   * fragment parser auto-closes at end of input and the rebuild re-attaches the
   * SOURCE's `</g>`, so the obvious implementation silently produces
   * well-formed XML in which the group now wraps the rest of the sentence.
   */
  it('rejects an unclosed group rather than silently repairing it', () => {
    const source = sourceOf('Read <g id="g1">the terms</g> now');
    const out = restoreRaw('Lesen Sie <g id="g1">die AGB jetzt', source);
    expect(out).toMatchObject({ ok: false, reason: 'malformed-result' });
  });

  it('accepts a bare ampersand, which is text a translator may legitimately write', () => {
    const source = sourceOf('Terms and conditions');
    const out = restoreRaw('AGB & Hinweise', source);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(composeSegments(out.segments, 'angular')).toBe('AGB &amp; Hinweise');
  });

  it('rejects an empty translation', () => {
    expect(restoreRaw('  ', sourceOf('Just words'))).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('never returns segments on a rejection', () => {
    const source = sourceOf(`${ph.interpolation(0)} und ${ph.interpolation(1)}`);
    expect('segments' in restoreRaw('nichts', source)).toBe(false);
  });
});
