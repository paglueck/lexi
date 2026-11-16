// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { MdBlock, MdSpan, MdSpanStyle, MdTableAlign } from '@lexi/shared';

/**
 * The Markdown a style guide is written in, parsed into the block tree S6's
 * preview renders (FR-5.4).
 *
 * WHY THIS EXISTS AT ALL, rather than a dependency that emits HTML: the output
 * of this function is rendered by an Angular template through interpolation,
 * and a span can hold nothing but text. So there is no sanitizer in the path,
 * no `[innerHTML]`, and no question about what a style guide pasted out of a
 * wiki might contain — the worst it can do is look like angle brackets.
 *
 * That also fixes the scope. This is not a Markdown implementation; it is the
 * subset a style guide is written in — headings, paragraphs, quotes, lists,
 * fences, rules, tables, and four kinds of inline run. **Everything it does
 * not recognise stays literal text**, which is the correct behaviour for a
 * document whose entire purpose is to be injected verbatim into a prompt
 * (FR-5.3). Being lenient here costs a reader nothing; being clever could cost
 * them a guide that renders differently from the one the model is sent.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const NUMBER = /^[ \t]*\d{1,9}[.)][ \t]+(.*)$/;
/**
 * A GFM-style delimiter row: `| --- | :---: | ---: |`, pipes and leading /
 * trailing ones optional. Matched only together with `.includes('|')` (see
 * `looksLikeTableStart`) — on its own this also matches a bare `---` rule,
 * since every pipe in it is optional.
 */
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const span = (text: string, style: MdSpanStyle = 'plain', href: string | null = null): MdSpan => ({
  text,
  style,
  href,
});

/** Every block carries every field, so the view never has to narrow a union. */
const block = (kind: MdBlock['kind'], over: Partial<MdBlock> = {}): MdBlock => ({
  kind,
  level: 0,
  ordered: false,
  lang: '',
  lines: [],
  cells: [],
  align: [],
  ...over,
});

/**
 * `line` is a table header only together with the row after it: a lone pipe
 * in running prose must not turn the rest of the paragraph into a table.
 */
const looksLikeTableStart = (lines: readonly string[], i: number): boolean => {
  const line = lines[i] ?? '';
  const next = lines[i + 1] ?? '';
  return line.includes('|') && next.includes('|') && TABLE_DELIM.test(next);
};

/** A line that would start a different block, so a paragraph must stop here. */
const startsBlock = (lines: readonly string[], i: number): boolean => {
  const line = lines[i] ?? '';
  return (
    line.trim() === '' ||
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line) ||
    looksLikeTableStart(lines, i)
  );
};

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      // An unterminated fence closes at end of input. Refusing it would lose
      // the text; a reader can see the missing fence perfectly well.
      while (i < lines.length && !closesFence(lines[i] ?? '', marker)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(block('code', { lang: fence[2] ?? '', lines: [[span(body.join('\n'))]] }));
      continue;
    }

    // Before the list check: `---` is a rule, not a bullet with no content.
    if (RULE.test(line)) {
      blocks.push(block('rule'));
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const content = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '');
      blocks.push(
        block('heading', { level: (heading[1] ?? '#').length, lines: [inline(content)] }),
      );
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i] ?? '');
        if (quoted === null) break;
        inner.push(quoted[1] ?? '');
        i += 1;
      }
      blocks.push(block('quote', { lines: paragraphs(inner).map(inline) }));
      continue;
    }

    const ordered = NUMBER.test(line);
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? NUMBER : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const item = marker.exec(lines[i] ?? '');
        if (item !== null) {
          items.push(item[1] ?? '');
          i += 1;
          continue;
        }
        // A wrapped item continues the previous one; anything else ends the list.
        if (items.length > 0 && !startsBlock(lines, i)) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${(lines[i] ?? '').trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push(block('list', { ordered, lines: items.map(inline) }));
      continue;
    }

    if (looksLikeTableStart(lines, i)) {
      const header = splitTableRow(line).map(inline);
      const align = alignmentsOf(splitTableRow(lines[i + 1] ?? ''));
      i += 2;
      const rows: MdSpan[][][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitTableRow(lines[i] ?? '').map(inline));
        i += 1;
      }
      blocks.push(block('table', { cells: [header, ...rows], align }));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !startsBlock(lines, i)) {
      para.push((lines[i] ?? '').trim());
      i += 1;
    }
    blocks.push(block('para', { lines: [inline(para.join(' '))] }));
  }

  return blocks;
}

