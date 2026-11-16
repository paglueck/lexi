// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Builders that emit XLIFF 1.2 exactly as `@angular/compiler` writes it.
 *
 * Deliberately plain string templating. These must never route through our own
 * writer: a corpus produced by the code under test makes every round-trip
 * assertion circular and green by definition.
 *
 * The shape below is taken from `@angular/compiler@22` `fesm2022/compiler.mjs`:
 * `Xliff.write` (~line 28458) for the structure and indentation, `visitDeclaration`
 * for the prolog's space before `?>`, and `_ESCAPED_CHARS` for the escape set.
 * See docs/architecture.md (Angular's output shape).
 */

/** Indentation Angular uses, as `CR(n)` = newline + n spaces. */
const cr = (spaces: number): string => '\n' + ' '.repeat(spaces);

/** Angular escapes all five predefined entities, in text and in attribute values. */
export const escapeXmlLikeAngular = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export interface ContextGroupSpec {
  readonly sourcefile: string;
  readonly linenumber: number;
}

export interface UnitSpec {
  readonly id: string;
  /** Raw inner XML of `<source>`, written verbatim — placeholders included. */
  readonly source: string;
  /** Raw inner XML of `<target>`. Omit for no `<target>` element at all. */
  readonly target?: string;
  /** `state` attribute on `<target>`. Only meaningful together with a target. */
  readonly state?: string;
  /** Emit `<target …/>` self-closed, as `ng-extract-i18n-merge` does for new units. */
  readonly targetSelfClosing?: boolean;
  readonly datatype?: string;
  readonly description?: string;
  readonly meaning?: string;
  readonly contextGroups?: readonly ContextGroupSpec[];
}

export interface FileSpec {
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
  readonly original?: string;
  readonly datatype?: string;
  readonly units: readonly UnitSpec[];
}

export interface DocSpec {
  readonly files: readonly FileSpec[];
  readonly bom?: boolean;
  readonly eol?: '\n' | '\r\n';
  /** Angular always ends the document with a newline; some editors strip it. */
  readonly trailingNewline?: boolean;
}

function renderUnit(u: UnitSpec): string {
  const parts: string[] = [];
  parts.push(`${cr(6)}<trans-unit id="${escapeXmlLikeAngular(u.id)}" datatype="${u.datatype ?? 'html'}">`);
  parts.push(`${cr(8)}<source>${u.source}</source>`);

  if (u.target !== undefined || u.targetSelfClosing) {
    const stateAttr = u.state === undefined ? '' : ` state="${u.state}"`;
    parts.push(
      u.targetSelfClosing
        ? `${cr(8)}<target${stateAttr}/>`
        : `${cr(8)}<target${stateAttr}>${u.target ?? ''}</target>`,
    );
  }

  for (const cg of u.contextGroups ?? []) {
    parts.push(`${cr(8)}<context-group purpose="location">`);
    parts.push(`${cr(10)}<context context-type="sourcefile">${escapeXmlLikeAngular(cg.sourcefile)}</context>`);
    parts.push(`${cr(10)}<context context-type="linenumber">${cg.linenumber}</context>`);
    parts.push(`${cr(8)}</context-group>`);
  }

  if (u.description !== undefined) {
    parts.push(`${cr(8)}<note priority="1" from="description">${escapeXmlLikeAngular(u.description)}</note>`);
  }
  if (u.meaning !== undefined) {
    parts.push(`${cr(8)}<note priority="1" from="meaning">${escapeXmlLikeAngular(u.meaning)}</note>`);
  }

  parts.push(`${cr(6)}</trans-unit>`);
  return parts.join('');
}

function renderFile(f: FileSpec): string {
  // Attribute order matches Angular's: source-language, datatype, original.
  // target-language is appended, which is where ng-extract-i18n-merge puts it.
  const attrs = [
    `source-language="${f.sourceLanguage ?? 'en-GB'}"`,
    `datatype="${f.datatype ?? 'plaintext'}"`,
    `original="${f.original ?? 'ng2.template'}"`,
    ...(f.targetLanguage === undefined ? [] : [`target-language="${f.targetLanguage}"`]),
  ].join(' ');

  const units = f.units.map(renderUnit).join('');
  return `${cr(2)}<file ${attrs}>${cr(4)}<body>${units}${cr(4)}</body>${cr(2)}</file>`;
}

/** Render a complete document byte-for-byte the way Angular would. */
export function angularXlf(spec: DocSpec): string {
  const files = spec.files.map(renderFile).join('');
  let text =
    `<?xml version="1.0" encoding="UTF-8" ?>\n` +
    `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">${files}\n</xliff>` +
    (spec.trailingNewline === false ? '' : '\n');

  if (spec.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (spec.bom) text = '﻿' + text;
  return text;
}

/** A single-unit document, for tests that only care about one `<trans-unit>`. */
export const oneUnit = (u: UnitSpec, file: Partial<FileSpec> = {}): string =>
  angularXlf({ files: [{ ...file, units: [u] }] });

/** The `<x/>` placeholder forms Angular emits, ready to paste into `source`. */
export const ph = {
  interpolation: (n = 0, equiv = '{{ value }}') =>
    `<x id="INTERPOLATION${n === 0 ? '' : `_${n}`}" equiv-text="${escapeXmlLikeAngular(equiv)}"/>`,
  startTag: (tag: string) =>
    `<x id="START_TAG_${tag.toUpperCase()}" ctype="x-${tag.toLowerCase()}" equiv-text="${escapeXmlLikeAngular(`<${tag}>`)}"/>`,
  closeTag: (tag: string) =>
    `<x id="CLOSE_TAG_${tag.toUpperCase()}" ctype="x-${tag.toLowerCase()}" equiv-text="${escapeXmlLikeAngular(`</${tag}>`)}"/>`,
  lineBreak: () => `<x id="LINE_BREAK" ctype="lb" equiv-text="${escapeXmlLikeAngular('<br/>')}"/>`,
  icu: (equiv: string) => `<x id="ICU" equiv-text="${escapeXmlLikeAngular(equiv)}"/>`,
};
