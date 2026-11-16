// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Markdown the style guide preview renders (FR-5.4).
 *
 * The load-bearing case is the last describe block. This parser exists instead
 * of an HTML renderer precisely so that a guide someone pasted out of a wiki
 * cannot become markup, and the only way that promise is worth anything is if
 * a test asserts it from the adversarial side.
 */
import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '../src/services/markdown.js';
import type { MdBlock, MdSpan } from '@lexi/shared';

/** Flatten a block back to its visible text — what a reader would see. */
const textOf = (block: MdBlock): string =>
  block.lines.map((line) => line.map((s) => s.text).join('')).join('\n');

const kinds = (blocks: readonly MdBlock[]): string[] => blocks.map((b) => b.kind);

const spansOf = (block: MdBlock): MdSpan[] => block.lines.flat();

describe('block structure', () => {
  it('reads ATX headings with their level', () => {
    const blocks = parseMarkdown('# Global style guide\n\n## Tone\n\n### Button labels');
    expect(kinds(blocks)).toEqual(['heading', 'heading', 'heading']);
    expect(blocks.map((b) => b.level)).toEqual([1, 2, 3]);
    expect(textOf(blocks[0]!)).toBe('Global style guide');
    expect(textOf(blocks[2]!)).toBe('Button labels');
  });

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    const blocks = parseMarkdown('One sentence\nwrapped over two lines.\n\nA second paragraph.');
    expect(kinds(blocks)).toEqual(['para', 'para']);
    expect(textOf(blocks[0]!)).toBe('One sentence wrapped over two lines.');
    expect(textOf(blocks[1]!)).toBe('A second paragraph.');
  });

  it('reads a blockquote as paragraphs, marker stripped', () => {
    const blocks = parseMarkdown(
      '> These rules extend and, where they conflict,\n> override the global style guide.\n>\n> Second quoted paragraph.',
    );
    expect(kinds(blocks)).toEqual(['quote']);
    expect(blocks[0]!.lines).toHaveLength(2);
    expect(textOf(blocks[0]!)).toBe(
      'These rules extend and, where they conflict, override the global style guide.\nSecond quoted paragraph.',
    );
  });

  it('reads bulleted and numbered lists, and tells them apart', () => {
    const blocks = parseMarkdown('- Button labels\n- Error messages\n\n1. First\n2. Second');
    expect(kinds(blocks)).toEqual(['list', 'list']);
    expect(blocks[0]!.ordered).toBe(false);
    expect(blocks[1]!.ordered).toBe(true);
    expect(blocks[0]!.lines).toHaveLength(2);
    expect(textOf(blocks[1]!)).toBe('First\nSecond');
  });

  it('reads a horizontal rule', () => {
    expect(kinds(parseMarkdown('a\n\n---\n\nb'))).toEqual(['para', 'rule', 'para']);
  });

  it('treats a fence as opaque, including the # and > inside it', () => {
    const blocks = parseMarkdown('```md\n# not a heading\n> not a quote\n- not a list\n```');
    expect(kinds(blocks)).toEqual(['code']);
    expect(blocks[0]!.lang).toBe('md');
    expect(textOf(blocks[0]!)).toBe('# not a heading\n> not a quote\n- not a list');
  });

  it('closes an unterminated fence at end of input rather than losing it', () => {
    const blocks = parseMarkdown('```\nstill code');
    expect(kinds(blocks)).toEqual(['code']);
    expect(textOf(blocks[0]!)).toBe('still code');
  });

  it('handles CRLF and a trailing newline the same as LF', () => {
    expect(kinds(parseMarkdown('# A\r\n\r\nbody\r\n'))).toEqual(['heading', 'para']);
  });

  it('renders an empty document as no blocks at all', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });
});

/** Flatten a table's cells back to their visible text, row by row. */
const cellsOf = (block: MdBlock): string[][] =>
  block.cells.map((row) => row.map((cell) => cell.map((s) => s.text).join('')));

