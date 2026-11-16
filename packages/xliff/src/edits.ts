// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Span } from './model.js';
import { applyEdits, type Edit } from './splice.js';
import { parseAttrSpans } from './attrspans.js';
import { escapeText, type EscapePolicy } from './escape.js';
import type { TransUnit, XlfDocument, XlfFile } from './scan.js';

/**
 * Produce the document text with the given edits applied.
 *
 * With no edits this reduces to the original string, which is why round-trip
 * fidelity (NFR-5) is a property of the design rather than something the tests
 * have to keep defending.
 */
export const serialize = (doc: XlfDocument, edits: readonly Edit[]): string =>
  applyEdits(doc.raw, edits);

export interface WriteTargetOptions {
  /**
   * `undefined` leaves any existing `state` untouched, a string sets it, and
   * `null` removes it. The mapping from an internal state to an XLIFF value, and
   * the decision whether to write one at all, belong to the caller.
   */
  readonly state?: string | null;
  /**
   * The locale this file translates INTO — `<file target-language>`.
   *
   * XLIFF 1.2 says `xml:lang` on `<target>` names the language of the target
   * text, so in a `target-language="de-DE"` file it must read `de-DE`. Angular
   * writes no `xml:lang` at all, which is why this went unnoticed: it only
   * matters in files from other toolchains, where every `<source>` and
   * `<target>` carries one.
   *
   * THE RULE IS "MATCH THE FILE'S OWN CONVENTION", not "always write one".
   * Supplying this corrects an `xml:lang` that is already on the target, and
   * puts one on a target being created next to a `<source>` that has one. It
   * never introduces the attribute into a file that does not use it —
   * inventing an attribute across somebody's whole translation file is not a
   * translation edit, and NFR-8 is the reason the writer splices rather than
   * re-serializes in the first place.
   *
   * Taken from the file rather than from the caller's own idea of the locale,
   * so the two can never disagree within one document.
   */
  readonly targetLanguage?: string;
}

/**
 * Edits that give a unit's `<target>` the supplied inner XML.
 *
 * `innerXml` is written verbatim — the caller has already escaped text and kept
 * placeholder elements in their original bytes. Four shapes have to be handled,
 * and only the first is the "obvious" one:
 *
 * 1. a paired `<target>…</target>`  — replace the content, which is the minimal diff;
 * 2. a self-closed `<target state="new"/>` — replace the whole element, because
 *    there is no content span to write into. `ng-extract-i18n-merge` emits this
 *    routinely, so it is a normal case rather than an edge case;
 * 3. no `<target>` at all — insert one after `<source>`, which is the common case
 *    for an extraction template;
 * 4. any of the above plus a `state` change.
 */
export function writeTarget(
  doc: XlfDocument,
  unit: TransUnit,
  innerXml: string,
  options: WriteTargetOptions = {},
): Edit[] {
  const { state } = options;
  const target = unit.target;

  const { targetLanguage } = options;

  if (target === undefined) {
    return [createTargetEdit(doc, unit, innerXml, state ?? undefined, targetLanguage)];
  }

  if (target.selfClosing) {
    // `undefined` means "leave state alone", so the existing attribute is copied
    // with the others; only an explicit value or `null` may touch it. Lumping the
    // two together silently dropped `state="new"` off every self-closed target
    // this expanded — and `ng-extract-i18n-merge` emits those routinely, so it
    // was data loss in the normal case rather than an edge one.
    const attrs = attributesExcept(doc.raw, target.openTagSpan, state === undefined ? null : 'state', targetLanguage);
    const stateAttr = state == null ? '' : ` state="${state}"`;
    return [{
      span: target.span,
      replacement: `<target${attrs}${stateAttr}>${innerXml}</target>`,
      reason: `expand self-closed target of ${unit.id}`,
    }];
  }

  const edits: Edit[] = [{
    span: target.innerSpan,
    replacement: innerXml,
    reason: `set target content of ${unit.id}`,
  }];

  if (state !== undefined) edits.push(...stateEdits(doc, unit, target.openTagSpan, state));
  edits.push(...langEdits(doc, unit, target.openTagSpan, targetLanguage));
  return edits;
}