/**
 * One table row into its cell texts, on unescaped `|`.
 *
 * Leading and trailing pipes are the usual style (`| a | b |`) but optional
 * (`a | b`), matching how lenient the rest of this parser is. **Known gap**:
 * a pipe inside a backtick code span (`` `a|b` ``) still splits the cell —
 * tracking fence state mid-row is more machinery than a style-guide table is
 * ever likely to need.
 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let cur = '';
  for (let idx = 0; idx < s.length; idx += 1) {
    const ch = s[idx];
    if (ch === '\\' && s[idx + 1] === '|') {
      cur += '|';
      idx += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** `:---` left, `---:` right, `:---:` centre, `---` none — per delimiter cell. */
function alignmentsOf(delimiterCells: readonly string[]): MdTableAlign[] {
  return delimiterCells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return 'none';
  });
}

/** A closing fence is at least as long as the opener and made of the same char. */
function closesFence(line: string, marker: string): boolean {
  const close = FENCE.exec(line);
  if (close === null) return false;
  const run = close[1] ?? '';
  return run[0] === marker[0] && run.length >= marker.length && (close[2] ?? '') === '';
}

/** Split quoted lines into paragraphs on blanks, joining wraps with a space. */
function paragraphs(lines: readonly string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) out.push(current.join(' '));
      current = [];
    } else current.push(line.trim());
  }
  if (current.length > 0) out.push(current.join(' '));
  return out;
}

/**
 * Inline runs.
 *
 * The underscore rules carry the lookarounds that matter here more than in most
 * documents: `START_TAG_SPAN` and `INTERPOLATION_1` are this product's own
 * vocabulary, and a naive `_…_` rule renders half of every placeholder note in
 * italics with the underscores eaten.
 */
const INLINE = new RegExp(
  [
    String.raw`\\([\\\`*_\[\]()#>~+-])`, //                          1 escaped literal
    String.raw`(\`+)([\s\S]*?)\2`, //                                2 run, 3 code
    String.raw`(?<![A-Za-z0-9])\*\*(?!\s)([\s\S]+?)\*\*`, //         4 strong
    String.raw`(?<![A-Za-z0-9_])__(?!\s)([\s\S]+?)__(?![A-Za-z0-9_])`, // 5 strong
    String.raw`(?<![A-Za-z0-9])\*(?!\s)([^*\n]+?)\*`, //             6 em
    String.raw`(?<![A-Za-z0-9_])_(?!\s)([^_\n]+?)_(?![A-Za-z0-9_])`, // 7 em
    String.raw`\[([^\]\n]*)\]\(([^()\s]*)\)`, //                     8 text, 9 href
  ].join('|'),
  'g',
);

function inline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let last = 0;

  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m !== null; m = INLINE.exec(text)) {
    if (m.index > last) spans.push(span(text.slice(last, m.index)));
    last = m.index + m[0].length;

    if (m[1] !== undefined) spans.push(span(m[1]));
    else if (m[3] !== undefined) spans.push(span(m[3], 'code'));
    else if (m[4] !== undefined) spans.push(span(m[4], 'strong'));
    else if (m[5] !== undefined) spans.push(span(m[5], 'strong'));
    else if (m[6] !== undefined) spans.push(span(m[6], 'em'));
    else if (m[7] !== undefined) spans.push(span(m[7], 'em'));
    else if (m[8] !== undefined) spans.push(span(m[8], 'plain', safeHref(m[9] ?? '')));
  }

  if (last < text.length) spans.push(span(text.slice(last)));
  return spans.length > 0 ? spans : [span('')];
}

/**
 * Which hrefs may reach an `<a>`.
 *
 * Angular sanitizes an `[href]` binding on its own, so this is the second
 * layer rather than the only one — but a style guide is a document the user
 * pasted, `javascript:` is the one scheme that turns a link into code, and a
 * refusal that keeps the LINK TEXT loses the reader nothing.
 */
function safeHref(href: string): string | null {
  if (href === '' || href.startsWith('//')) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
  if (scheme === null) return href;
  const name = (scheme[1] ?? '').toLowerCase();
  return name === 'http' || name === 'https' || name === 'mailto' ? href : null;
}
