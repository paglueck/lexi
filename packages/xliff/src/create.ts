// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { escapeText } from './escape.js';

/**
 * A whole XLIFF 1.2 document, written from nothing — the one thing this package
 * otherwise never does.
 *
 * Everywhere else the original text is the truth and writing means splicing.
 * A Phrase checkout has no original text: the keys arrive as JSON, and the
 * files that hold them do not exist yet. So the document is generated once, in
 * the exact shape `ng extract-i18n` writes (prolog with the space before `?>`,
 * `source-language`/`datatype`/`original` in Angular's order, 2-space steps,
 * `datatype="html"` units, `<note priority="1" from="description">`), and from
 * then on it is an ordinary file that every later save splices into.
 *
 * Text is escaped with the `minimal` policy: Phrase's text is plain, and its
 * placeholders (`{amount}`, `%s`) are left literal — the placeholder detection
 * that reads every other file reads these too.
 */

export interface CreateUnitSpec {
  /** The key name; becomes `<trans-unit id>`. */
  readonly id: string;
  /** Plain source text. */
  readonly source: string;
  /** Each one becomes a `<note priority="1" from="description">`. */
  readonly notes?: readonly string[];
  /** Write `<target state="new"></target>` — a target file's untranslated unit. */
  readonly emptyTarget?: boolean;
}

export interface CreateDocumentSpec {
  readonly sourceLanguage: string;
  /** Absent for the base file, which is then a template. */
  readonly targetLanguage?: string;
  readonly units: readonly CreateUnitSpec[];
}

const cr = (spaces: number): string => '\n' + ' '.repeat(spaces);

/** Attribute values need `"` escaped too, which the `minimal` text policy leaves alone. */
const attr = (value: string): string => escapeText(value, 'minimal').replace(/"/g, '&quot;');

export function createXliffDocument(spec: CreateDocumentSpec): string {
  const fileAttrs = [
    `source-language="${attr(spec.sourceLanguage)}"`,
    'datatype="plaintext"',
    'original="ng2.template"',
    ...(spec.targetLanguage === undefined ? [] : [`target-language="${attr(spec.targetLanguage)}"`]),
  ].join(' ');

  const units = spec.units
    .map((unit) => {
      const parts = [
        `${cr(6)}<trans-unit id="${attr(unit.id)}" datatype="html">`,
        `${cr(8)}<source>${escapeText(unit.source, 'minimal')}</source>`,
      ];
      if (unit.emptyTarget) parts.push(`${cr(8)}<target state="new"></target>`);
      for (const note of unit.notes ?? []) {
        parts.push(
          `${cr(8)}<note priority="1" from="description">${escapeText(note, 'minimal')}</note>`,
        );
      }
      parts.push(`${cr(6)}</trans-unit>`);
      return parts.join('');
    })
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" ?>\n` +
    `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">` +
    `${cr(2)}<file ${fileAttrs}>${cr(4)}<body>${units}${cr(4)}</body>${cr(2)}</file>\n</xliff>\n`
  );
}
