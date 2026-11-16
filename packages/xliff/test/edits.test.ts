// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { scan } from '../src/scan.js';
import {
  insertionAnchor,
  insertUnit,
  localeFileSkeleton,
  serialize,
  sourceUnitXml,
  unitSkeleton,
  writeTarget,
} from '../src/edits.js';
import { verifyComposable } from '../src/verify.js';
import { segmentsOf, editedText, type Segment } from '../src/segments.js';

const doc = (body: string): string =>
  '<?xml version="1.0" encoding="UTF-8" ?>\n' +
  '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n' +
  '  <file source-language="en-GB" datatype="plaintext" original="ng2.template">\n' +
  '    <body>\n' +
  body +
  '\n    </body>\n  </file>\n</xliff>\n';

const unitOf = (text: string) => {
  const parsed = scan(text);
  const unit = parsed.files[0]?.units[0];
  if (unit === undefined) throw new Error('no unit');
  return { parsed, unit };
};

/**
 * The self-closed `<target/>` branch of `writeTarget`.
 *
 * `ng-extract-i18n-merge` emits `<target state="new"/>` routinely, so expanding
 * one is a normal case. It used to drop the `state` attribute whenever the
 * caller passed no state — data loss in the common path, and contrary to what
 * the option's own doc comment promises.
 */
describe('writeTarget on a self-closed <target/>', () => {
  const raw = doc('      <trans-unit id="a" datatype="html"><source>Hi</source><target state="new"/></trans-unit>');

  it('keeps an existing state when the caller passes none', () => {
    const { parsed, unit } = unitOf(raw);
    const out = serialize(parsed, writeTarget(parsed, unit, 'Hallo'));
    expect(out).toContain('<target state="new">Hallo</target>');
  });

  it('replaces the state when given one', () => {
    const { parsed, unit } = unitOf(raw);
    const out = serialize(parsed, writeTarget(parsed, unit, 'Hallo', { state: 'translated' }));
    expect(out).toContain('<target state="translated">Hallo</target>');
    expect(out).not.toContain('state="new"');
  });

  it('removes the state when given null', () => {
    const { parsed, unit } = unitOf(raw);
    const out = serialize(parsed, writeTarget(parsed, unit, 'Hallo', { state: null }));
    expect(out).toContain('<target>Hallo</target>');
  });

  it('keeps every other attribute byte for byte', () => {
    const withAttrs = doc(
      '      <trans-unit id="a"><source>Hi</source><target xml:space=\'preserve\' state="new"/></trans-unit>',
    );
    const { parsed, unit } = unitOf(withAttrs);
    const out = serialize(parsed, writeTarget(parsed, unit, 'Hallo'));
    expect(out).toContain("xml:space='preserve'");
  });
});

describe('writeTarget when no <target> exists', () => {
  it('creates one after <source>, on its own line, at the sibling indent', () => {
    const raw = doc(
      '      <trans-unit id="a" datatype="html">\n        <source>Hi</source>\n      </trans-unit>',
    );
    const { parsed, unit } = unitOf(raw);
    const out = serialize(parsed, writeTarget(parsed, unit, 'Hallo'));

    expect(out).toContain('\n        <source>Hi</source>\n        <target>Hallo</target>\n');
    // Whole lines added, none removed — the NFR-8 shape of a target creation.
    const before = raw.split('\n');
    const after = out.split('\n');
    expect(after.length).toBe(before.length + 1);
    expect(before.every((line) => after.includes(line))).toBe(true);
  });

  it('writes no state attribute when the caller passes none', () => {
    const raw = doc('      <trans-unit id="a"><source>Hi</source></trans-unit>');
    const { parsed, unit } = unitOf(raw);
    expect(serialize(parsed, writeTarget(parsed, unit, 'Hallo'))).toContain('<target>Hallo</target>');
  });
});