/**
 * Correct a `<target>`'s `xml:lang` to the locale the file translates into.
 *
 * Only ever an edit to a value that is already there, and only when it differs
 * — an attribute edit that changes nothing is still a line in somebody's diff.
 */
function langEdits(
  doc: XlfDocument,
  unit: TransUnit,
  openTagSpan: Span,
  targetLanguage: string | undefined,
): Edit[] {
  if (targetLanguage === undefined) return [];
  const existing = parseAttrSpans(doc.raw, openTagSpan).get('xml:lang');
  if (existing === undefined) return [];
  if (doc.raw.slice(existing.valueSpan.start, existing.valueSpan.end) === targetLanguage) return [];
  return [{
    span: existing.valueSpan,
    replacement: targetLanguage,
    reason: `set xml:lang on the target of ${unit.id}`,
  }];
}

/** Set, change or remove the `state` attribute of an existing `<target>`. */
export function writeTargetState(doc: XlfDocument, unit: TransUnit, state: string | null): Edit[] {
  const target = unit.target;
  if (target === undefined) return [];
  return stateEdits(doc, unit, target.openTagSpan, state);
}

function stateEdits(doc: XlfDocument, unit: TransUnit, openTagSpan: Span, state: string | null): Edit[] {
  const attrs = parseAttrSpans(doc.raw, openTagSpan);
  const existing = attrs.get('state');

  if (state === null) {
    return existing ? [{ span: existing.span, replacement: '', reason: `remove state of ${unit.id}` }] : [];
  }
  if (existing) {
    return [{ span: existing.valueSpan, replacement: state, reason: `set state of ${unit.id}` }];
  }
  // New attributes go first, matching where ng-extract-i18n-merge puts `state`.
  return [{
    span: { start: attrs.insertionPoint, end: attrs.insertionPoint },
    replacement: ` state="${state}"`,
    reason: `add state to ${unit.id}`,
  }];
}

/**
 * Insert a `<target>` directly after `<source>`.
 *
 * XLIFF 1.2's content model for `trans-unit` is `source, seg-source?, target?, …,
 * context-group*, …, note*`, so this position is both correct and where
 * `ng-extract-i18n-merge` writes it — which is what keeps our diffs from fighting
 * the merge tool's.
 *
 * Indentation is copied from the whitespace preceding `<source>` rather than
 * derived from a detected indent unit and a nesting depth. Reproducing what the
 * file actually does survives files that someone's editor reformatted.
 */
function createTargetEdit(
  doc: XlfDocument,
  unit: TransUnit,
  innerXml: string,
  state: string | undefined,
  targetLanguage: string | undefined,
): Edit {
  const at = unit.source.span.end;
  const stateAttr = state === undefined ? '' : ` state="${state}"`;
  // The unit's OWN `<source>` decides whether this file uses `xml:lang`. A
  // created target without one, in a unit whose source has one, is the odd one
  // out in the file; a created target WITH one, in a file that has none
  // anywhere, is Lexi inventing a convention.
  const sourceLang = parseAttrSpans(doc.raw, unit.source.openTagSpan).get('xml:lang');
  const langAttr =
    targetLanguage !== undefined && sourceLang !== undefined ? ` xml:lang="${targetLanguage}"` : '';
  const lead = unit.isInline ? '' : doc.eol + unit.siblingIndent;
  return {
    span: { start: at, end: at },
    replacement: `${lead}<target${langAttr}${stateAttr}>${innerXml}</target>`,
    reason: `create target for ${unit.id}`,
  };
}

