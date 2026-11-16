// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Span } from './model.js';

/**
 * A single replacement of one span of the original document text.
 *
 * A zero-width span (`start === end`) is an insertion at that point.
 * An empty `replacement` is a deletion.
 */
export interface Edit {
  readonly span: Span;
  readonly replacement: string;
  /** Human-readable origin, surfaced in error messages. Not part of the semantics. */
  readonly reason: string;
}

const describe = (edit: Edit): string =>
  `[${edit.span.start},${edit.span.end}) "${edit.reason}"`;

/**
 * Apply edits to the original document text by copying everything they do not cover.
 *
 * This is the single primitive the whole write path is built on, and the reason
 * round-trip fidelity (NFR-5) is a property of the design rather than something
 * tests have to defend: `applyEdits(raw, [])` reduces to `raw`, so a document with
 * no edits cannot serialize to anything but itself.
 *
 * Overlapping edits throw rather than interleave. Two code paths both trying to
 * rewrite the same target must fail loudly — silently producing one of two possible
 * outputs is how a writer stops being trustworthy.
 */
export function applyEdits(raw: string, edits: readonly Edit[]): string {
  if (edits.length === 0) return raw;

  const sorted = [...edits].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);

  const out: string[] = [];
  let cursor = 0;
  let previous: Edit | undefined;

  for (const edit of sorted) {
    const { start, end } = edit.span;

    if (end < start) {
      throw new Error(`inverted span: ${describe(edit)}`);
    }
    if (start < 0 || end > raw.length) {
      throw new Error(`span out of bounds (document length ${raw.length}): ${describe(edit)}`);
    }
    if (start < cursor) {
      throw new Error(`overlapping edits: ${describe(previous!)} and ${describe(edit)}`);
    }
    // Two insertions at the same offset touch rather than overlap, but their relative
    // order would decide the output, so refuse them too.
    if (previous && start === cursor && start === end && previous.span.start === previous.span.end) {
      throw new Error(`overlapping edits (ambiguous insertion order): ${describe(previous)} and ${describe(edit)}`);
    }

    out.push(raw.slice(cursor, start), edit.replacement);
    cursor = end;
    previous = edit;
  }

  out.push(raw.slice(cursor));
  return out.join('');
}
