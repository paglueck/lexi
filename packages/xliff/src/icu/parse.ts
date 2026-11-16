// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Span } from '../model.js';
import type { PlaceholderSegment, Segment } from '../segments.js';

export type SelectType = 'plural' | 'selectordinal' | 'select';

export interface LiteralNode {
  readonly k: 'literal';
  readonly span: Span;
}

/** The `#` that stands for the formatted number inside a plural branch. */
export interface HashNode {
  readonly k: 'hash';
  readonly span: Span;
}

/** A plain `{NAME}` argument with no type. */
export interface ArgNode {
  readonly k: 'arg';
  readonly span: Span;
  readonly name: string;
  readonly nameSpan: Span;
}

export interface IcuBranch {
  readonly selector: string;
  readonly selectorSpan: Span;
  /** Between the branch's braces. Translating a branch is an edit over this span. */
  readonly bodyInnerSpan: Span;
  readonly body: readonly IcuNode[];
}

export interface SelectNode {
  readonly k: 'select';
  readonly span: Span;
  readonly type: SelectType;
  readonly varName: string;
  readonly varSpan: Span;
  readonly offset?: number;
  readonly branches: readonly IcuBranch[];
}

export type IcuNode = LiteralNode | HashNode | ArgNode | SelectNode;

export type IcuParseResult =
  | { readonly ok: true; readonly nodes: readonly IcuNode[] }
  | { readonly ok: false; readonly error: string; readonly offset: number };

/**
 * A sentinel standing in for one placeholder while ICU syntax is parsed.
 *
 * The NUL character is illegal in XML, so it can never occur in content read from
 * a file. That makes it a sentinel the text cannot collide with, which matters
 * because a placeholder's `equiv-text` routinely contains braces — the literal
 * `{{ invoiceCount }}` would otherwise read as nested ICU arguments.
 */
const SENTINEL = String.fromCharCode(0);

export interface IcuFlat {
  readonly text: string;
  readonly placeholders: readonly PlaceholderSegment[];
}

/**
 * Render segments as a flat string in which every placeholder is one opaque atom.
 *
 * This is the factoring that keeps the ICU parser honest: Angular emits `<x/>`
 * *inside* plural branches, so a string-level ICU parser would have to understand
 * XML and an XML-level parser would have to understand braces. Flattening solves
 * the placeholder problem one layer down, and the parser above sees only ICU.
 */
export function flattenForIcu(segments: readonly Segment[]): IcuFlat {
  const placeholders: PlaceholderSegment[] = [];
  let text = '';

  const walk = (nodes: readonly Segment[]): void => {
    for (const node of nodes) {
      if (node.k === 't') {
        text += node.v;
      } else if (node.k === 'p') {
        text += SENTINEL + placeholders.length + SENTINEL;
        placeholders.push(node);
      } else {
        // Group boundaries are atoms too; the content between them stays translatable.
        text += SENTINEL + placeholders.length + SENTINEL;
        placeholders.push({ k: 'p', raw: node.openRaw, id: node.id });
        walk(node.children);
        text += SENTINEL + placeholders.length + SENTINEL;
        placeholders.push({ k: 'p', raw: node.closeRaw, id: node.id });
      }
    }
  };
  walk(segments);

  return { text, placeholders };
}

/** Turn a flattened string — possibly edited — back into segments. */
export function unflattenIcu(text: string, flat: IcuFlat): Segment[] {
  const out: Segment[] = [];
  const pattern = new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g');
  let cursor = 0;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > cursor) out.push({ k: 't', v: text.slice(cursor, match.index) });
    const placeholder = flat.placeholders[Number(match[1])];
    if (placeholder !== undefined) out.push(placeholder);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) out.push({ k: 't', v: text.slice(cursor) });
  return out;
}

const SELECT_TYPES: ReadonlySet<string> = new Set<SelectType>(['plural', 'selectordinal', 'select']);

/**
 * A cheap structural test for "is this an ICU message at all".
 *
 * A bare `{0}` argument does not count: it has no branches and needs no
 * plural-category checking, so treating it as ICU would only produce noise.
 */
export function looksLikeIcu(text: string): boolean {
  const result = parseIcu(text);
  return result.ok && selectArguments(result.nodes).length > 0;
}

