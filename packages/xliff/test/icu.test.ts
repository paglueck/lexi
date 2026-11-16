// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  flattenForIcu, unflattenIcu, parseIcu, looksLikeIcu,
  selectArguments, selectorsOf, type SelectNode,
} from '../src/icu/parse.js';
import { segmentsOf, composeSegments, placeholderIds } from '../src/segments.js';
import { scan } from '../src/scan.js';
import { oneUnit, ph } from './fixtures.js';

const PLURAL = '{VAR_PLURAL, plural, =0 {no items} one {1 item} other {# items}}';
const SELECT = '{VAR_SELECT, select, male {He replied} female {She replied} other {They replied}}';

const segsOf = (sourceXml: string) => {
  const raw = oneUnit({ id: 'a', source: sourceXml });
  return segmentsOf(raw, scan(raw).files[0]!.units[0]!.source.innerSpan);
};

const parseOk = (text: string) => {
  const result = parseIcu(text);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result;
};

describe('looksLikeIcu', () => {
  it.each([PLURAL, SELECT, '{VAR_PLURAL, selectordinal, one {#st} other {#th}}'])(
    'recognises %j', (text) => expect(looksLikeIcu(text)).toBe(true),
  );

  it.each([
    'Plain text',
    'A price of {0} euros',            // a bare argument is not a select
    'Braces { and } on their own',
    '',
  ])('does not mistake %j for an ICU message', (text) => {
    expect(looksLikeIcu(text)).toBe(false);
  });
});

describe('parseIcu — structure', () => {
  it('reads the argument name, type and selectors of a plural', () => {
    const [arg] = selectArguments(parseOk(PLURAL).nodes);
    expect(arg!.type).toBe('plural');
    expect(arg!.varName).toBe('VAR_PLURAL');
    expect(selectorsOf(arg!)).toEqual(['=0', 'one', 'other']);
  });

  it('reads a select argument', () => {
    const [arg] = selectArguments(parseOk(SELECT).nodes);
    expect(arg!.type).toBe('select');
    expect(selectorsOf(arg!)).toEqual(['male', 'female', 'other']);
  });

  it('reads selectordinal as its own type, because its categories differ', () => {
    const [arg] = selectArguments(parseOk('{VAR, selectordinal, one {#st} other {#th}}').nodes);
    expect(arg!.type).toBe('selectordinal');
  });

  it('reads an offset', () => {
    const [arg] = selectArguments(parseOk('{N, plural, offset:1 one {#} other {#}}').nodes);
    expect(arg!.offset).toBe(1);
  });

  it('leaves offset undefined when there is none', () => {
    expect(selectArguments(parseOk(PLURAL).nodes)[0]!.offset).toBeUndefined();
  });

  it('keeps text around the argument as literals', () => {
    const { nodes } = parseOk(`You have ${PLURAL} left`);
    expect(nodes.map((n) => n.k)).toEqual(['literal', 'select', 'literal']);
  });

  it('records # inside a branch as its own node', () => {
    const [arg] = selectArguments(parseOk(PLURAL).nodes);
    const other = arg!.branches.find((b) => b.selector === 'other')!;
    expect(other.body.map((n) => n.k)).toEqual(['hash', 'literal']);
  });

  it('parses a nested plural inside a select branch', () => {
    const nested = '{G, select, male {{N, plural, one {he has #} other {he has #}}} other {none}}';
    const args = selectArguments(parseOk(nested).nodes);
    expect(args.map((a) => a.type)).toEqual(['select', 'plural']);
    expect(args[1]!.varName).toBe('N');
  });

  it('treats a bare argument as a simple argument, not a select', () => {
    const { nodes } = parseOk('Hello {NAME}');
    expect(nodes.map((n) => n.k)).toEqual(['literal', 'arg']);
    expect(selectArguments(nodes)).toEqual([]);
  });

  it('respects ICU quoting so a quoted brace does not unbalance the message', () => {
    const { nodes } = parseOk("{N, plural, one {a '{' brace} other {#}}");
    const arg = selectArguments(nodes)[0]!;
    expect(selectorsOf(arg)).toEqual(['one', 'other']);
  });

  it('leaves a lone apostrophe alone', () => {
    const arg = selectArguments(parseOk("{N, plural, one {it's one} other {#}}").nodes)[0]!;
    expect(selectorsOf(arg)).toEqual(['one', 'other']);
  });
});

describe('parseIcu — spans', () => {
  it('spans each branch body so a translation is a one-branch edit', () => {
    const arg = selectArguments(parseOk(PLURAL).nodes)[0]!;
    const bodies = arg.branches.map((b) => PLURAL.slice(b.bodyInnerSpan.start, b.bodyInnerSpan.end));
    expect(bodies).toEqual(['no items', '1 item', '# items']);
  });

  it('spans the selector itself', () => {
    const arg = selectArguments(parseOk(PLURAL).nodes)[0]!;
    expect(PLURAL.slice(arg.branches[0]!.selectorSpan.start, arg.branches[0]!.selectorSpan.end)).toBe('=0');
  });

  it('spans the variable name', () => {
    const arg = selectArguments(parseOk(PLURAL).nodes)[0]!;
    expect(PLURAL.slice(arg.varSpan.start, arg.varSpan.end)).toBe('VAR_PLURAL');
  });

  it('spans the whole argument', () => {
    const { nodes } = parseOk(`before ${PLURAL} after`);
    const arg = selectArguments(nodes)[0]!;
    const text = `before ${PLURAL} after`;
    expect(text.slice(arg.span.start, arg.span.end)).toBe(PLURAL);
  });
});

