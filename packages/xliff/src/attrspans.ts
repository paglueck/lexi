// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CharOffset, Span } from './model.js';

/**
 * Where one attribute sits inside an open tag.
 *
 * `valueSpan` covers the value *between* the quotes and is still escaped exactly
 * as the file has it — decoding is the caller's business, and anything written
 * back should be spliced over this span rather than regenerated.
 */
export interface AttrSpan {
  readonly name: string;
  /** The whole attribute, including the whitespace that separates it from the previous one. */
  readonly span: Span;
  readonly nameSpan: Span;
  readonly valueSpan: Span;
  readonly quote: '"' | "'";
}

export interface AttrSpans extends ReadonlyMap<string, AttrSpan> {
  /** Offset just past the tag name, where a new attribute is inserted. */
  readonly insertionPoint: CharOffset;
}

const isSpace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13;

/** A name character: anything that is not whitespace, `=`, `/`, `>` or a quote. */
const isNameChar = (code: number): boolean =>
  !isSpace(code) && code !== 61 && code !== 47 && code !== 62 && code !== 34 && code !== 39;

/**
 * Parse the attributes of a single, already-delimited open tag.
 *
 * htmlparser2 reports attribute *values* but no offsets for them, and two edits we
 * need are surgical: correcting a stale `target-language` (FR-1.2b) and setting
 * `state` on a `<target>`. Hand-rolling is right here because the input is tiny,
 * already bounded by the scanner, and the grammar inside an open tag is trivial —
 * the hazards that make hand-written XML parsing a bad idea all live outside it.
 */
export function parseAttrSpans(raw: string, tagSpan: Span): AttrSpans {
  const map = new Map<string, AttrSpan>();
  let i = tagSpan.start + 1; // skip '<'

  while (i < tagSpan.end && isNameChar(raw.charCodeAt(i))) i++;
  const insertionPoint = i;

  while (i < tagSpan.end) {
    while (i < tagSpan.end && isSpace(raw.charCodeAt(i))) i++;
    if (i >= tagSpan.end) break;

    const code = raw.charCodeAt(i);
    if (code === 62 || code === 47) break; // '>' or '/>'
    if (!isNameChar(code)) { i++; continue; }

    const attrStart = i;
    const nameStart = i;
    while (i < tagSpan.end && isNameChar(raw.charCodeAt(i))) i++;
    const nameEnd = i;

    while (i < tagSpan.end && isSpace(raw.charCodeAt(i))) i++;
    if (i >= tagSpan.end || raw.charCodeAt(i) !== 61) {
      // A valueless attribute. XML does not allow it, but do not lose our place.
      continue;
    }
    i++; // skip '='
    while (i < tagSpan.end && isSpace(raw.charCodeAt(i))) i++;

    const quoteCode = raw.charCodeAt(i);
    if (quoteCode !== 34 && quoteCode !== 39) continue;
    const quote = quoteCode === 34 ? '"' : "'";
    i++;
    const valueStart = i;
    while (i < tagSpan.end && raw.charCodeAt(i) !== quoteCode) i++;
    const valueEnd = i;
    i++; // skip the closing quote

    const name = raw.slice(nameStart, nameEnd);
    // Leading whitespace belongs to the attribute, so removing one leaves no gap.
    let spanStart = attrStart;
    while (spanStart > tagSpan.start + 1 && isSpace(raw.charCodeAt(spanStart - 1))) spanStart--;

    if (!map.has(name)) {
      map.set(name, {
        name,
        span: { start: spanStart, end: i },
        nameSpan: { start: nameStart, end: nameEnd },
        valueSpan: { start: valueStart, end: valueEnd },
        quote,
      });
    }
  }

  return Object.assign(map, { insertionPoint }) as AttrSpans;
}