const isNameChar = (c: string): boolean => /[^\s,{}#]/.test(c);

/**
 * Parse ICU message syntax, recording exact spans.
 *
 * Spans rather than reconstructed strings, for the same reason the document
 * scanner works that way: translating one branch is then a single edit over that
 * branch's body, and the braces, the argument name, the type keyword, the
 * selectors and the offset are never regenerated, so they cannot drift.
 */
export function parseIcu(text: string): IcuParseResult {
  let i = 0;
  let failure: { error: string; offset: number } | undefined;

  const fail = (error: string, offset: number): undefined => {
    failure ??= { error, offset };
    return undefined;
  };

  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };

  /**
   * Advance past an ICU-quoted run. A `'` only quotes when it precedes a syntax
   * character; `''` is a literal apostrophe, and a lone `'` is just an apostrophe.
   */
  const skipQuoted = (): boolean => {
    if (text[i] !== "'") return false;
    const next = text[i + 1];
    if (next === "'") { i += 2; return true; }
    if (next !== '{' && next !== '}' && next !== '#') return false;
    i += 2;
    while (i < text.length && text[i] !== "'") i++;
    if (i < text.length) i++;
    return true;
  };

  const parseMessage = (stopAtBrace: boolean): IcuNode[] | undefined => {
    const nodes: IcuNode[] = [];
    let literalStart = i;

    const flushLiteral = (): void => {
      if (i > literalStart) nodes.push({ k: 'literal', span: { start: literalStart, end: i } });
    };

    while (i < text.length) {
      if (skipQuoted()) continue;

      const c = text[i]!;
      if (c === '}' && stopAtBrace) break;

      if (c === '#') {
        flushLiteral();
        nodes.push({ k: 'hash', span: { start: i, end: i + 1 } });
        i++;
        literalStart = i;
        continue;
      }

      if (c === '{') {
        flushLiteral();
        const argument = parseArgument();
        if (argument === undefined) return undefined;
        nodes.push(argument);
        literalStart = i;
        continue;
      }

      i++;
    }

    flushLiteral();
    return nodes;
  };

  const skipToClosingBrace = (start: number): number | undefined => {
    let depth = 0;
    let j = start;
    while (j < text.length) {
      const c = text[j]!;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return fail('unbalanced braces', start);
  };

  const parseArgument = (): IcuNode | undefined => {
    const start = i;
    i++; // '{'
    skipSpace();

    const nameStart = i;
    while (i < text.length && isNameChar(text[i]!)) i++;
    const nameEnd = i;
    if (nameEnd === nameStart) return fail('argument has no name', start);
    const varName = text.slice(nameStart, nameEnd);

    skipSpace();
    if (text[i] === '}') {
      i++;
      return { k: 'arg', span: { start, end: i }, name: varName, nameSpan: { start: nameStart, end: nameEnd } };
    }
    if (text[i] !== ',') return fail('expected "," or "}" after argument name', i);
    i++;
    skipSpace();

    const typeStart = i;
    while (i < text.length && isNameChar(text[i]!)) i++;
    const type = text.slice(typeStart, i);
    if (!SELECT_TYPES.has(type)) {
      // A typed argument we do not model (`number`, `date`, …). Skip to its close.
      const end = skipToClosingBrace(start);
      if (end === undefined) return undefined;
      i = end;
      return { k: 'arg', span: { start, end }, name: varName, nameSpan: { start: nameStart, end: nameEnd } };
    }

    skipSpace();
    if (text[i] !== ',') return fail('"' + type + '" needs at least one branch', i);
    i++;
    skipSpace();

    let offset: number | undefined;
    if (text.startsWith('offset:', i)) {
      i += 'offset:'.length;
      const digitsStart = i;
      while (i < text.length && /[-\d]/.test(text[i]!)) i++;
      offset = Number(text.slice(digitsStart, i));
      skipSpace();
    }

    const branches: IcuBranch[] = [];
    while (i < text.length && text[i] !== '}') {
      skipSpace();
      if (text[i] === '}') break;

      const selectorStart = i;
      while (i < text.length && isNameChar(text[i]!)) i++;
      const selectorEnd = i;
      if (selectorEnd === selectorStart) return fail('branch has no selector', i);
      const selector = text.slice(selectorStart, selectorEnd);

      skipSpace();
      if (text[i] !== '{') return fail('branch "' + selector + '" has no body', i);
      i++;
      const bodyStart = i;
      const body = parseMessage(true);
      if (body === undefined) return undefined;
      const bodyEnd = i;
      if (text[i] !== '}') return fail('branch "' + selector + '" is not closed', bodyStart);
      i++;

      branches.push({
        selector,
        selectorSpan: { start: selectorStart, end: selectorEnd },
        bodyInnerSpan: { start: bodyStart, end: bodyEnd },
        body,
      });
      skipSpace();
    }

    if (text[i] !== '}') return fail('"' + varName + '" is not closed', start);
    i++;
    if (branches.length === 0) return fail('"' + varName + '" has no branches', start);

    return {
      k: 'select',
      span: { start, end: i },
      type: type as SelectType,
      varName,
      varSpan: { start: nameStart, end: nameEnd },
      ...(offset === undefined ? {} : { offset }),
      branches,
    };
  };

  const nodes = parseMessage(false);
  if (nodes === undefined || failure !== undefined) {
    return { ok: false, error: failure?.error ?? 'could not parse', offset: failure?.offset ?? i };
  }
  if (i < text.length) {
    return { ok: false, error: 'unbalanced braces', offset: i };
  }
  return { ok: true, nodes };
}

/** Every plural/select argument in the tree, outermost first. */
export function selectArguments(nodes: readonly IcuNode[], into: SelectNode[] = []): SelectNode[] {
  for (const node of nodes) {
    if (node.k !== 'select') continue;
    into.push(node);
    for (const branch of node.branches) selectArguments(branch.body, into);
  }
  return into;
}

export const selectorsOf = (node: SelectNode): string[] => node.branches.map((b) => b.selector);
