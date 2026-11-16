// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseAttrSpans } from '../src/attrspans.js';
import { sliceSpan } from '../src/model.js';

/** Parse a standalone open tag; the tag occupies the whole string. */
const attrsOf = (tag: string) => parseAttrSpans(tag, { start: 0, end: tag.length });

describe('parseAttrSpans', () => {
  it('finds a double-quoted attribute value', () => {
    const tag = '<target state="translated">';
    const attrs = attrsOf(tag);
    expect(sliceSpan(tag, attrs.get('state')!.valueSpan)).toBe('translated');
  });

  it('finds a single-quoted attribute value', () => {
    const tag = "<target state='new'>";
    expect(sliceSpan(tag, attrsOf(tag).get('state')!.valueSpan)).toBe('new');
  });

  it('records the quote character actually used', () => {
    expect(attrsOf(`<a b='c'>`).get('b')!.quote).toBe("'");
    expect(attrsOf(`<a b="c">`).get('b')!.quote).toBe('"');
  });

  it('spans the whole attribute including its leading whitespace', () => {
    const tag = '<file source-language="en" datatype="plaintext">';
    const attr = attrsOf(tag).get('datatype')!;
    expect(sliceSpan(tag, attr.span)).toBe(' datatype="plaintext"');
  });

  it('reads several attributes in order', () => {
    const tag = '<file source-language="en-GB" datatype="plaintext" original="ng2.template">';
    expect([...attrsOf(tag).keys()]).toEqual(['source-language', 'datatype', 'original']);
  });

  it('handles a namespaced attribute name', () => {
    const tag = '<source xml:space="preserve">';
    expect(sliceSpan(tag, attrsOf(tag).get('xml:space')!.valueSpan)).toBe('preserve');
  });

  it('handles a self-closing tag', () => {
    const tag = '<x id="INTERPOLATION" equiv-text="{{ n }}"/>';
    const attrs = attrsOf(tag);
    expect(sliceSpan(tag, attrs.get('equiv-text')!.valueSpan)).toBe('{{ n }}');
  });

  it('does not treat > inside a quoted value as the end of the tag', () => {
    const tag = '<x equiv-text="&lt;b&gt;" id="A"/>';
    const attrs = attrsOf(tag);
    expect(sliceSpan(tag, attrs.get('equiv-text')!.valueSpan)).toBe('&lt;b&gt;');
    expect(sliceSpan(tag, attrs.get('id')!.valueSpan)).toBe('A');
  });

  it('returns the raw, still-escaped value — decoding is the caller\'s business', () => {
    const tag = `<note from="a&amp;b">`;
    expect(sliceSpan(tag, attrsOf(tag).get('from')!.valueSpan)).toBe('a&amp;b');
  });

  it('tolerates irregular whitespace around the equals sign', () => {
    const tag = '<a  b = "c"   d="e" >';
    const attrs = attrsOf(tag);
    expect(sliceSpan(tag, attrs.get('b')!.valueSpan)).toBe('c');
    expect(sliceSpan(tag, attrs.get('d')!.valueSpan)).toBe('e');
  });

  it('reports no attributes for a bare tag', () => {
    expect(attrsOf('<body>').size).toBe(0);
    expect(attrsOf('<body/>').size).toBe(0);
  });

  it('reports where a new attribute should be inserted: right after the tag name', () => {
    const tag = '<target>';
    expect(attrsOf(tag).insertionPoint).toBe('<target'.length);
  });

  it('reports the same insertion point when attributes already exist', () => {
    const tag = '<target state="new">';
    expect(attrsOf(tag).insertionPoint).toBe('<target'.length);
  });

  it('works on a tag embedded in a larger document', () => {
    const raw = `  <target state="new">hello</target>\n`;
    const tagSpan = { start: 2, end: 2 + '<target state="new">'.length };
    const attrs = parseAttrSpans(raw, tagSpan);
    expect(sliceSpan(raw, attrs.get('state')!.valueSpan)).toBe('new');
    expect(attrs.insertionPoint).toBe(2 + '<target'.length);
  });
});