describe('verifyComposable', () => {
  const sourceOf = (inner: string): Segment[] => {
    const raw = doc(`      <trans-unit id="a"><source>${inner}</source></trans-unit>`);
    const { parsed, unit } = unitOf(raw);
    return segmentsOf(parsed.raw, unit.source.innerSpan);
  };

  it('accepts segments that read back as the placeholders they went in as', () => {
    const segments = sourceOf('You have <x id="INTERPOLATION" equiv-text="{{ n }}"/> invoices');
    expect(verifyComposable(segments, ['INTERPOLATION'])).toBeUndefined();
  });

  it('accepts a reordering, because moving a chip is legal', () => {
    const segments = sourceOf('You have <x id="INTERPOLATION" equiv-text="{{ n }}"/> invoices');
    expect(verifyComposable([...segments].reverse(), ['INTERPOLATION'])).toBeUndefined();
  });

  it('rejects a placeholder that went missing', () => {
    const segments = sourceOf('You have <x id="INTERPOLATION" equiv-text="{{ n }}"/> invoices');
    const textOnly = segments.filter((s) => s.k === 't');
    expect(verifyComposable(textOnly, ['INTERPOLATION'])).toMatch(/instead of/);
  });

  it('rejects bytes that are individually complete but collectively invalid XML', () => {
    // A <g> whose boundaries are swapped: every token is present and unique, and
    // the result is still `</g>…<g>`. This is the case an id count cannot catch.
    const raw = doc('      <trans-unit id="a"><source><g id="b">bold</g></source></trans-unit>');
    const { parsed, unit } = unitOf(raw);
    const [group] = segmentsOf(parsed.raw, unit.source.innerSpan);
    if (group === undefined || group.k !== 'g') throw new Error('expected a group');

    const swapped: Segment[] = [
      { k: 't', v: '' },
      { ...group, openRaw: group.closeRaw, closeRaw: group.openRaw },
    ];
    expect(verifyComposable(swapped, ['b'])).toMatch(/not well-formed|could not be read back/);
  });

  it('re-escapes edited text rather than trusting it', () => {
    const segments: Segment[] = [editedText('a < b & c')];
    expect(verifyComposable(segments, [])).toBeUndefined();
  });
});

/**
 * FR-1.9 — a unit that is not in the target file at all.
 *
 * Without `ng-extract-i18n-merge` (which this project does not use), a new
 * English string lands only in `messages.xlf`; the translation files are
 * hand-maintained copies and simply do not have it. So "translate this string
 * into Polish" routinely means "put the string into the Polish file first",
 * and a tool that refuses is a tool that cannot draft the very units it exists
 * to draft.
 *
 * The unit is COPIED from the source file rather than regenerated, for the same
 * reason every other write in this package copies: `equiv-text` escaping, note
 * order and attribute order all survive by construction rather than by care.
 */
