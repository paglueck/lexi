// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import type { CharOffset, Span } from './model.js';

/** Element names that stand for an Angular placeholder in `<source>` / `<target>`. */
const PLACEHOLDER_TAGS = new Set(['x', 'bx', 'ex', 'ph']);
/** Elements whose character data we retain while scanning. */
const TEXT_BEARING_TAGS = new Set(['source', 'target', 'note', 'context', 'g', 'mrk', ...PLACEHOLDER_TAGS]);

export class XlfScanError extends Error {
  constructor(
    message: string,
    readonly offset: CharOffset,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'XlfScanError';
  }
}

export interface ElementRef {
  readonly name: string;
  /** `<tag …>…</tag>` in full, or `<tag/>`. */
  readonly span: Span;
  /** `<tag …>` alone, or `<tag/>` when self-closing. */
  readonly openTagSpan: Span;
  /** Between the tags. Empty (`start === end`) when self-closing or empty. */
  readonly innerSpan: Span;
  readonly selfClosing: boolean;
  /** Decoded attribute values. Never write these back — slice the raw text instead. */
  readonly attrs: Readonly<Record<string, string>>;
}

export interface XlfNote extends ElementRef {
  /** Decoded character data. */
  readonly text: string;
}

export interface XlfContextGroup {
  readonly span: Span;
  readonly purpose: string | undefined;
  readonly sourcefile: string | undefined;
  readonly linenumber: string | undefined;
  /** Every `<context>` child, for purposes other than `location`. */
  readonly contexts: ReadonlyArray<{ readonly type: string | undefined; readonly value: string }>;
}

export interface TransUnit {
  readonly id: string;
  readonly span: Span;
  readonly openTagSpan: Span;
  readonly innerSpan: Span;
  readonly attrs: Readonly<Record<string, string>>;
  readonly source: ElementRef;
  readonly target: ElementRef | undefined;
  readonly notes: readonly XlfNote[];
  readonly contextGroups: readonly XlfContextGroup[];
  /**
   * Whitespace immediately preceding `<source>`, back to the previous newline.
   * Reproducing what the file actually does beats deriving indentation from a
   * detected unit and a nesting depth — it survives files someone reformatted.
   */
  readonly siblingIndent: string;
  /** True when `<source>` sits on the same line as the `<trans-unit>` open tag. */
  readonly isInline: boolean;
  /** Decoded source text with each placeholder rendered as its `equiv-text`. */
  readonly sourcePlain: string;
  readonly targetPlain: string | undefined;
  /** Placeholder ids in document order. The input to FR-PH-2. */
  readonly sourcePhIds: readonly string[];
  readonly targetPhIds: readonly string[] | undefined;
}

export interface XlfFile {
  readonly span: Span;
  readonly openTagSpan: Span;
  readonly attrs: Readonly<Record<string, string>>;
  readonly bodyInnerSpan: Span | undefined;
  readonly units: readonly TransUnit[];
  /**
   * Whether any `<target>` in this file already carries a `state` attribute.
   * Drives `writeState: 'auto'`, which keeps us invisible in repos that do not
   * use `ng-extract-i18n-merge` and compatible with those that do.
   */
  readonly hasAnyStateAttr: boolean;
}

export interface XlfDocument {
  readonly raw: string;
  readonly rawHash: string;
  readonly bom: boolean;
  readonly eol: '\n' | '\r\n';
  readonly files: readonly XlfFile[];
}

// ---------------------------------------------------------------------------

type ContentNode =
  | { readonly kind: 'text'; readonly span: Span; readonly text: string }
  | { readonly kind: 'el'; readonly node: ElementNode };

interface ElementNode {
  readonly ref: ElementRef;
  readonly content: ContentNode[];
}

interface Frame {
  readonly name: string;
  readonly openTagSpan: Span;
  readonly attrs: Record<string, string>;
  readonly innerStart: CharOffset;
  readonly keepText: boolean;
  readonly children: ElementNode[];
  readonly content: ContentNode[];
}

const lineStartsOf = (raw: string): Int32Array => {
  const starts: number[] = [0];
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) starts.push(i + 1);
  return Int32Array.from(starts);
};

const positionOf = (lineStarts: Int32Array, offset: CharOffset): { line: number; column: number } => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
};