/**
 * Serialize an open tag's attributes, dropping one by name and correcting
 * `xml:lang` in place. Used when expanding `<target/>`.
 *
 * `xml:lang` is rewritten HERE rather than by a second edit, because this path
 * replaces the whole element — two edits over the same span would conflict.
 */
function attributesExcept(
  raw: string,
  openTagSpan: Span,
  drop: string | null,
  targetLanguage?: string,
): string {
  const attrs = parseAttrSpans(raw, openTagSpan);
  let out = '';
  for (const attr of attrs.values()) {
    if (attr.name === drop) continue;
    if (attr.name === 'xml:lang' && targetLanguage !== undefined) {
      out += ` xml:lang="${targetLanguage}"`;
      continue;
    }
    out += raw.slice(attr.span.start, attr.span.end);
  }
  return out;
}

/**
 * Correct one attribute on a `<file>` element — in practice a stale
 * `target-language` left behind by copying a translation file (FR-1.2b).
 */
export function setFileAttr(doc: XlfDocument, file: XlfFile, name: string, value: string): Edit[] {
  const attrs = parseAttrSpans(doc.raw, file.openTagSpan);
  const existing = attrs.get(name);
  if (existing) {
    return [{ span: existing.valueSpan, replacement: value, reason: `set ${name} on file` }];
  }
  // Append rather than prepend: Angular writes source-language first and readers
  // scan left to right, so a corrected target-language reads better at the end.
  const end = file.openTagSpan.end - (doc.raw[file.openTagSpan.end - 2] === '/' ? 2 : 1);
  return [{ span: { start: end, end }, replacement: ` ${name}="${value}"`, reason: `add ${name} to file` }];
}

/**
 * Remove a whole `<trans-unit>`, including the line it sits on, so no blank line
 * is left behind (FR-2.6).
 */
export function deleteUnit(doc: XlfDocument, unit: TransUnit): Edit[] {
  let start = unit.span.start;
  while (start > 0 && (doc.raw[start - 1] === ' ' || doc.raw[start - 1] === '\t')) start--;
  if (doc.raw.startsWith(doc.eol, start - doc.eol.length)) start -= doc.eol.length;
  return [{ span: { start, end: unit.span.end }, replacement: '', reason: `delete unit ${unit.id}` }];
}

/* ---- FR-4.2: notes --------------------------------------------------------- */

/** A note as the editor states it: what Angular's `<note>` carries, decoded. */
export interface NoteSpec {
  /** `description` / `meaning` in Angular's files; null writes no `from`. */
  readonly from: string | null;
  readonly priority: string | null;
  readonly text: string;
}

/**
 * Make a unit's notes read `desired`, spliced rather than regenerated.
 *
 * Compared position by position against what is in the file:
 * - same text and attributes: untouched, byte for byte;
 * - only the text differs: the element's inner span is replaced, so its tag —
 *   attribute order, quotes — is copied, never rewritten;
 * - `from`/`priority` differ: that one element is rewritten;
 * - extra existing notes are deleted with the line they sit on (as `deleteUnit`);
 * - extra desired notes are appended after the unit's last child, indented
 *   like `<source>` is, in ONE edit — XLIFF 1.2 puts `note*` last.
 *
 * A shorter list only deletes and a longer one only appends, so the edits never
 * overlap. New notes follow Angular's own shape, `<note priority="1"
 * from="description">`, when the unit gives no other example.
 */