describe('insertUnit', () => {
  const sourceRaw = doc(
    [
      '      <trans-unit id="a" datatype="html">',
      '        <source>Pay now</source>',
      '        <context-group purpose="location">',
      '          <context context-type="sourcefile">src/app/pay.html</context>',
      '          <context context-type="linenumber">7</context>',
      '        </context-group>',
      '        <note priority="1" from="description">The checkout button. Tom &amp; Jerry.</note>',
      '      </trans-unit>',
      '      <trans-unit id="b" datatype="html">',
      '        <source>Cancel</source>',
      '      </trans-unit>',
    ].join('\n'),
  );

  /** A target file that has `b` but not `a`. */
  const targetRaw = doc(
    ['      <trans-unit id="b" datatype="html">', '        <source>Cancel</source>', '        <target>Abbrechen</target>', '      </trans-unit>'].join('\n'),
  );

  const parts = () => {
    const source = scan(sourceRaw);
    const target = scan(targetRaw);
    return {
      source,
      target,
      sourceUnit: source.files[0]!.units[0]!,
      targetFile: target.files[0]!,
      targetUnitB: target.files[0]!.units[0]!,
    };
  };

  it('inserts a unit carrying the translation, and reads back as valid XLIFF', () => {
    const { source, target, sourceUnit, targetFile } = parts();
    const xml = unitSkeleton(source, sourceUnit, 'Jetzt bezahlen');
    const out = serialize(target, insertUnit(target, targetFile, xml));

    // No anchor means "first in the body", which is what the caller wants when
    // the new unit comes first in the SOURCE file's order.
    const units = scan(out).files[0]!.units;
    expect(units.map((u) => u.id)).toEqual(['a', 'b']);
    expect(units[0]!.targetPlain).toBe('Jetzt bezahlen');
    expect(units[0]!.sourcePlain).toBe('Pay now');
  });

  it('copies the notes and context groups byte for byte, escaping included', () => {
    const { source, target, sourceUnit, targetFile } = parts();
    const out = serialize(
      target,
      insertUnit(target, targetFile, unitSkeleton(source, sourceUnit, 'Jetzt bezahlen')),
    );
    expect(out).toContain('<note priority="1" from="description">The checkout button. Tom &amp; Jerry.</note>');
    expect(out).toContain('<context context-type="linenumber">7</context>');
  });

  it('puts the unit after the anchor it is given, so the file keeps source order', () => {
    const { source, target, sourceUnit, targetFile, targetUnitB } = parts();
    const xml = unitSkeleton(source, sourceUnit, 'Jetzt bezahlen');

    const atEnd = scan(serialize(target, insertUnit(target, targetFile, xml, targetUnitB)));
    expect(atEnd.files[0]!.units.map((u) => u.id)).toEqual(['b', 'a']);

    const atStart = scan(serialize(target, insertUnit(target, targetFile, xml)));
    expect(atStart.files[0]!.units.map((u) => u.id)).toEqual(['a', 'b']);
  });

  it('adds whole lines and removes none — the diff is an addition, nothing else', () => {
    const { source, target, sourceUnit, targetFile } = parts();
    const out = serialize(
      target,
      insertUnit(target, targetFile, unitSkeleton(source, sourceUnit, 'Jetzt bezahlen')),
    );
    const before = targetRaw.split('\n');
    const after = out.split('\n');
    // The unit's eight lines, plus the `<target>` written onto its own line.
    expect(after.length).toBe(before.length + 9);
    // Every original line survives, in order: the insert touched nothing else.
    expect(after.filter((line) => before.includes(line)).length).toBeGreaterThanOrEqual(before.length);
  });

  it('re-indents to the file it is going into, not the file it came from', () => {
    // A target file indented with two spaces per level rather than the source's four.
    const flat =
      '<?xml version="1.0" encoding="UTF-8" ?>\n' +
      '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n' +
      '<file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="de">\n' +
      '<body>\n' +
      '  <trans-unit id="b" datatype="html">\n' +
      '    <source>Cancel</source>\n' +
      '  </trans-unit>\n' +
      '</body>\n</file>\n</xliff>\n';

    const source = scan(sourceRaw);
    const targetDoc = scan(flat);
    const file = targetDoc.files[0]!;
    const out = serialize(
      targetDoc,
      insertUnit(targetDoc, file, unitSkeleton(source, source.files[0]!.units[0]!, 'Jetzt bezahlen'), file.units[0]!),
    );

    expect(out).toContain('\n  <trans-unit id="a" datatype="html">\n    <source>Pay now</source>');
    expect(scan(out).files[0]!.units.map((u) => u.id)).toEqual(['b', 'a']);
  });

  it('keeps the line endings the document already had', () => {
    const source = scan(sourceRaw.replace(/\n/g, '\r\n'));
    const targetDoc = scan(targetRaw.replace(/\n/g, '\r\n'));
    const out = serialize(
      targetDoc,
      insertUnit(targetDoc, targetDoc.files[0]!, unitSkeleton(source, source.files[0]!.units[0]!, 'Jetzt bezahlen')),
    );
    expect(out).not.toMatch(/[^\r]\n/);
    expect(scan(out).files[0]!.units).toHaveLength(2);
  });

  it('writes a state only when asked', () => {
    const { source, target, sourceUnit, targetFile } = parts();
    const plain = serialize(target, insertUnit(target, targetFile, unitSkeleton(source, sourceUnit, 'X')));
    expect(plain).toContain('<target>X</target>');

    const stated = serialize(
      target,
      insertUnit(target, targetFile, unitSkeleton(source, sourceUnit, 'X', { state: 'needs-review-translation' })),
    );
    expect(stated).toContain('<target state="needs-review-translation">X</target>');
  });
});

/**
 * The other half of FR-1.9: a locale with no file at all.
 *
 * Built by COPYING the source document and emptying it, rather than by
 * templating a new one. The prolog, the unprefixed namespace, the `<file>`
 * attribute order, the indentation and the line endings then match the rest of
 * the project by construction — which is the whole reason a generated file is
 * usually recognisable at a glance, and this one is not.
 */
