// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Parser } from 'htmlparser2';
import type { Span } from './model.js';
import { escapeText, type EscapePolicy } from './escape.js';

/** Element names Angular uses for an atomic placeholder inside translatable content. */
const PLACEHOLDER_TAGS = new Set(['x', 'bx', 'ex', 'ph']);

export interface TextSegment {
  readonly k: 't';
  /** Span in the original document. Absent for text that did not come from a file. */
  readonly span?: Span;
  /** Decoded text. */
  readonly v: string;
  /**
   * The original escaped bytes, when this text came from a file and is unchanged.
   *
   * Carried on the segment rather than looked up through the span at compose time,
   * so composing cannot be called in a way that silently re-escapes untouched text.
   * Any change to `v` must drop `raw` — use `editedText`.
   */
  readonly raw?: string;
}

/** Replace a text segment's content, dropping the original bytes so it is re-escaped. */
export const editedText = (v: string): TextSegment => ({ k: 't', v });

export interface PlaceholderSegment {
  readonly k: 'p';
  readonly span?: Span;
  /**
   * The exact original tag text.
   *
   * There is no placeholder serializer in this package. Attribute order, quote
   * characters, whitespace inside the tag and whether `equiv-text` was written as
   * `&lt;span&gt;` or `&#60;span&#62;` all survive because these bytes are copied,
   * never regenerated. When a translator moves a chip, `raw` travels with it.
   */
  readonly raw: string;
  readonly id: string;
  readonly ctype?: string;
  readonly equivText?: string;
}

export interface GroupSegment {
  readonly k: 'g';
  readonly span?: Span;
  readonly openRaw: string;
  readonly closeRaw: string;
  readonly id: string;
  readonly children: readonly Segment[];
}

export type Segment = TextSegment | PlaceholderSegment | GroupSegment;

/**
 * Decompose the inner XML of a `<source>` or `<target>` into segments.
 *
 * Deliberately computed on demand rather than during the main scan: at twenty
 * locales by twenty thousand units, eager segment arrays would run to hundreds of
 * megabytes, and the grid never needs them — it needs the plain text and the
 * placeholder ids, which the scan already produces.
 */
export function segmentsOf(raw: string, innerSpan: Span): Segment[] {
  const fragment = raw.slice(innerSpan.start, innerSpan.end);
  if (fragment === '') return [];
  return parseFragment(fragment, innerSpan.start);
}

/** Decompose a standalone fragment, e.g. content that never came from a file. */
export const segmentsOfFragment = (fragment: string): Segment[] => parseFragment(fragment, 0);

interface Frame {
  readonly openRaw: string;
  readonly id: string;
  readonly start: number;
  readonly children: Segment[];
}

function parseFragment(fragment: string, offset: number): Segment[] {
  const root: Segment[] = [];
  const stack: Frame[] = [];
  const current = (): Segment[] => (stack.length === 0 ? root : stack[stack.length - 1]!.children);

  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        const tagText = fragment.slice(start, end);

        if (PLACEHOLDER_TAGS.has(name)) {
          current().push({
            k: 'p',
            span: { start: offset + start, end: offset + end },
            raw: tagText,
            id: attribs['id'] ?? '',
            ...(attribs['ctype'] === undefined ? {} : { ctype: attribs['ctype'] }),
            ...(attribs['equiv-text'] === undefined ? {} : { equivText: attribs['equiv-text'] }),
          });
          return;
        }

        stack.push({ openRaw: tagText, id: attribs['id'] ?? '', start, children: [] });
      },

      ontext(text) {
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        const into = current();
        const previous = into[into.length - 1];
        // htmlparser2 splits a logical text run around entities and CDATA.
        if (previous?.k === 't' && previous.span?.end === offset + start) {
          into[into.length - 1] = {
            k: 't',
            span: { start: previous.span.start, end: offset + end },
            v: previous.v + text,
            raw: (previous.raw ?? '') + fragment.slice(start, end),
          };
        } else {
          into.push({
            k: 't',
            span: { start: offset + start, end: offset + end },
            v: text,
            raw: fragment.slice(start, end),
          });
        }
      },

      onclosetag(name) {
        if (PLACEHOLDER_TAGS.has(name)) return; // already emitted on open
        const frame = stack.pop();
        if (!frame) return;
        const end = parser.endIndex + 1;
        current().push({
          k: 'g',
          span: { start: offset + frame.start, end: offset + end },
          openRaw: frame.openRaw,
          closeRaw: fragment.slice(parser.startIndex, end),
          id: frame.id,
          children: frame.children,
        });
      },
    },
    { xmlMode: true },
  );

  parser.write(fragment);
  parser.end();
  return root;
}

/**
 * Serialize segments back to inner XML.
 *
 * Text that still matches its original span is copied byte for byte; only text
 * that was actually edited is re-escaped. That distinction matters because
 * `escape(decode(x))` does not generally equal `x` — `&#39;` decodes to `'` and
 * re-encodes to `&apos;` — so re-escaping untouched text would rewrite parts of
 * the file nobody changed.
 */
export function composeSegments(segments: readonly Segment[], policy: EscapePolicy): string {
  let out = '';
  for (const segment of segments) {
    switch (segment.k) {
      case 't':
        out += segment.raw ?? escapeText(segment.v, policy);
        break;
      case 'p':
        out += segment.raw;
        break;
      case 'g':
        out += segment.openRaw + composeSegments(segment.children, policy) + segment.closeRaw;
        break;
    }
  }
  return out;
}

/** Placeholder ids in document order, descending into groups. The input to FR-PH-2. */
export function placeholderIds(segments: readonly Segment[], into: string[] = []): string[] {
  for (const segment of segments) {
    if (segment.k === 'p') into.push(segment.id);
    else if (segment.k === 'g') placeholderIds(segment.children, into);
  }
  return into;
}

/** Readable text with each placeholder rendered as its `equiv-text`, falling back to its id. */
export function plainText(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.k === 't') out += segment.v;
    else if (segment.k === 'p') out += segment.equivText ?? segment.id;
    else out += plainText(segment.children);
  }
  return out;
}

/** Text with placeholders dropped entirely. Used by length and punctuation checks. */
export function textOnly(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.k === 't') out += segment.v;
    else if (segment.k === 'g') out += textOnly(segment.children);
  }
  return out;
}
