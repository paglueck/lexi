// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  editedText,
  segmentsOf,
  type PlaceholderSegment,
  type Segment,
  type Span,
} from '@lexi/xliff';
import { GRID_TEXT_LIMIT, type EditSegmentDto, type SegmentDto } from '@lexi/shared';

/**
 * Engine segments -> wire segments.
 *
 * The one thing this function exists to do is DROP `raw` and `span`. The engine
 * carries a placeholder's exact original bytes so that attribute order, quote
 * characters and `&lt;` versus `&#60;` all survive a round trip; those bytes are
 * meaningless in a browser and actively dangerous to send, because anything that
 * travels to the client and back has been through a decode/encode cycle, and
 * `escape(decode(x)) !== x` in general.
 *
 * The client therefore gets semantics only — ids, labels, text. When M6 writes
 * an edited target back, the server re-attaches `raw` by looking each
 * placeholder up by id in the unit it belongs to.
 */
export function toWireSegments(
  segments: readonly Segment[],
  limit: number | undefined = undefined,
): SegmentDto[] {
  const out: SegmentDto[] = [];
  for (const s of segments) {
    if (s.k === 't') {
      if (limit !== undefined && s.v.length > limit) {
        out.push({ k: 't', v: s.v.slice(0, limit), clipped: true });
      } else {
        out.push({ k: 't', v: s.v });
      }
      continue;
    }
    if (s.k === 'p') {
      out.push({
        k: 'p',
        id: s.id,
        // The chip's label. Angular always writes equiv-text, but a hand-edited
        // file may not, and a chip with no label is unreadable.
        ...(s.equivText === undefined ? {} : { equivText: s.equivText }),
        ...(s.ctype === undefined ? {} : { ctype: s.ctype }),
      });
      continue;
    }
    out.push({ k: 'g', id: s.id, children: toWireSegments(s.children, limit) });
  }
  return out;
}

/** Grid cells: clipped at GRID_TEXT_LIMIT, because the row is one ellipsised line. */
/**
 * Wire segments minus the display echoes — the shape `.lexi/` files store and
 * the edit schema accepts.
 *
 * `equivText` and `ctype` are re-derived from the file's own bytes on the way
 * out, so persisting them would let a round trip through a JSON file decide
 * what a placeholder looks like. `clipped` must never survive at all: it marks
 * a run the grid truncated.
 */
export const toEditSegments = (segments: readonly Segment[]): EditSegmentDto[] =>
  toWireSegments(segments).map(function strip(s): EditSegmentDto {
    if (s.k === 't') return { k: 't', v: s.v };
    if (s.k === 'p') return { k: 'p', id: s.id };
    return { k: 'g', id: s.id, children: s.children.map(strip) };
  });

export const gridSegments = (raw: string, innerSpan: Span): SegmentDto[] =>
  toWireSegments(segmentsOf(raw, innerSpan), GRID_TEXT_LIMIT);

/** Detail panel: never clipped. */
export const fullSegments = (raw: string, innerSpan: Span): SegmentDto[] =>
  toWireSegments(segmentsOf(raw, innerSpan));

/* ---- the other direction (M6) -------------------------------------------- */

/**
 * The placeholder bytes a unit is allowed to use.
 *
 * Built from the unit's OWN `<source>`, not from the project's source unit.
 * That is what makes an orphan editable: every `<trans-unit>` carries its own
 * `<source>`, because Angular writes the source text into each translation
 * file, so a unit whose id has vanished from the template can still be worked
 * on. The existing target is folded in too, so a placeholder already sitting in
 * a target the user did not touch survives a round trip instead of being
 * refused.
 */
export interface PlaceholderVocabulary {
  readonly chips: ReadonlyMap<string, PlaceholderSegment>;
  /** Separate, because a `<g>` contributes TWO byte strings under ONE id. */
  readonly groups: ReadonlyMap<string, { openRaw: string; closeRaw: string }>;
}

const collect = (
  segments: readonly Segment[],
  chips: Map<string, PlaceholderSegment>,
  groups: Map<string, { openRaw: string; closeRaw: string }>,
): void => {
  for (const s of segments) {
    if (s.k === 'p') {
      // First wins. Two placeholders sharing an id carry identical bytes in
      // every file Angular writes; if a hand-edited file ever disagrees, the
      // first occurrence is the one the source presents.
      if (!chips.has(s.id)) chips.set(s.id, s);
    } else if (s.k === 'g') {
      if (!groups.has(s.id)) groups.set(s.id, { openRaw: s.openRaw, closeRaw: s.closeRaw });
      collect(s.children, chips, groups);
    }
  }
};

export function vocabularyOf(raw: string, source: Span, target?: Span): PlaceholderVocabulary {
  const chips = new Map<string, PlaceholderSegment>();
  const groups = new Map<string, { openRaw: string; closeRaw: string }>();
  collect(segmentsOf(raw, source), chips, groups);
  if (target !== undefined) collect(segmentsOf(raw, target), chips, groups);
  return { chips, groups };
}

export class UnknownPlaceholderError extends Error {
  constructor(readonly id: string) {
    super(
      `This unit has no placeholder "${id}". The editor may only move the placeholders the ` +
        `string already has; it can never invent one.`,
    );
    this.name = 'UnknownPlaceholderError';
  }
}

/**
 * Wire segments -> engine segments, re-attaching the original bytes.
 *
 * The client sends ids and text and never a byte of the file (see the doc
 * comment above, and `packages/shared/src/units.ts`). This is where the bytes
 * come back: each placeholder id is looked up in the unit it belongs to and its
 * exact original tag text is restored, so attribute order, quote characters and
 * `&lt;` versus `&#60;` all survive an edit that merely moved the chip.
 *
 * Text becomes `editedText`, which carries NO `raw` and is therefore re-escaped
 * on the way out. That is correct: it is the one part the user really did change.
 *
 * An unknown id throws rather than fabricating a tag. There is no `<x/>`
 * serializer in the engine, by design — inventing one here would be the single
 * most effective way to lose round-trip fidelity.
 */
export function rebuildSegments(
  wire: readonly EditSegmentDto[],
  vocabulary: PlaceholderVocabulary,
): Segment[] {
  const out: Segment[] = [];
  for (const s of wire) {
    if (s.k === 't') {
      if (s.v !== '') out.push(editedText(s.v));
      continue;
    }
    if (s.k === 'p') {
      const chip = vocabulary.chips.get(s.id);
      if (chip === undefined) throw new UnknownPlaceholderError(s.id);
      // Drop the span: these bytes are being re-placed, not left where they were.
      out.push({
        k: 'p',
        raw: chip.raw,
        id: chip.id,
        ...(chip.ctype === undefined ? {} : { ctype: chip.ctype }),
        ...(chip.equivText === undefined ? {} : { equivText: chip.equivText }),
      });
      continue;
    }
    const group = vocabulary.groups.get(s.id);
    if (group === undefined) throw new UnknownPlaceholderError(s.id);
    out.push({
      k: 'g',
      id: s.id,
      openRaw: group.openRaw,
      closeRaw: group.closeRaw,
      children: rebuildSegments(s.children, vocabulary),
    });
  }
  return out;
}