describe('localeFileSkeleton', () => {
  const sourceRaw = doc(
    [
      '      <trans-unit id="a" datatype="html">',
      '        <source>Pay now</source>',
      '      </trans-unit>',
      '      <trans-unit id="b" datatype="html">',
      '        <source>Cancel</source>',
      '      </trans-unit>',
    ].join('\n'),
  );

  it('is an empty, valid XLIFF file for the new locale', () => {
    const out = localeFileSkeleton(scan(sourceRaw), 'pl');
    const parsed = scan(out);
    expect(parsed.files[0]!.units).toHaveLength(0);
    expect(parsed.files[0]!.attrs['target-language']).toBe('pl');
    expect(parsed.files[0]!.attrs['source-language']).toBe('en-GB');
  });

  it('keeps the prolog, the namespace and the trailing newline as the source has them', () => {
    const out = localeFileSkeleton(scan(sourceRaw), 'pl');
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8" ?>\n')).toBe(true);
    expect(out).toContain('xmlns="urn:oasis:names:tc:xliff:document:1.2"');
    expect(out.endsWith('</xliff>\n')).toBe(true);
    expect(out).not.toContain('<trans-unit');
  });

  it('replaces a stale target-language rather than adding a second one', () => {
    const de = doc('      <trans-unit id="a" datatype="html"><source>Hi</source><target>Hallo</target></trans-unit>')
      .replace('original="ng2.template"', 'original="ng2.template" target-language="de"');
    const out = localeFileSkeleton(scan(de), 'pl');
    expect(out.match(/target-language=/g)).toHaveLength(1);
    expect(scan(out).files[0]!.attrs['target-language']).toBe('pl');
  });

  it('carries the line endings and the BOM of the file it was copied from', () => {
    const out = localeFileSkeleton(scan('﻿' + sourceRaw.replace(/\n/g, '\r\n')), 'pl');
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).not.toMatch(/[^\r]\n/);
  });
});

/**
 * The shape a freshly created locale file is in (FR-1.9), and the case the
 * first implementation got wrong: inserting at the END of an empty `<body>`
 * writes the unit after the whitespace belonging to the closing tag, leaving a
 * line of trailing spaces and `</trans-unit></body>` on one line.
 */
describe('insertUnit into an empty <body>', () => {
  const sourceRaw = doc('      <trans-unit id="a" datatype="html">\n        <source>Pay now</source>\n      </trans-unit>');

  it('produces a file indented exactly like one the generator would have written', () => {
    const source = scan(sourceRaw);
    const empty = scan(localeFileSkeleton(source, 'pl'));
    const out = serialize(
      empty,
      insertUnit(empty, empty.files[0]!, unitSkeleton(source, source.files[0]!.units[0]!, 'Zapłać')),
    );

    expect(out).toBe(
      '<?xml version="1.0" encoding="UTF-8" ?>\n' +
        '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n' +
        '  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="pl">\n' +
        '    <body>\n' +
        '      <trans-unit id="a" datatype="html">\n' +
        '        <source>Pay now</source>\n' +
        '        <target>Zapłać</target>\n' +
        '      </trans-unit>\n' +
        '    </body>\n' +
        '  </file>\n' +
        '</xliff>\n',
    );
  });

  it('leaves no line with trailing whitespace', () => {
    const source = scan(sourceRaw);
    const empty = scan(localeFileSkeleton(source, 'pl'));
    const out = serialize(
      empty,
      insertUnit(empty, empty.files[0]!, unitSkeleton(source, source.files[0]!.units[0]!, 'Zapłać')),
    );
    expect(out.split('\n').filter((line) => /[ \t]+$/.test(line))).toEqual([]);
  });

  it('takes a second unit after the first, not before it', () => {
    const two = scan(
      doc(
        '      <trans-unit id="a" datatype="html">\n        <source>Pay now</source>\n      </trans-unit>\n' +
          '      <trans-unit id="b" datatype="html">\n        <source>Cancel</source>\n      </trans-unit>',
      ),
    );
    const empty = scan(localeFileSkeleton(two, 'pl'));
    const first = serialize(
      empty,
      insertUnit(empty, empty.files[0]!, unitSkeleton(two, two.files[0]!.units[0]!, 'Zapłać')),
    );
    const withOne = scan(first);
    const out = serialize(
      withOne,
      insertUnit(
        withOne,
        withOne.files[0]!,
        unitSkeleton(two, two.files[0]!.units[1]!, 'Anuluj'),
        withOne.files[0]!.units[0],
      ),
    );
    expect(scan(out).files[0]!.units.map((u) => u.id)).toEqual(['a', 'b']);
    expect(out.split('\n').filter((line) => /[ \t]+$/.test(line))).toEqual([]);
  });
});

/**
 * `xml:lang` on `<target>` (reported from use).
 *
 * The XLIFF these fixtures otherwise emit is Angular's, which writes no
 * `xml:lang` anywhere — so the attribute had no coverage at all until a real
 * project turned up carrying it on every `<source>` and `<target>`. In that
 * shape a unit Lexi CREATED in `de-DE.xlf` inherited the source unit's whole
 * `<target …>` open tag, and so declared a German translation to be English.
 *
 * The rule the fix follows is "match the file's own convention": correct an
 * `xml:lang` that is there, add one only where the unit's own `<source>` has
 * one, and never introduce the attribute into a file that does not use it.
 */