const detectEol = (raw: string): '\n' | '\r\n' => {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 10) continue;
    lf++;
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
  }
  return crlf > lf - crlf ? '\r\n' : '\n';
};

/** Concatenate character data, rendering placeholders as their `equiv-text`. */
function plainTextOf(content: readonly ContentNode[]): string {
  let out = '';
  for (const node of content) {
    if (node.kind === 'text') {
      out += node.text;
    } else if (PLACEHOLDER_TAGS.has(node.node.ref.name)) {
      out += node.node.ref.attrs['equiv-text'] ?? node.node.ref.attrs['id'] ?? '';
    } else {
      out += plainTextOf(node.node.content);
    }
  }
  return out;
}

/** Character data only, placeholders ignored. Used for notes and contexts. */
function charDataOf(content: readonly ContentNode[]): string {
  let out = '';
  for (const node of content) {
    if (node.kind === 'text') out += node.text;
    else out += charDataOf(node.node.content);
  }
  return out;
}

function placeholderIdsOf(content: readonly ContentNode[], into: string[] = []): string[] {
  for (const node of content) {
    if (node.kind !== 'el') continue;
    if (PLACEHOLDER_TAGS.has(node.node.ref.name)) {
      into.push(node.node.ref.attrs['id'] ?? '');
    } else {
      placeholderIdsOf(node.node.content, into);
    }
  }
  return into;
}

const childElements = (node: ElementNode, name: string): ElementNode[] =>
  node.content.flatMap((c) => (c.kind === 'el' && c.node.ref.name === name ? [c.node] : []));

/**
 * Scan an XLIFF 1.2 document into an index of exact character spans.
 *
 * The parser is used strictly as an offset oracle. Its decoded values feed
 * semantics — ids, `equiv-text`, search haystacks — while every byte destined to
 * be written back is taken from `raw.slice(span.start, span.end)`. That division
 * is what lets `escape(decode(x)) !== x` be true without costing us fidelity.
 */