export function writeNotes(
  doc: XlfDocument,
  unit: TransUnit,
  desired: readonly NoteSpec[],
  policy: EscapePolicy,
): Edit[] {
  const edits: Edit[] = [];
  const existing = unit.notes;
  const shared = Math.min(existing.length, desired.length);

  for (let i = 0; i < shared; i++) {
    const have = existing[i]!;
    const want = desired[i]!;
    const sameAttrs =
      (have.attrs['from'] ?? null) === want.from && (have.attrs['priority'] ?? null) === want.priority;
    if (sameAttrs && have.text === want.text) continue;
    if (sameAttrs && !have.selfClosing) {
      edits.push({ span: have.innerSpan, replacement: escapeText(want.text, policy), reason: `edit note ${i} of ${unit.id}` });
    } else {
      edits.push({ span: have.span, replacement: noteXml(want, policy), reason: `rewrite note ${i} of ${unit.id}` });
    }
  }

  for (let i = existing.length - 1; i >= desired.length; i--) {
    const note = existing[i]!;
    let start = note.span.start;
    while (start > 0 && (doc.raw[start - 1] === ' ' || doc.raw[start - 1] === '\t')) start--;
    if (doc.raw.startsWith(doc.eol, start - doc.eol.length)) start -= doc.eol.length;
    edits.push({ span: { start, end: note.span.end }, replacement: '', reason: `delete note ${i} of ${unit.id}` });
  }

  if (desired.length > existing.length) {
    const at = lastChildEnd(unit);
    const lead = unit.isInline ? '' : doc.eol + unit.siblingIndent;
    const added = desired
      .slice(existing.length)
      .map((n) => lead + noteXml(n, policy))
      .join('');
    edits.push({ span: { start: at, end: at }, replacement: added, reason: `add notes to ${unit.id}` });
  }
  return edits;
}

/** The default attributes a note added in the app gets, following its siblings. */
export function newNotePriority(unit: TransUnit): string | null {
  if (unit.notes.length === 0) return '1'; // what `ng extract-i18n` writes
  return unit.notes.some((n) => n.attrs['priority'] !== undefined) ? (unit.notes[0]!.attrs['priority'] ?? '1') : null;
}

function noteXml(note: NoteSpec, policy: EscapePolicy): string {
  const priority = note.priority === null ? '' : ` priority="${escapeText(note.priority, policy)}"`;
  const from = note.from === null ? '' : ` from="${escapeText(note.from, policy)}"`;
  return `<note${priority}${from}>${escapeText(note.text, policy)}</note>`;
}

/** Where a child appended to the unit goes: after its last note, context group, target or source. */
function lastChildEnd(unit: TransUnit): number {
  return Math.max(
    unit.source.span.end,
    unit.target?.span.end ?? 0,
    ...unit.contextGroups.map((g) => g.span.end),
    ...unit.notes.map((n) => n.span.end),
  );
}

/* ---- FR-1.9: units and files that do not exist yet ------------------------ */

/**
 * The `<trans-unit>` text to put into a translation file, built from the source
 * file's own bytes.
 *
 * COPIED, not regenerated. The unit's whole span is taken verbatim and the
 * `<target>` is spliced into the copy with the same `writeTarget` an existing
 * unit would use — so `equiv-text` escaping, attribute order, note order and
 * `<context-group>` contents survive because they are never re-serialized.
 * Apart from `sourceUnitXml` — a brand-new key has no unit to copy — there is no
 * `<trans-unit>` writer in this package, by design.
 *
 * The result is NOT indented for any particular file; `insertUnit` re-indents it
 * for the one it is going into.
 */
export function unitSkeleton(
  sourceDoc: XlfDocument,
  sourceUnit: TransUnit,
  innerXml: string,
  options: WriteTargetOptions = {},
): string {
  const text = sourceDoc.raw.slice(sourceUnit.span.start, sourceUnit.span.end);
  // The target edits are expressed against the whole document, so they are
  // rebased onto the substring before being applied to it.
  const offset = sourceUnit.span.start;
  const rebased = writeTarget(sourceDoc, sourceUnit, innerXml, options).map((edit) => ({
    ...edit,
    span: { start: edit.span.start - offset, end: edit.span.end - offset },
  }));
  return applyEdits(text, rebased);
}

/** What the grid's "New key…" states: plain source text, and Angular's notes. */
export interface SourceUnitSpec {
  readonly id: string;
  readonly source: string;
  readonly notes: readonly NoteSpec[];
}

