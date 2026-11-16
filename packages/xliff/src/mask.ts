// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { probeFragment, verifyComposable } from './verify.js';
import {
  editedText,
  placeholderIds,
  segmentsOfFragment,
  type GroupSegment,
  type PlaceholderSegment,
  type Segment,
} from './segments.js';

/**
 * One masked placeholder: the `[[n]]` token the model sees, and what it stands for.
 */
export interface MaskToken {
  readonly index: number;
  /** What the prompt shows next to the token, e.g. `{{ invoiceCount }}` or `<strong>`. */
  readonly label: string;
  /** The segment restored in the token's place. */
  readonly segment: PlaceholderSegment;
}

export interface MaskResult {
  /** Decoded text with every placeholder replaced by `[[n]]`. */
  readonly masked: string;
  readonly tokens: readonly MaskToken[];
  /** Placeholder ids of the source, in document order. The restore gate compares against this. */
  readonly sourceIds: readonly string[];
}

export type UnmaskFailureReason =
  | 'empty'
  | 'token-out-of-range'
  | 'placeholder-missing'
  | 'placeholder-duplicated'
  | 'malformed-token'
  | 'invented-markup'
  | 'unknown-placeholder'
  | 'malformed-result';

export type UnmaskResult =
  | { readonly ok: true; readonly segments: readonly Segment[] }
  | {
      readonly ok: false;
      readonly reason: UnmaskFailureReason;
      readonly detail: string;
      readonly missing: readonly string[];
      readonly extra: readonly string[];
    };

/**
 * Anything that looks like a botched attempt at a token.
 *
 * Small models mangle the bracket shape far more often than they drop a
 * placeholder outright, and the two failures need different retry instructions,
 * so they get different reasons rather than being lumped together as "missing".
 */
const NEAR_MISS = /\[\s*\[|\]\s*\]|\(\(|\)\)|［|］|【|】|\{\{\s*\d+\s*\}\}/;

/**
 * XLIFF markup the model invented instead of using the tokens it was given.
 *
 * Deliberately narrow. A blanket "no angle brackets" rule would reject a perfectly
 * good translation of a string like "Press the <Enter> key", whose source carries
 * the brackets as escaped text rather than as a placeholder. Only markup that
 * imitates the placeholder vocabulary is a forgery worth refusing.
 */
const INVENTED_MARKUP = /<\/?(?:x|ph|bx|ex|g)[\s/>]|&lt;\/?(?:x|ph|bx|ex|g)[\s/>]|equiv-text/i;

/**
 * Replace every placeholder with a short bracketed token before prompting.
 *
 * Local models reproduce `[[0]]` far more reliably than
 * `<x id="START_TAG_STRONG" ctype="x-strong" equiv-text="&lt;strong&gt;"/>`, and
 * restoring is a mechanical lookup that either succeeds completely or fails
 * loudly — which is what makes the hard gate on the way back possible.
 */
export function maskSegments(segments: readonly Segment[]): MaskResult {
  const tokens: MaskToken[] = [];
  let masked = '';

  const walk = (nodes: readonly Segment[]): void => {
    for (const node of nodes) {
      if (node.k === 't') {
        masked += node.v;
      } else if (node.k === 'p') {
        masked += `[[${tokens.length}]]`;
        tokens.push({ index: tokens.length, label: node.equivText ?? node.id, segment: node });
      } else {
        // A group's boundaries are two movable tokens; its content stays translatable.
        masked += `[[${tokens.length}]]`;
        tokens.push({
          index: tokens.length,
          label: node.openRaw,
          segment: { k: 'p', raw: node.openRaw, id: node.id },
        });
        walk(node.children);
        masked += `[[${tokens.length}]]`;
        tokens.push({
          index: tokens.length,
          label: node.closeRaw,
          segment: { k: 'p', raw: node.closeRaw, id: node.id },
        });
      }
    }
  };
  walk(segments);

  return { masked, tokens, sourceIds: placeholderIds(segments) };
}

/**
 * Restore placeholders in a model's output, or refuse it.
 *
 * The output is split on the token pattern and turned straight into segments
 * rather than string-substituted back. Substitution would risk escaping text that
 * already contains entity sequences twice; building segments makes that class of
 * bug unrepresentable, because text and placeholders never share a string.
 *
 * A rejection carries no segments at all. A caller cannot accidentally write a
 * draft that failed its gate — the shape of the result forbids it.
 */