export function scan(raw: string): XlfDocument {
  const lineStarts = lineStartsOf(raw);
  const fail = (message: string, offset: CharOffset): never => {
    const { line, column } = positionOf(lineStarts, offset);
    throw new XlfScanError(message, offset, line, column);
  };

  const root: Frame = {
    name: '#document',
    openTagSpan: { start: 0, end: 0 },
    attrs: {},
    innerStart: 0,
    keepText: false,
    children: [],
    content: [],
  };
  const stack: Frame[] = [root];
  const top = (): Frame => stack[stack.length - 1]!;

  const files: XlfFile[] = [];
  let units: TransUnit[] = [];
  let fileHasState = false;

  const buildUnit = (frame: Frame, span: Span): TransUnit | undefined => {
    const sourceNode = frame.children.find((c) => c.ref.name === 'source');
    if (!sourceNode) return undefined; // not a translation unit we can work with
    const targetNode = frame.children.find((c) => c.ref.name === 'target');

    const between = raw.slice(frame.innerStart, sourceNode.ref.span.start);
    const lastNewline = between.lastIndexOf('\n');
    const isInline = lastNewline === -1;
    const trailing = isInline ? '' : between.slice(lastNewline + 1);
    const siblingIndent = /^[ \t]*$/.test(trailing) ? trailing : '';

    const notes: XlfNote[] = frame.children
      .filter((c) => c.ref.name === 'note')
      .map((c) => ({ ...c.ref, text: charDataOf(c.content) }));

    const contextGroups: XlfContextGroup[] = frame.children
      .filter((c) => c.ref.name === 'context-group')
      .map((c) => {
        const contexts = childElements(c, 'context').map((ctx) => ({
          type: ctx.ref.attrs['context-type'],
          value: charDataOf(ctx.content),
        }));
        return {
          span: c.ref.span,
          purpose: c.ref.attrs['purpose'],
          sourcefile: contexts.find((x) => x.type === 'sourcefile')?.value,
          linenumber: contexts.find((x) => x.type === 'linenumber')?.value,
          contexts,
        };
      });

    return {
      id: frame.attrs['id'] ?? '',
      span,
      openTagSpan: frame.openTagSpan,
      innerSpan: { start: frame.innerStart, end: span.end },
      attrs: frame.attrs,
      source: sourceNode.ref,
      target: targetNode?.ref,
      notes,
      contextGroups,
      siblingIndent,
      isInline,
      sourcePlain: plainTextOf(sourceNode.content),
      targetPlain: targetNode ? plainTextOf(targetNode.content) : undefined,
      sourcePhIds: placeholderIdsOf(sourceNode.content),
      targetPhIds: targetNode ? placeholderIdsOf(targetNode.content) : undefined,
    };
  };

  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        const openTagSpan: Span = { start: parser.startIndex, end: parser.endIndex + 1 };
        if (name === 'file') {
          units = [];
          fileHasState = false;
        }
        if (name === 'target' && attribs['state'] !== undefined) fileHasState = true;
        stack.push({
          name,
          openTagSpan,
          attrs: { ...attribs },
          innerStart: openTagSpan.end,
          keepText: TEXT_BEARING_TAGS.has(name),
          children: [],
          content: [],
        });
      },

      ontext(text) {
        const frame = top();
        if (!frame.keepText) return;
        const span: Span = { start: parser.startIndex, end: parser.endIndex + 1 };
        const previous = frame.content[frame.content.length - 1];
        // htmlparser2 splits a single logical text run around entities and CDATA.
        // Coalesce by span adjacency; text length is not span length.
        if (previous?.kind === 'text' && previous.span.end === span.start) {
          frame.content[frame.content.length - 1] = {
            kind: 'text',
            span: { start: previous.span.start, end: span.end },
            text: previous.text + text,
          };
        } else {
          frame.content.push({ kind: 'text', span, text });
        }
      },

      onclosetag(name, implied) {
        const frame = stack.pop();
        if (!frame || frame === root) fail(`unexpected closing tag </${name}>`, parser.startIndex);
        if (frame!.name !== name) {
          fail(`closing tag </${name}> does not match open element <${frame!.name}>`, parser.startIndex);
        }

        const closeSpan: Span = { start: parser.startIndex, end: parser.endIndex + 1 };
        // Self-closing reports an implied close whose span is the open tag itself.
        // Any other implied close means the element was never closed.
        const selfClosing = implied && closeSpan.start === frame!.openTagSpan.start;
        if (implied && !selfClosing) {
          fail(`element <${frame!.name}> is never closed`, frame!.openTagSpan.start);
        }

        const span: Span = { start: frame!.openTagSpan.start, end: closeSpan.end };
        const innerSpan: Span = selfClosing
          ? { start: frame!.openTagSpan.end, end: frame!.openTagSpan.end }
          : { start: frame!.innerStart, end: closeSpan.start };

        const ref: ElementRef = {
          name: frame!.name,
          span,
          openTagSpan: frame!.openTagSpan,
          innerSpan,
          selfClosing,
          attrs: frame!.attrs,
        };

        if (name === 'trans-unit') {
          const unit = buildUnit(frame!, span);
          if (unit) units.push(unit);
          return; // the unit's content is not retained beyond this point
        }

        if (name === 'file') {
          const body = frame!.children.find((c) => c.ref.name === 'body');
          files.push({
            span,
            openTagSpan: frame!.openTagSpan,
            attrs: frame!.attrs,
            bodyInnerSpan: body?.ref.innerSpan,
            units,
            hasAnyStateAttr: fileHasState,
          });
          units = [];
          return;
        }

        const node: ElementNode = { ref, content: frame!.content };
        const parent = top();
        parent.children.push(node);
        parent.content.push({ kind: 'el', node });
      },
    },
    { xmlMode: true },
  );

  parser.write(raw);
  parser.end();

  if (stack.length !== 1) {
    const unclosed = stack[stack.length - 1]!;
    fail(`element <${unclosed.name}> is never closed`, unclosed.openTagSpan.start);
  }

  const rootElements = root.children.filter((c) => c.ref.name !== '#document');
  const xliff = rootElements.find((c) => c.ref.name === 'xliff');
  if (!xliff) {
    fail('document root element is not <xliff>', 0);
  }

  return {
    raw,
    rawHash: createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'),
    bom: raw.charCodeAt(0) === 0xfeff,
    eol: detectEol(raw),
    files,
  };
}
