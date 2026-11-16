// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { composeSegments, type Segment } from './segments.js';
import { scan } from './scan.js';
import type { EscapePolicy } from './escape.js';

/**
 * Read a fragment back through the REAL scanner, as the inner content of a
 * `<target>`, and report the placeholder ids it turns out to carry.
 *
 * The point of routing through `scan` rather than asking the fragment parser
 * directly: the fragment parser is deliberately forgiving — it auto-closes an
 * element left open at the end of input — while the scanner is the thing that
 * will actually read the file afterwards. A `<g>` the writer never closed has
 * to be a refusal, not a repair.
 */
export function probeFragment(
  inner: string,
): { readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false; readonly error: string } {
  const probe =
    '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">' +
    '<file source-language="en" datatype="plaintext" original="ng2.template"><body>' +
    `<trans-unit id="probe"><source/><target>${inner}</target></trans-unit>` +
    '</body></file></xliff>';

  let unit;
  try {
    unit = scan(probe).files[0]?.units[0];
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (unit === undefined) return { ok: false, error: 'it could not be read back at all' };
  return { ok: true, ids: unit.targetPhIds ?? [] };
}

/**
 * Compose segments, put the bytes through the real reader, and check they come
 * back as the placeholders we expect.
 *
 * Generalised out of `mask.ts`, where it was the final gate on an LLM's output,
 * because M6's editor needs exactly the same proof about a human's. The point is
 * the same in both cases: **check through the actual writer and reader rather
 * than against a parallel belief about what they do.** Every individual token can
 * be present and unique while the bytes are still invalid XML — a `<g>` whose
 * open and close boundaries were reordered produces precisely that.
 *
 * Returns a description of the problem, or `undefined` when the bytes are safe
 * to commit. Microseconds.
 */
export function verifyComposable(
  segments: readonly Segment[],
  expectedIds: readonly string[],
  policy: EscapePolicy = 'angular',
): string | undefined {
  const read = probeFragment(composeSegments(segments, policy));
  if (!read.ok) return `The restored target is not well-formed XML: ${read.error}`;

  const actual = [...read.ids].sort();
  const expected = [...expectedIds].sort();
  if (actual.join(' ') !== expected.join(' ')) {
    return `The restored target reads back as [${actual.join(', ')}] instead of [${expected.join(', ')}].`;
  }
  return undefined;
}