/**
 * The `<trans-unit>` for a key that exists nowhere yet, for the SOURCE file.
 *
 * The one place a unit is written rather than copied: there is nothing to copy
 * it from. It takes the shape `ng extract-i18n` gives a unit — `datatype="html"`,
 * `<source>`, then `<note priority="1" from="…">` — so the next extraction
 * finds what it would have written itself and the diff stays quiet.
 *
 * The step between `<trans-unit>` and its children is read from the file, as
 * is the line ending; the unit's own indentation is `insertUnit`'s business.
 * In a source-locale file whose units carry a `<target>` (some toolchains
 * write one equal to the source), the new unit gets one too.
 */
export function sourceUnitXml(
  doc: XlfDocument,
  file: XlfFile,
  spec: SourceUnitSpec,
  policy: EscapePolicy,
): string {
  const step = childStepOf(doc, file);
  const source = escapeText(spec.source, policy);
  const children = [`<source>${source}</source>`];
  if (file.units.some((unit) => unit.target !== undefined)) children.push(`<target>${source}</target>`);
  for (const note of spec.notes) children.push(noteXml(note, policy));

  return [
    `<trans-unit id="${escapeText(spec.id, policy)}" datatype="html">`,
    ...children.map((child) => step + child),
    '</trans-unit>',
  ].join(doc.eol);
}

/**
 * Where a new unit goes so a file sorted by id stays sorted: after the unit with
 * the greatest id still before it. Undefined means "first in the body" — the
 * same reading `insertUnit` gives a missing `after`. In an unsorted file this is
 * still the nearest neighbour by id, which is the least surprising place.
 */
export function insertionAnchor(file: XlfFile, id: string): TransUnit | undefined {
  let best: TransUnit | undefined;
  for (const unit of file.units) {
    if (unit.id.localeCompare(id) >= 0) continue;
    if (best === undefined || unit.id.localeCompare(best.id) > 0) best = unit;
  }
  return best;
}

/** The indentation a unit's children sit at, relative to the unit itself. */
function childStepOf(doc: XlfDocument, file: XlfFile): string {
  for (const unit of file.units) {
    if (unit.isInline) continue;
    const own = indentBefore(doc.raw, unit.span.start);
    if (unit.siblingIndent.startsWith(own) && unit.siblingIndent.length > own.length) {
      return unit.siblingIndent.slice(own.length);
    }
  }
  const fileIndent = indentBefore(doc.raw, file.openTagSpan.start);
  return fileIndent === '' ? '  ' : fileIndent;
}

/**
 * Splice a `<trans-unit>` into a file's `<body>` (FR-1.9).
 *
 * `after` is the unit it should follow; omitted means "first in the body". The
 * caller chooses it, because only the caller knows the source file's order —
 * and keeping the target file in that order is what stops a translation file
 * from slowly becoming a pile in insertion order, which is unreviewable.
 *
 * Indentation comes from the file being written, never from the file the unit
 * was copied out of: the two are usually identical, and when they are not, the
 * result must match its new home.
 */
export function insertUnit(
  doc: XlfDocument,
  file: XlfFile,
  unitXml: string,
  after?: TransUnit,
): Edit[] {
  const body = file.bodyInnerSpan;
  if (body === undefined) {
    throw new Error('cannot insert a unit into a <file> that has no <body>');
  }

  const anchor = after ?? file.units[file.units.length - 1];
  const indent = unitIndentOf(doc, file);
  const text = reindent(unitXml, indent, doc.eol);

  /**
   * Three positions, and the empty `<body>` is the one that is easy to get
   * wrong — it is also the common one, because it is what a freshly created
   * locale file looks like (FR-1.9).
   *
   * Inserting at the END of an empty body writes the unit AFTER the newline and
   * indentation that belong to the closing tag, which leaves a line of trailing
   * whitespace behind and puts `</trans-unit></body>` on one line. Inserting at
   * the START borrows the closing tag's own whitespace as the separator, which
   * is exactly what the file already has.
   */
  const at =
    after !== undefined
      ? after.span.end
      : (file.units[0]?.span.start ?? body.start);

  // Before the first unit: the unit, then the whitespace that used to precede
  // it. Otherwise: the separator first. Both add whole lines and leave every
  // existing line untouched, which is what makes the diff an addition.
  const replacement =
    after !== undefined || file.units.length === 0
      ? doc.eol + indent + text
      : text + doc.eol + indent;

  return [
    {
      span: { start: at, end: at },
      replacement,
      reason: `insert unit${anchor === undefined ? '' : ` after ${anchor.id}`}`,
    },
  ];
}

