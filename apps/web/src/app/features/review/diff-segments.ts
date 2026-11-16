// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SegmentDto } from '@lexi/shared';

/**
 * The word diff behind S11's "against previous target" card (M14).
 *
 * WHY NOT A LIBRARY. The interesting requirement is not the diff algorithm, it
 * is that a PLACEHOLDER IS ONE INDIVISIBLE TOKEN. Every off-the-shelf text diff
 * takes a string, and the only way to hand it a chip is to flatten the chip to
 * text first — at which point `{{ threshold }}` is five tokens, a reworded
 * sentence can show half a placeholder as deleted, and the rule the editor
 * enforces everywhere else (chips delete as one unit, never split) is broken by
 * the one screen whose job is to show what changed.
 *
 * So the diff runs over SEGMENTS, not characters: a chip compares by id, text
 * compares word by word, and the output carries chips through intact for the
 * template to render with the same `LxPlaceholderChip` as everywhere else.
 *
 * Plain LCS over tokens, `O(n·m)`. A target is a UI string — tens of words, not
 * a source file — and the quadratic table is both smaller and more predictable
 * than the machinery that would avoid it.
 */

export type DiffOp = 'same' | 'removed' | 'added';

export type DiffToken =
  | { readonly kind: 'text'; readonly v: string }
  | { readonly kind: 'chip'; readonly id: string; readonly label: string }
  | { readonly kind: 'open' | 'close'; readonly id: string };

export interface DiffOptions {
  /**
   * Keep a group's boundaries as atomic `open`/`close` tokens instead of
   * reading straight through them. S11 does not want them (the reviewer never
   * edits markup); the CSV re-import diff does, because a changed `<g1>` is a
   * change the person approving the import must see.
   */
  readonly groups?: boolean;
  /** Run the three clean-up passes so a changed phrase reads as one block. */
  readonly tidy?: boolean;
}

export interface DiffPart {
  readonly op: DiffOp;
  readonly token: DiffToken;
}

/**
 * Segments to tokens: chips whole, text split into words WITH their trailing
 * whitespace.
 *
 * Keeping the space attached to the word before it is what stops a diff of
 * "free shipping" against "free delivery" reporting the space between them as
 * changed, and it means joining the tokens back up reproduces the string.
 *
 * The import path (`groups` or `tidy`) splits the space off as its own token
 * instead. Attached, `Facturation` and `Facturation ` differ, so a word added
 * at the end reads as the whole text replaced. Tidy's first pass already
 * bridges the bare-space tokens this leaves between two changes; S11 keeps
 * the attached form it was built and tested with.
 */
export function tokenize(segments: readonly SegmentDto[], opts: DiffOptions = {}): DiffToken[] {
  const words = opts.groups || opts.tidy ? /\S+|\s+/g : /\S+\s*|\s+/g;
  const out: DiffToken[] = [];
  const walk = (list: readonly SegmentDto[]): void => {
    for (const s of list) {
      if (s.k === 'p') {
        out.push({ kind: 'chip', id: s.id, label: s.equivText ?? s.id });
      } else if (s.k === 'g') {
        // By default a group's own tags are markup the reviewer never edits;
        // its children are the text they are judging.
        if (opts.groups) out.push({ kind: 'open', id: s.id });
        walk(s.children);
        if (opts.groups) out.push({ kind: 'close', id: s.id });
      } else {
        for (const word of s.v.match(words) ?? []) out.push({ kind: 'text', v: word });
      }
    }
  };
  walk(segments);
  return out;
}

const same = (a: DiffToken, b: DiffToken): boolean =>
  a.kind === 'text' || b.kind === 'text'
    ? a.kind === 'text' && b.kind === 'text' && a.v === b.v
    : a.kind === b.kind && a.id === b.id;

/**
 * What changed between the previous target and the draft.
 *
 * Removals are emitted before the additions they were replaced by, so the card
 * reads "was → is" in the order a person tells the story.
 */
export function diffSegments(
  previous: readonly SegmentDto[],
  next: readonly SegmentDto[],
  opts: DiffOptions = {},
): readonly DiffPart[] {
  const a = tokenize(previous, opts);
  const b = tokenize(next, opts);

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[];
      row[j] = same(a[i] as DiffToken, b[j] as DiffToken)
        ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
        : Math.max((lcs[i + 1] as number[])[j] as number, (row[j + 1] as number) ?? 0);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i] as DiffToken, b[j] as DiffToken)) {
      parts.push({ op: 'same', token: a[i] as DiffToken });
      i += 1;
      j += 1;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      parts.push({ op: 'removed', token: a[i] as DiffToken });
      i += 1;
    } else {
      parts.push({ op: 'added', token: b[j] as DiffToken });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) parts.push({ op: 'removed', token: a[i] as DiffToken });
  for (; j < b.length; j += 1) parts.push({ op: 'added', token: b[j] as DiffToken });
  return opts.tidy ? tidyParts(parts) : parts;
}

/**
 * The CSV re-import diff's three clean-up passes, so "Save now" to "Store it
 * now" reads as one deleted phrase and one inserted phrase rather than a
 * confetti of single words.
 *
 * 1. A whitespace-only `same` token between two changes joins them: it becomes
 *    a removed and an added token, so the changed phrase stays one block.
 * 2. Within each run of changes, removals come before additions.
 * 3. Adjacent text tokens with the same op merge. Chips and group boundaries
 *    never merge; they stay atomic.
 */
function tidyParts(raw: readonly DiffPart[]): readonly DiffPart[] {
  const isBlank = (t: DiffToken): boolean => t.kind === 'text' && !/\S/.test(t.v);
  const bridged = raw.flatMap((part, k): DiffPart[] => {
    const p = raw[k - 1];
    const q = raw[k + 1];
    if (part.op !== 'same' || !isBlank(part.token) || !p || !q) return [part];
    if (p.op === 'same' || q.op === 'same') return [part];
    return [
      { op: 'removed', token: part.token },
      { op: 'added', token: part.token },
    ];
  });

  const ordered: DiffPart[] = [];
  let run: DiffPart[] = [];
  const flush = (): void => {
    ordered.push(...run.filter((x) => x.op === 'removed'), ...run.filter((x) => x.op === 'added'));
    run = [];
  };
  for (const part of bridged) {
    if (part.op === 'same') {
      flush();
      ordered.push(part);
    } else run.push(part);
  }
  flush();

  const merged: DiffPart[] = [];
  for (const part of ordered) {
    const last = merged[merged.length - 1];
    if (last && last.op === part.op && last.token.kind === 'text' && part.token.kind === 'text') {
      merged[merged.length - 1] = {
        op: part.op,
        token: { kind: 'text', v: last.token.v + part.token.v },
      };
    } else merged.push(part);
  }
  return merged;
}

/** True when the two sides are the same text — the card then has nothing to say. */
export const isUnchanged = (parts: readonly DiffPart[]): boolean =>
  parts.every((p) => p.op === 'same');