export function unmask(output: string, mask: MaskResult): UnmaskResult {
  const fail = (
    reason: UnmaskFailureReason,
    detail: string,
    missing: readonly string[] = [],
    extra: readonly string[] = [],
  ): UnmaskResult => ({ ok: false, reason, detail, missing, extra });

  if (output.trim() === '') {
    return fail('empty', 'The model returned no text.');
  }

  const parts = output.split(/(\[\[\d+\]\])/g).filter((p) => p !== '');
  const segments: Segment[] = [];
  const usedIndices: number[] = [];

  for (const part of parts) {
    const hit = /^\[\[(\d+)\]\]$/.exec(part);
    if (!hit) {
      segments.push(editedText(part));
      continue;
    }
    const index = Number(hit[1]);
    const token = mask.tokens[index];
    if (token === undefined) {
      return fail(
        'token-out-of-range',
        `The model wrote [[${index}]], but the source has ${mask.tokens.length} placeholder${mask.tokens.length === 1 ? '' : 's'}.`,
      );
    }
    usedIndices.push(index);
    segments.push(token.segment);
  }

  const residue = parts.filter((p) => !/^\[\[\d+\]\]$/.test(p)).join('');

  if (NEAR_MISS.test(residue)) {
    return fail(
      'malformed-token',
      'The output contains something that looks like a mangled placeholder token.',
    );
  }
  if (INVENTED_MARKUP.test(residue)) {
    return fail('invented-markup', 'The output contains markup instead of placeholder tokens.');
  }

  // Compare token *indices*, not placeholder ids. A group contributes two movable
  // boundary tokens that share one id, so counting ids would report a phantom
  // mismatch for every `<g>` in the corpus. Indices are one-to-one by construction.
  const idOf = (index: number): string => mask.tokens[index]?.segment.id ?? `[[${index}]]`;
  const seen = new Map<number, number>();
  for (const index of usedIndices) seen.set(index, (seen.get(index) ?? 0) + 1);

  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([i]) => i);
  const missingIndices = mask.tokens.map((t) => t.index).filter((i) => !seen.has(i));
  const missing = missingIndices.map(idOf);

  if (duplicated.length > 0) {
    return fail(
      'placeholder-duplicated',
      `The output repeats ${duplicated.map(idOf).join(', ')}.`,
      missing,
      duplicated.map(idOf),
    );
  }
  if (missingIndices.length > 0) {
    return fail(
      'placeholder-missing',
      `The output is missing ${missing.length} placeholder${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      missing,
    );
  }

  // Final gate: put the composed result through the real scanner rather than
  // trusting a parallel belief about what the writer will do. This is what catches
  // a model that reordered a group's boundary tokens into `</g>…<g>` — every
  // individual token is present and unique, and the bytes are still invalid XML.
  const verdict = verifyComposable(segments, mask.sourceIds);
  if (verdict !== undefined) return fail('malformed-result', verdict);

  return { ok: true, segments };
}

/* ---- the other prompt: raw XLIFF markup ---------------------------------- */

/**
 * The placeholder bytes a restore is allowed to use, gathered from the source.
 *
 * Groups are kept apart from atomic placeholders because a `<g>` contributes
 * TWO byte strings under ONE id, which is the same distinction the server's
 * wire vocabulary makes for a human edit.
 */
interface RawVocabulary {
  readonly chips: Map<string, PlaceholderSegment>;
  readonly groups: Map<string, GroupSegment>;
}

function vocabularyOf(segments: readonly Segment[], into?: RawVocabulary): RawVocabulary {
  const vocabulary: RawVocabulary = into ?? { chips: new Map(), groups: new Map() };
  for (const segment of segments) {
    if (segment.k === 'p') {
      if (!vocabulary.chips.has(segment.id)) vocabulary.chips.set(segment.id, segment);
    } else if (segment.k === 'g') {
      if (!vocabulary.groups.has(segment.id)) vocabulary.groups.set(segment.id, segment);
      vocabularyOf(segment.children, vocabulary);
    }
  }
  return vocabulary;
}

const groupIdsOf = (segments: readonly Segment[], into: string[] = []): string[] => {
  for (const segment of segments) {
    if (segment.k === 'g') {
      into.push(segment.id);
      groupIdsOf(segment.children, into);
    }
  }
  return into;
};

/** Multiset difference, both ways: what the source had and what the model added. */
function compareIds(
  expected: readonly string[],
  actual: readonly string[],
): { missing: string[]; extra: string[]; duplicated: string[] } {
  const remaining = [...actual];
  const missing: string[] = [];
  for (const id of expected) {
    const at = remaining.indexOf(id);
    if (at === -1) missing.push(id);
    else remaining.splice(at, 1);
  }
  // Whatever is left over appeared more often than the source has it. An id the
  // source knows is a duplication; one it does not is an invention, and the two
  // need different retry instructions.
  const known = new Set(expected);
  return {
    missing,
    extra: remaining.filter((id) => !known.has(id)),
    duplicated: remaining.filter((id) => known.has(id)),
  };
}

/**
 * Restore a model's output that carries real `<x/>` markup rather than `[[n]]`
 * tokens — the alternative rendering S5 toggles between (requirements Appendix A).
 *
 * Both paths exist so the claim behind the masking design can actually be
 * measured against a local model rather than assumed. They are gated equally
 * hard on the way back, which is what makes the comparison honest: the only
 * variable is the prompt.
 *
 * The model's own bytes for a placeholder are DISCARDED and the source's are
 * re-attached by id — exactly what happens to a human edit arriving from the
 * browser. A model that translates an `equiv-text`, drops `ctype` or reorders
 * the attributes therefore cannot change how the placeholder is spelled in the
 * file; it can only move it, or lose it, and losing it is caught below.
 */
export function restoreRaw(output: string, source: readonly Segment[]): UnmaskResult {
  const fail = (
    reason: UnmaskFailureReason,
    detail: string,
    missing: readonly string[] = [],
    extra: readonly string[] = [],
  ): UnmaskResult => ({ ok: false, reason, detail, missing, extra });

  if (output.trim() === '') return fail('empty', 'The model returned no text.');

  /**
   * Gate the model's OWN bytes before rebuilding anything.
   *
   * The fragment parser below auto-closes an element left open at the end of
   * input, and the rebuild then re-attaches the source's `</g>` — so a model
   * that forgot a closing tag would be silently repaired, with the group
   * suddenly wrapping the rest of the sentence. Reading the raw output through
   * the scanner first turns that into the refusal it should be.
   */
  const read = probeFragment(output);
  if (!read.ok) {
    return fail('malformed-result', `The output is not well-formed XLIFF markup: ${read.error}`);
  }

  const vocabulary = vocabularyOf(source);
  const unknown: string[] = [];

  const rebuild = (nodes: readonly Segment[]): Segment[] => {
    const out: Segment[] = [];
    for (const node of nodes) {
      if (node.k === 't') {
        // `editedText` drops the parsed bytes, so the model's text is re-escaped
        // by our writer rather than copied. A model that wrote a bare `&` must
        // not be able to put one into a file.
        if (node.v !== '') out.push(editedText(node.v));
        continue;
      }
      if (node.k === 'p') {
        const chip = vocabulary.chips.get(node.id);
        if (chip === undefined) {
          unknown.push(node.id);
          continue;
        }
        out.push({
          k: 'p',
          raw: chip.raw,
          id: chip.id,
          ...(chip.ctype === undefined ? {} : { ctype: chip.ctype }),
          ...(chip.equivText === undefined ? {} : { equivText: chip.equivText }),
        });
        continue;
      }
      const group = vocabulary.groups.get(node.id);
      if (group === undefined) {
        unknown.push(node.id);
        continue;
      }
      out.push({
        k: 'g',
        id: group.id,
        openRaw: group.openRaw,
        closeRaw: group.closeRaw,
        children: rebuild(node.children),
      });
    }
    return out;
  };

  const segments = rebuild(segmentsOfFragment(output));

  if (unknown.length > 0) {
    return fail(
      'unknown-placeholder',
      `The output invents ${unknown.join(', ')}, which the source does not have.`,
      [],
      unknown,
    );
  }

  const sourceIds = placeholderIds(source);
  const chips = compareIds(sourceIds, placeholderIds(segments));
  const groups = compareIds(groupIdsOf(source), groupIdsOf(segments));
  const missing = [...chips.missing, ...groups.missing];
  const duplicated = [...chips.duplicated, ...groups.duplicated];

  if (duplicated.length > 0) {
    return fail(
      'placeholder-duplicated',
      `The output repeats ${duplicated.join(', ')}.`,
      missing,
      duplicated,
    );
  }
  if (missing.length > 0) {
    return fail(
      'placeholder-missing',
      `The output is missing ${missing.length} placeholder${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
      missing,
    );
  }

  // The same final gate the masked path uses: compose and read back through the
  // real scanner rather than through a parallel belief about what it does.
  const verdict = verifyComposable(segments, sourceIds);
  if (verdict !== undefined) return fail('malformed-result', verdict);

  return { ok: true, segments };
}