describe('xml:lang on a written target', () => {
  const langDoc = (targetLanguage: string, body: string): string =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">\n' +
    `  <file original="ng2.template" datatype="plaintext" source-language="en-GB" target-language="${targetLanguage}">\n` +
    '    <body>\n' +
    body +
    '\n    </body>\n  </file>\n</xliff>\n';

  const SOURCE_UNIT = [
    '      <trans-unit id="additionalPrivacyFooter">',
    '        <source xml:lang="en-GB">Additional Privacy Information</source>',
    '        <target xml:lang="en-GB">Additional Privacy Information</target>',
    '        <note>Links to some extra privacy notices</note>',
    '      </trans-unit>',
  ].join('\n');

  it('gives a CREATED unit the target locale, not the source file’s', () => {
    const source = scan(langDoc('en-GB', SOURCE_UNIT));
    const target = scan(langDoc('de-DE', ''));
    const xml = unitSkeleton(source, source.files[0]!.units[0]!, 'Zusätzliche Datenschutzhinweise', {
      targetLanguage: 'de-DE',
    });
    const out = serialize(target, insertUnit(target, target.files[0]!, xml));

    expect(out).toContain('<target xml:lang="de-DE">Zusätzliche Datenschutzhinweise</target>');
    // The SOURCE keeps its own language: it really is the English text.
    expect(out).toContain('<source xml:lang="en-GB">Additional Privacy Information</source>');
  });

  it('corrects a stale xml:lang on a target it is already rewriting', () => {
    const raw = langDoc('de-DE', SOURCE_UNIT.replace('>Additional Privacy Information</target>', '>Alt</target>'));
    const parsed = scan(raw);
    const out = serialize(
      parsed,
      writeTarget(parsed, parsed.files[0]!.units[0]!, 'Test', { targetLanguage: 'de-DE' }),
    );
    expect(out).toContain('<target xml:lang="de-DE">Test</target>');
  });

  it('leaves the bytes alone when the xml:lang is already right', () => {
    const raw = langDoc(
      'de-DE',
      SOURCE_UNIT.replace('<target xml:lang="en-GB">Additional Privacy Information</target>', '<target xml:lang="de-DE">Alt</target>'),
    );
    const parsed = scan(raw);
    const edits = writeTarget(parsed, parsed.files[0]!.units[0]!, 'Test', { targetLanguage: 'de-DE' });
    // One edit, the content. An attribute edit that changes nothing is still a
    // line in somebody's diff.
    expect(edits).toHaveLength(1);
  });

  it('never introduces xml:lang into a file that does not use it', () => {
    // Angular's own output, which is what most projects have.
    const { parsed, unit } = unitOf(
      doc(['      <trans-unit id="a" datatype="html">', '        <source>Pay now</source>', '        <target>Zahlen</target>', '      </trans-unit>'].join('\n')),
    );
    const out = serialize(parsed, writeTarget(parsed, unit, 'Jetzt bezahlen', { targetLanguage: 'de-DE' }));
    expect(out).not.toContain('xml:lang');
  });

  it('gives a target it creates the same treatment as its sibling source', () => {
    // No `<target>` at all, but the `<source>` carries `xml:lang` — so the file
    // uses the attribute and a created target without one would be the odd one out.
    const raw = langDoc(
      'de-DE',
      [
        '      <trans-unit id="a">',
        '        <source xml:lang="en-GB">Pay now</source>',
        '      </trans-unit>',
      ].join('\n'),
    );
    const parsed = scan(raw);
    const out = serialize(
      parsed,
      writeTarget(parsed, parsed.files[0]!.units[0]!, 'Jetzt bezahlen', { targetLanguage: 'de-DE' }),
    );
    expect(out).toContain('<target xml:lang="de-DE">Jetzt bezahlen</target>');
  });

  it('corrects xml:lang when it expands a self-closed target too', () => {
    const raw = langDoc(
      'de-DE',
      [
        '      <trans-unit id="a">',
        '        <source xml:lang="en-GB">Pay now</source>',
        '        <target xml:lang="en-GB" state="new"/>',
        '      </trans-unit>',
      ].join('\n'),
    );
    const parsed = scan(raw);
    const out = serialize(
      parsed,
      writeTarget(parsed, parsed.files[0]!.units[0]!, 'Jetzt bezahlen', { targetLanguage: 'de-DE' }),
    );
    expect(out).toContain('xml:lang="de-DE"');
    expect(out).not.toContain('xml:lang="en-GB" state');
    // The state it already had must survive the expansion.
    expect(out).toContain('state="new"');
  });
});

