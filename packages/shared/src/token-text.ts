// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SegmentDto } from './units.js';

/**
 * A unit's segments as plain text a reviewer can edit in Excel, and back.
 *
 * Placeholders cannot be written as their bytes, and dropping them would make
 * the round trip impossible. Each one becomes a numbered token that still shows
 * what it stands for — `{1:{{ count }}}` — and a `<g>` wraps its text in
 * `{2}…{/2}`. Numbering restarts per unit, in document order, so the import
 * can rebuild every token a row must contain from the unit's own segments and
 * name the one a reviewer broke.
 *
 * Zod-free and Node-free, like `termbase-csv.ts`: the server writes the CSV and
 * reads it back, and the import dialog's preview runs the same parser in the
 * browser.
 */

/**
 * Segments to token text. The number is the placeholder's position in a
 * depth-first walk, which is the only thing `parseTokenText` trusts: the label
 * after the colon is there for the reviewer's eyes.
 */
export function tokenText(segments: readonly SegmentDto[]): string {
  let next = 0;
  const walk = (list: readonly SegmentDto[]): string =>
    list
      .map((s) => {
        if (s.k === 't') return s.v;
        const n = ++next;
        if (s.k === 'p') return `{${n}:${s.equivText ?? s.id}}`;
        return `{${n}}${walk(s.children)}{/${n}}`;
      })
      .join('');
  return walk(segments);
}

export type ParsedTokenText = { ok: true; segments: SegmentDto[] } | { ok: false; reason: string };

/**
 * `{n}`, `{n:label}` or `{/n}`. The label may contain `{{ … }}` (an Angular
 * interpolation's equiv-text), which is why it is not simply `[^}]*`; a lone
 * `{b}` that merely looks like a token has no digits and stays text.
 */
const TOKEN = /\{(\d+)(:[^{}]*(?:\{\{[^}]*\}\}[^{}]*)*)?\}|\{\/(\d+)\}/g;

/**
 * Token text back to segments, rebuilt from `reference` — the cell's own
 * segments, numbered the way `tokenText` numbers them. Tokens map by number
 * only: a reviewer who edits the label inside `{1:{{ count }}}` has not changed
 * which placeholder it is, so the row still imports and the reference's
 * placeholder is copied, bytes-in-memory and all. A number that is unknown,
 * missing, repeated or unbalanced is a reason the row cannot be applied, and
 * the reason is the string the preview shows.
 */
export function parseTokenText(text: string, reference: readonly SegmentDto[]): ParsedTokenText {
  const byNumber = new Map<number, SegmentDto>();
  let counter = 0;
  const number = (list: readonly SegmentDto[]): void => {
    for (const s of list) {
      if (s.k === 't') continue;
      byNumber.set(++counter, s);
      if (s.k === 'g') number(s.children);
    }
  };
  number(reference);

  const used = new Set<number>();
  // The root frame has no number; each open group pushes one.
  const stack: { n: number; id: string; children: SegmentDto[] }[] = [
    { n: 0, id: '', children: [] },
  ];
  const top = (): { n: number; id: string; children: SegmentDto[] } => stack[stack.length - 1]!;

  const pushText = (v: string): void => {
    if (v === '') return;
    const children = top().children;
    const last = children[children.length - 1];
    if (last?.k === 't') children[children.length - 1] = { k: 't', v: last.v + v };
    else children.push({ k: 't', v });
  };

  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;

    if (m[3] !== undefined) {
      const n = Number(m[3]);
      if (stack.length === 1 || top().n !== n) {
        // At the root nothing is open, so any closer (`{/0}` included) is stray.
        // A closer for a group that is open further out means the inner one
        // was never closed; one for a group that is not open at all is stray.
        const open = stack.find((f) => f.n === n && f.n !== 0);
        return { ok: false, reason: open ? `Unclosed {${top().n}}` : `Stray {/${n}}` };
      }
      const frame = stack.pop()!;
      top().children.push({ k: 'g', id: frame.id, children: frame.children });
      continue;
    }

    const n = Number(m[1]);
    const ref = byNumber.get(n);
    const isPlaceholder = m[2] !== undefined;
    if (!ref || ref.k === 't' || (ref.k === 'p') !== isPlaceholder) {
      return { ok: false, reason: `Unknown placeholder {${n}}` };
    }
    if (used.has(n)) return { ok: false, reason: `Placeholder {${n}} appears twice` };
    used.add(n);
    if (ref.k === 'p') top().children.push(ref);
    else stack.push({ n, id: ref.id, children: [] });
  }
  pushText(text.slice(at));

  if (stack.length > 1) return { ok: false, reason: `Unclosed {${top().n}}` };
  for (let n = 1; n <= byNumber.size; n += 1) {
    if (!used.has(n)) return { ok: false, reason: `Placeholder {${n}} is missing` };
  }
  return { ok: true, segments: stack[0]!.children };
}