describe('parseIcu — refusals', () => {
  it.each([
    ['{N, plural, one {unclosed}', 'unbalanced braces'],
    ['{N, plural}', 'no branches'],
    ['{, plural, other {x}}', 'no argument name'],
    ['{N, plural, {x}}', 'a branch with no selector'],
  ])('refuses %j (%s)', (text) => {
    expect(parseIcu(text).ok).toBe(false);
  });

  it('points at the argument that was left open, naming it', () => {
    // Same convention as the XML scanner: report the construct that never closes
    // rather than the end of the input, which tells the reader nothing.
    const text = '{N, plural, one {unclosed}';
    const result = parseIcu(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"N" is not closed/);
    expect(result.offset).toBe(0);
    expect(text[result.offset]).toBe('{');
  });

  it('reports the offset of the construct itself, wherever it starts', () => {
    const text = 'prefix {N, plural, one {x} other {y}';
    const result = parseIcu(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.offset).toBe(7);
    expect(text[result.offset]).toBe('{');
  });
});

describe('flattenForIcu — placeholders are opaque atoms', () => {
  it('replaces each placeholder with a sentinel that cannot be mistaken for syntax', () => {
    const segments = segsOf(`{VAR_PLURAL, plural, one {one ${ph.interpolation(0, '{{ n }}')} item} other {#}}`);
    const flat = flattenForIcu(segments);
    // The placeholder's equiv-text contains braces; flattening must hide them,
    // or the ICU parser would see `{{ n }}` as nested arguments.
    expect(flat.text).not.toContain('{{ n }}');
    expect(flat.placeholders).toHaveLength(1);
    expect(parseIcu(flat.text).ok).toBe(true);
  });

  it('parses an ICU message whose branch contains a placeholder', () => {
    const segments = segsOf(`{N, plural, one {1 ${ph.interpolation(0, '{{ thing }}')}} other {# things}}`);
    const flat = flattenForIcu(segments);
    const arg = selectArguments(parseOk(flat.text).nodes)[0]!;
    expect(selectorsOf(arg)).toEqual(['one', 'other']);
  });

  it('restores the original segments exactly', () => {
    const source = `{N, plural, one {1 ${ph.interpolation(0, '{{ thing }}')}} other {# things}}`;
    const segments = segsOf(source);
    const flat = flattenForIcu(segments);
    const restored = unflattenIcu(flat.text, flat);
    expect(composeSegments(restored, 'angular')).toBe(source);
    expect(placeholderIds(restored)).toEqual(placeholderIds(segments));
  });

  it('restores segments after a branch body is edited', () => {
    const source = `{N, plural, one {1 ${ph.interpolation(0, '{{ thing }}')}} other {# things}}`;
    const flat = flattenForIcu(segsOf(source));
    const edited = flat.text.replace('# things', '# Dinge');
    const restored = unflattenIcu(edited, flat);
    const composed = composeSegments(restored, 'angular');
    expect(composed).toContain('# Dinge');
    expect(composed).toContain(ph.interpolation(0, '{{ thing }}'));
  });

  it('is a no-op for text with no placeholders', () => {
    const flat = flattenForIcu(segsOf(PLURAL));
    expect(flat.text).toBe(PLURAL);
    expect(flat.placeholders).toEqual([]);
  });
});

describe('parseIcu — byte-exact recomposition (T7)', () => {
  const samples = [
    PLURAL,
    SELECT,
    `You have ${PLURAL} left`,
    '{N, plural, offset:1 =0 {none} one {#} other {# more}}',
    '{G, select, male {{N, plural, one {he has #} other {he has #}}} other {none}}',
    "{N, plural, one {it's one} other {#}}",
    'Hello {NAME}',
    'Plain text with no arguments',
  ];

  it.each(samples)('slicing every node of %j reproduces the original', (text) => {
    const { nodes } = parseOk(text);
    const rebuild = (ns: ReturnType<typeof parseOk>['nodes']): string =>
      ns.map((n) => text.slice(n.span.start, n.span.end)).join('');
    expect(rebuild(nodes)).toBe(text);
  });

  it('branch bodies tile their argument without gaps', () => {
    const arg = selectArguments(parseOk(PLURAL).nodes)[0] as SelectNode;
    for (const branch of arg.branches) {
      expect(branch.bodyInnerSpan.start).toBeGreaterThan(branch.selectorSpan.end);
      expect(branch.bodyInnerSpan.end).toBeLessThan(arg.span.end);
    }
  });
});