/**
 * The indentation a `<trans-unit>` sits at in this file.
 *
 * Read from an existing unit where there is one, because reproducing what the
 * file actually does beats deriving it from a nesting depth (the same reason
 * `siblingIndent` exists). An empty `<body>` — the file this module just
 * created — has none to read, so the body's own indentation plus one step is
 * the best available guess, and the step is taken from the file itself.
 */
function unitIndentOf(doc: XlfDocument, file: XlfFile): string {
  const first = file.units[0];
  if (first !== undefined) return indentBefore(doc.raw, first.span.start);

  // `<file>` sits one step in from `<xliff>`, and a unit two further — so the
  // file element's own indentation IS one step, whatever the file indents by.
  const fileIndent = indentBefore(doc.raw, file.openTagSpan.start);
  const step = fileIndent === '' ? '  ' : fileIndent;
  return fileIndent + step + step;
}

/** The run of spaces and tabs immediately before `at`, back to the line start. */
function indentBefore(raw: string, at: number): string {
  let start = at;
  while (start > 0 && (raw[start - 1] === ' ' || raw[start - 1] === '\t')) start--;
  return raw.slice(start, at);
}

/**
 * Re-indent a copied unit for its new file, and normalise its line endings.
 *
 * The unit's OWN base indentation is the indent of its last line — the one
 * carrying `</trans-unit>` — so every other line's depth relative to it is just
 * the rest of its leading whitespace. Swapping that base for the target file's
 * therefore preserves the shape exactly, whatever the two files indent by, and
 * needs no guess about what one step is worth. Guessing was the first attempt,
 * and it moved `</trans-unit>` four columns.
 *
 * The first line carries no indentation: the caller has just written it.
 */
function reindent(unitXml: string, indent: string, eol: '\n' | '\r\n'): string {
  const lines = unitXml.split(/\r\n|\n/);
  const first = lines[0] ?? '';
  if (lines.length === 1) return first;

  const base = leadingSpace(lines[lines.length - 1] ?? '');
  const rest = lines.slice(1).map((line) => {
    const own = leadingSpace(line);
    // A line indented less than the unit's own base is not something this can
    // reason about — a hand-wrapped attribute, say — so it is left alone.
    return own.startsWith(base) ? indent + own.slice(base.length) + line.slice(own.length) : line;
  });

  return [first, ...rest].join(eol);
}

const leadingSpace = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/**
 * A translation file for a locale that has none (FR-1.9).
 *
 * Built by copying the source document and emptying it rather than by
 * templating a new one, so the prolog, the unprefixed namespace declaration,
 * the `<file>` attribute order, the indentation, the line endings and the BOM
 * all match the rest of the project by construction. A generated file is
 * usually recognisable at a glance; this one should not be.
 */
export function localeFileSkeleton(sourceDoc: XlfDocument, targetLanguage: string): string {
  const edits: Edit[] = [];
  for (const file of sourceDoc.files) {
    edits.push(...setFileAttr(sourceDoc, file, 'target-language', targetLanguage));
    for (const unit of file.units) edits.push(...deleteUnit(sourceDoc, unit));
  }
  return serialize(sourceDoc, edits);
}
