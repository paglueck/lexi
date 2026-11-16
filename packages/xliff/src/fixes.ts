// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { editedText, placeholderIds, plainText, type PlaceholderSegment, type Segment } from './segments.js';
import { validateSegments, type Finding, type ValidateContext } from './validate.js';

export const FIX_KINDS = ['whitespace', 'rename', 'insert-edge'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/**
 * A repair that can be applied without asking anyone to choose.
 *
 * `segments` is the whole patched target. `changed` holds the top-level indices
 * in it that the fix produced, so a preview can mark exactly those.
 */
export interface Fix {
  readonly kind: FixKind;
  readonly segments: readonly Segment[];
  readonly changed: readonly number[];
  /** One sentence for the reviewer: what the fix does and why it is safe. */
  readonly explanation: string;
  /** Where the fix got its answer from, e.g. "from source tag pairing". */
  readonly origin: string;
}

/** Text that carries no words: whitespace and punctuation only. */
const INERT = /^[\s\p{P}]*$/u;
const INERT_TAIL = /[\s\p{P}]*$/u;
const INERT_HEAD = /^[\s\p{P}]*/u;

const leading = (text: string): string => /^\s*/.exec(text)?.[0] ?? '';
const trailing = (text: string): string => /\s*$/.exec(text)?.[0] ?? '';

/**
 * A deterministic fix for one finding, or `null`.
 *
 * Only three cases qualify, because only these have exactly one right answer:
 *
 * - `whitespace.edges`: the source's leading and trailing whitespace is copied.
 * - one placeholder missing and one unexpected: the unexpected one is renamed.
 *   Its bytes come from the SOURCE, because there is no placeholder serializer.
 * - one placeholder missing that stands at the very start or end of the source:
 *   it goes to the same edge of the target.
 *
 * Anything else, such as a duplicated placeholder or one missing from the
 * middle of a sentence, needs a person to decide where it goes, so it gets
 * nothing.
 *
 * Every candidate is re-validated. A fix that leaves its own rule firing, or
 * raises a rule that was not firing before, is never offered.
 */
export function suggestFix(
  source: readonly Segment[],
  target: readonly Segment[],
  finding: Finding,
  ctx: ValidateContext,
): Fix | null {
  const candidate = candidateFor(source, target, finding);
  if (candidate === null) return null;

  const before = new Set(validateSegments(source, target, ctx).map((f) => f.rule));
  const after = validateSegments(source, candidate.segments, ctx);
  if (after.some((f) => f.rule === finding.rule || !before.has(f.rule))) return null;
  return candidate;
}

function candidateFor(source: readonly Segment[], target: readonly Segment[], finding: Finding): Fix | null {
  if (finding.rule === 'whitespace.edges') return fixWhitespace(source, target);
  if (finding.rule !== 'placeholder.mismatch' && finding.rule !== 'placeholder.pairing') return null;

  const { missing, unexpected } = finding.placeholders ?? { missing: [], unexpected: [] };
  if (missing.length !== 1) return null;
  const id = missing[0]!;
  const sourceSegment = uniquePlaceholder(source, id);
  if (sourceSegment === undefined) return null;
  if (placeholderIds(target).includes(id)) return null;

  if (unexpected.length === 1) return fixRename(target, unexpected[0]!, sourceSegment);
  if (unexpected.length === 0) return fixInsertAtEdge(source, target, sourceSegment);
  return null;
}

/** The one top-level placeholder with this id, or undefined if there are none or several. */
function uniquePlaceholder(segments: readonly Segment[], id: string): PlaceholderSegment | undefined {
  const found = segments.filter((s): s is PlaceholderSegment => s.k === 'p' && s.id === id);
  return found.length === 1 ? found[0] : undefined;
}

const labelOf = (s: PlaceholderSegment): string => s.equivText ?? s.id;

function fixWhitespace(source: readonly Segment[], target: readonly Segment[]): Fix | null {
  const sourceText = plainText(source);
  const lead = leading(sourceText);
  const trail = trailing(sourceText);
  const first = target[0];
  const last = target[target.length - 1];
  if (first === undefined || last === undefined) return null;
  if (first.k === 'g' || last.k === 'g') return null; // a group's inside is not ours to rewrite

  const body: Segment[] = [...target];
  const changed = new Set<number>();
  if (body.length === 1 && first.k === 't') {
    body[0] = editedText(lead + first.v.trim() + trail);
    changed.add(0);
  } else {
    if (first.k === 't') {
      body[0] = editedText(lead + first.v.replace(/^\s*/, ''));
      changed.add(0);
    }
    if (last.k === 't') {
      body[body.length - 1] = editedText(last.v.replace(/\s*$/, '') + trail);
      changed.add(body.length - 1);
    }
  }

  // A placeholder at an edge gets the whitespace as a text segment beside it.
  const prefix = first.k === 'p' && lead !== '' ? [editedText(lead)] : [];
  const suffix = last.k === 'p' && trail !== '' ? [editedText(trail)] : [];
  const out = [...prefix, ...body, ...suffix];
  const shifted = [...changed].map((i) => i + prefix.length);
  if (prefix.length > 0) shifted.push(0);
  if (suffix.length > 0) shifted.push(out.length - 1);

  return {
    kind: 'whitespace',
    segments: out,
    changed: shifted.sort((a, b) => a - b),
    explanation: 'Match the source’s leading and trailing whitespace, which a template may depend on when it concatenates.',
    origin: 'from source whitespace',
  };
}

function fixRename(target: readonly Segment[], unexpected: string, replacement: PlaceholderSegment): Fix | null {
  const index = target.findIndex((s) => s.k === 'p' && s.id === unexpected);
  if (index < 0) return null;
  if (target.filter((s) => s.k === 'p' && s.id === unexpected).length !== 1) return null;
  const out = [...target];
  out[index] = replacement;
  return {
    kind: 'rename',
    segments: out,
    changed: [index],
    explanation: `Rename ${unexpected} to ${replacement.id}: it is the only placeholder the source has and the translation lacks.`,
    origin: 'from source placeholder ids',
  };
}

function fixInsertAtEdge(source: readonly Segment[], target: readonly Segment[], missing: PlaceholderSegment): Fix | null {
  const at = source.indexOf(missing);
  const before = source.slice(0, at);
  const after = source.slice(at + 1);
  const inert = (segments: readonly Segment[]): boolean => segments.every((s) => s.k === 't' && INERT.test(s.v));
  const origin = missing.id.startsWith('CLOSE_') || missing.id.startsWith('START_') ? 'from source tag pairing' : 'from source position';

  if (inert(after)) {
    const tailInSource = after.length > 0 && plainText(after) !== '';
    const out = [...target];
    let index = out.length;
    const last = out[out.length - 1];
    if (tailInSource && last?.k === 't') {
      const tail = INERT_TAIL.exec(last.v)?.[0] ?? '';
      if (tail !== '' && tail !== last.v) {
        out.splice(out.length - 1, 1, editedText(last.v.slice(0, last.v.length - tail.length)), missing, editedText(tail));
        index = out.length - 2;
      } else {
        out.push(missing);
        index = out.length - 1;
      }
    } else {
      out.push(missing);
      index = out.length - 1;
    }
    const word = lastWord(out.slice(0, index));
    return {
      kind: 'insert-edge',
      segments: out,
      changed: [index],
      explanation:
        word === ''
          ? `Add ${labelOf(missing)} at the end, where the source has it.`
          : `Add ${labelOf(missing)} after “${word}”, mirroring the source, where it ends the phrase.`,
      origin,
    };
  }

  if (inert(before)) {
    const headInSource = before.length > 0 && plainText(before) !== '';
    const out = [...target];
    let index = 0;
    const first = out[0];
    if (headInSource && first?.k === 't') {
      const head = INERT_HEAD.exec(first.v)?.[0] ?? '';
      if (head !== '' && head !== first.v) {
        out.splice(0, 1, editedText(head), missing, editedText(first.v.slice(head.length)));
        index = 1;
      } else {
        out.unshift(missing);
      }
    } else {
      out.unshift(missing);
    }
    return {
      kind: 'insert-edge',
      segments: out,
      changed: [index],
      explanation: `Add ${labelOf(missing)} at the start, mirroring the source, where it opens the phrase.`,
      origin,
    };
  }

  return null;
}

function lastWord(segments: readonly Segment[]): string {
  const text = plainText(segments).trimEnd();
  const match = /(\S+)$/u.exec(text);
  return match?.[1] ?? '';
}
