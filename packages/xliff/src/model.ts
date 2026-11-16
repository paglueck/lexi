// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A UTF-16 code-unit index into the raw document text.
 *
 * Never a byte offset. The two differ for any non-BMP character, and mixing them
 * is the kind of mistake that survives every test written against ASCII fixtures.
 */
export type CharOffset = number;

/**
 * A half-open range `[start, end)` into the raw document text.
 *
 * Invariant: `raw.slice(span.start, span.end)` is the exact original text of whatever
 * the span describes. htmlparser2 reports an *inclusive* `endIndex`, so every span
 * built from it is `{ start: parser.startIndex, end: parser.endIndex + 1 }`.
 */
export interface Span {
  readonly start: CharOffset;
  readonly end: CharOffset;
}

export const spanLength = (span: Span): number => span.end - span.start;

export const isEmptySpan = (span: Span): boolean => span.end === span.start;

export const sliceSpan = (raw: string, span: Span): string => raw.slice(span.start, span.end);