/**
 * "New key…" in the grid: the one unit written from scratch, into the SOURCE
 * file, at the place a file sorted by id expects it.
 */
describe('sourceUnitXml + insertionAnchor', () => {
  const unit = (id: string, source: string) =>
    [`      <trans-unit id="${id}" datatype="html">`, `        <source>${source}</source>`, '      </trans-unit>'].join('\n');
  const sourceRaw = doc([unit('a.first', 'First'), unit('c.third', 'Third')].join('\n'));

  const add = (raw: string, id: string, source = 'Hello', notes: { from: string; text: string }[] = []) => {
    const parsed = scan(raw);
    const file = parsed.files[0]!;
    const xml = sourceUnitXml(
      parsed,
      file,
      { id, source, notes: notes.map((n) => ({ from: n.from, priority: '1', text: n.text })) },
      'angular',
    );
    return serialize(parsed, insertUnit(parsed, file, xml, insertionAnchor(file, id)));
  };

  it('inserts between its neighbours by id, as a pure addition', () => {
    const out = add(sourceRaw, 'b.second', 'Second');
    expect(scan(out).files[0]!.units.map((u) => u.id)).toEqual(['a.first', 'b.second', 'c.third']);
    expect(out).toBe(doc([unit('a.first', 'First'), unit('b.second', 'Second'), unit('c.third', 'Third')].join('\n')));
  });

  it('goes first when every id sorts after it, and last when none does', () => {
    expect(scan(add(sourceRaw, '0.zero')).files[0]!.units.map((u) => u.id)).toEqual(['0.zero', 'a.first', 'c.third']);
    expect(scan(add(sourceRaw, 'z.last')).files[0]!.units.map((u) => u.id)).toEqual(['a.first', 'c.third', 'z.last']);
  });

  it('writes notes the way ng extract-i18n does, escaped', () => {
    const out = add(sourceRaw, 'b.second', 'Tom & "Jerry"', [
      { from: 'description', text: 'A <b>button</b>' },
      { from: 'meaning', text: 'checkout' },
    ]);
    expect(out).toContain(
      [
        '      <trans-unit id="b.second" datatype="html">',
        '        <source>Tom &amp; &quot;Jerry&quot;</source>',
        '        <note priority="1" from="description">A &lt;b&gt;button&lt;/b&gt;</note>',
        '        <note priority="1" from="meaning">checkout</note>',
        '      </trans-unit>',
      ].join('\n'),
    );
    const created = scan(out).files[0]!.units.find((u) => u.id === 'b.second')!;
    expect(created.sourcePlain).toBe('Tom & "Jerry"');
    expect(created.notes.map((n) => n.text)).toEqual(['A <b>button</b>', 'checkout']);
  });

  it('follows the file’s own indentation step and line endings', () => {
    const tabs = doc('\t\t\t<trans-unit id="a" datatype="html">\n\t\t\t\t<source>A</source>\n\t\t\t</trans-unit>').replace(/\n/g, '\r\n');
    const out = add(tabs, 'b');
    expect(out).toContain('\t\t\t<trans-unit id="b" datatype="html">\r\n\t\t\t\t<source>Hello</source>\r\n\t\t\t</trans-unit>');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('works in an empty <body>', () => {
    const empty = scan(localeFileSkeleton(scan(sourceRaw), 'en-GB'));
    const file = empty.files[0]!;
    const xml = sourceUnitXml(empty, file, { id: 'x', source: 'X', notes: [] }, 'angular');
    const out = serialize(empty, insertUnit(empty, file, xml, insertionAnchor(file, 'x')));
    expect(out).toContain('    <body>\n      <trans-unit id="x" datatype="html">\n        <source>X</source>\n      </trans-unit>\n    </body>');
  });

  it('mirrors the source as a <target> when the file’s units carry one', () => {
    const withTargets = doc('      <trans-unit id="a" datatype="html">\n        <source>A</source>\n        <target>A</target>\n      </trans-unit>');
    const created = scan(add(withTargets, 'b')).files[0]!.units.find((u) => u.id === 'b')!;
    expect(created.targetPlain).toBe('Hello');
  });
});