describe('tables', () => {
  const GLOSSARY = [
    '| Source term | German | Do not translate |',
    '|---|---|---|',
    '| dashboard | Übersicht | no |',
    '| Workspace | Workspace | yes |',
  ].join('\n');

  it('reads a header row, the delimiter and the body rows', () => {
    const blocks = parseMarkdown(GLOSSARY);
    expect(kinds(blocks)).toEqual(['table']);
    expect(cellsOf(blocks[0]!)).toEqual([
      ['Source term', 'German', 'Do not translate'],
      ['dashboard', 'Übersicht', 'no'],
      ['Workspace', 'Workspace', 'yes'],
    ]);
  });

  it('reads column alignment from the delimiter row', () => {
    const blocks = parseMarkdown('| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |');
    expect(blocks[0]!.align).toEqual(['left', 'center', 'right']);
  });

  it('does not need leading or trailing pipes', () => {
    const blocks = parseMarkdown('a | b\n---|---\n1 | 2');
    expect(kinds(blocks)).toEqual(['table']);
    expect(cellsOf(blocks[0]!)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('renders inline styles inside a cell', () => {
    const blocks = parseMarkdown('| term |\n|---|\n| **bold** and `code` |');
    const styles = blocks[0]!.cells[1]![0]!.map((s) => s.style);
    expect(styles).toEqual(['strong', 'plain', 'code']);
  });

  it('un-escapes a literal pipe inside a cell', () => {
    const blocks = parseMarkdown('| term |\n|---|\n| a \\| b |');
    expect(cellsOf(blocks[0]!)).toEqual([['term'], ['a | b']]);
  });

  it('ends the table at the first blank line', () => {
    const blocks = parseMarkdown('| a |\n|---|\n| 1 |\n\nAfter the table.');
    expect(kinds(blocks)).toEqual(['table', 'para']);
    expect(blocks[0]!.cells).toHaveLength(2);
  });

  it('stops a preceding paragraph so it does not swallow the table', () => {
    const blocks = parseMarkdown('Some lead-in text.\n\n| a |\n|---|\n| 1 |');
    expect(kinds(blocks)).toEqual(['para', 'table']);
    expect(textOf(blocks[0]!)).toBe('Some lead-in text.');
  });

  it('does NOT treat a lone pipe in prose as a table', () => {
    const blocks = parseMarkdown('Choose plain | rich text depending on the field.');
    expect(kinds(blocks)).toEqual(['para']);
  });

  it('does NOT confuse a horizontal rule with a one-column table delimiter', () => {
    // A rule has no pipe at all, so the line before it must stay a paragraph.
    const blocks = parseMarkdown('A paragraph.\n\n---\n\nAnother.');
    expect(kinds(blocks)).toEqual(['para', 'rule', 'para']);
  });

  it('leaves cells and align empty on every other block kind', () => {
    const blocks = parseMarkdown('# Heading\n\nParagraph.');
    for (const b of blocks) {
      expect(b.cells).toEqual([]);
      expect(b.align).toEqual([]);
    }
  });
});

describe('inline spans', () => {
  const inline = (src: string): MdSpan[] => spansOf(parseMarkdown(src)[0]!);

  it('reads strong, emphasis and code', () => {
    const spans = inline('Always **formal**, never _casual_, and keep `Workspace`.');
    expect(spans.filter((s) => s.style === 'strong').map((s) => s.text)).toEqual(['formal']);
    expect(spans.filter((s) => s.style === 'em').map((s) => s.text)).toEqual(['casual']);
    expect(spans.filter((s) => s.style === 'code').map((s) => s.text)).toEqual(['Workspace']);
    expect(spans.map((s) => s.text).join('')).toBe(
      'Always formal, never casual, and keep Workspace.',
    );
  });

  it('does NOT read an underscore inside a word as emphasis', () => {
    // START_TAG_SPAN and INTERPOLATION_1 are the vocabulary of this product.
    // A naive _..._ rule turns every placeholder id into italics.
    const spans = inline('Reproduce START_TAG_SPAN and INTERPOLATION_1 exactly.');
    expect(spans.every((s) => s.style === 'plain')).toBe(true);
    expect(spans.map((s) => s.text).join('')).toBe(
      'Reproduce START_TAG_SPAN and INTERPOLATION_1 exactly.',
    );
  });

  it('reads a link and keeps its text', () => {
    const spans = inline('See [the handbook](https://example.test/style) first.');
    const link = spans.find((s) => s.href !== null);
    expect(link?.text).toBe('the handbook');
    expect(link?.href).toBe('https://example.test/style');
  });

  it('honours a backslash escape', () => {
    expect(
      inline('A literal \\*asterisk\\* stays.')
        .map((s) => s.text)
        .join(''),
    ).toBe('A literal *asterisk* stays.');
  });
});

describe('a style guide can never become markup', () => {
  it('keeps a script tag as visible text', () => {
    const blocks = parseMarkdown('Never translate <script>alert(1)</script> or anything in it.');
    expect(kinds(blocks)).toEqual(['para']);
    expect(textOf(blocks[0]!)).toBe('Never translate <script>alert(1)</script> or anything in it.');
    // every span is text; there is no field a tag could hide in
    expect(spansOf(blocks[0]!).every((s) => typeof s.text === 'string')).toBe(true);
  });

  it('keeps an img onerror payload as visible text', () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)">');
    expect(textOf(blocks[0]!)).toBe('<img src=x onerror="alert(1)">');
  });

  it('keeps raw HTML inside a heading and a list as text too', () => {
    const blocks = parseMarkdown('# <b>bold?</b>\n\n- <iframe src="evil"></iframe>');
    expect(textOf(blocks[0]!)).toBe('<b>bold?</b>');
    expect(textOf(blocks[1]!)).toBe('<iframe src="evil"></iframe>');
  });

  it('keeps raw HTML inside a table cell as text too', () => {
    const blocks = parseMarkdown('| term |\n|---|\n| <script>alert(1)</script> |');
    expect(blocks[0]!.cells[1]![0]!.map((s) => s.text).join('')).toBe('<script>alert(1)</script>');
  });

  it('refuses a javascript: link, keeping the text and dropping the href', () => {
    const spans = spansOf(parseMarkdown('[click](javascript:alert)')[0]!);
    expect(spans.map((s) => s.text).join('')).toBe('click');
    expect(spans.every((s) => s.href === null)).toBe(true);
  });

  it('allows the schemes a style guide legitimately links to', () => {
    for (const href of [
      'https://a.test/x',
      'http://a.test/x',
      'mailto:l10n@a.test',
      '/docs/style',
    ]) {
      const spans = spansOf(parseMarkdown(`[t](${href})`)[0]!);
      expect(spans.find((s) => s.href !== null)?.href).toBe(href);
    }
  });
});
