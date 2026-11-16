// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { scan } from '../src/scan.js';
import { newNotePriority, serialize, writeNotes, type NoteSpec } from '../src/edits.js';
import { lineDiff } from './diff.js';

/**
 * FR-4.2: notes edited in the app are spliced into the file, so a changed note
 * is a changed line and nothing else moves (NFR-8) — the same promise targets
 * keep.
 */

const doc = (units: string): string =>
  '<?xml version="1.0" encoding="UTF-8" ?>\n' +
  '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n' +
  '  <file source-language="en-GB" datatype="plaintext" original="ng2.template">\n' +
  '    <body>\n' +
  units +
  '\n    </body>\n  </file>\n</xliff>\n';

const ANGULAR_UNIT =
  '      <trans-unit id="pay" datatype="html">\n' +
  '        <source>Pay now</source>\n' +
  '        <context-group purpose="location">\n' +
  '          <context context-type="sourcefile">src/app/pay.html</context>\n' +
  '          <context context-type="linenumber">3</context>\n' +
  '        </context-group>\n' +
  '        <note priority="1" from="description">The checkout button.</note>\n' +
  '        <note priority="1" from="meaning">checkout.pay</note>\n' +
  '      </trans-unit>';

const BARE_UNIT =
  '      <trans-unit id="bare" datatype="html">\n' +
  '        <source>Billing</source>\n' +
  '        <context-group purpose="location">\n' +
  '          <context context-type="sourcefile">src/app/billing.html</context>\n' +
  '        </context-group>\n' +
  '      </trans-unit>';

const apply = (raw: string, desired: (unit: ReturnType<typeof first>) => NoteSpec[]) => {
  const parsed = scan(raw);
  const unit = first(parsed);
  const out = serialize(parsed, writeNotes(parsed, unit, desired(unit), 'angular'));
  return { out, unit: first(scan(out)) };
};
const first = (parsed: ReturnType<typeof scan>) => parsed.files[0]!.units[0]!;
const specOf = (n: { attrs: Readonly<Record<string, string>>; text: string }): NoteSpec => ({
  from: n.attrs['from'] ?? null,
  priority: n.attrs['priority'] ?? null,
  text: n.text,
});

describe('writeNotes', () => {
  it('changes nothing when the notes are what the file says (identity)', () => {
    const raw = doc(ANGULAR_UNIT);
    expect(apply(raw, (u) => u.notes.map(specOf)).out).toBe(raw);
  });

  it('edits a note as a one-line change, keeping its tag byte for byte', () => {
    const raw = doc(ANGULAR_UNIT);
    const { out, unit } = apply(raw, (u) => [
      { ...specOf(u.notes[0]!), text: 'The big green checkout button.' },
      specOf(u.notes[1]!),
    ]);
    expect(lineDiff(raw, out)).toEqual({ added: 1, removed: 1 });
    expect(out).toContain('<note priority="1" from="description">The big green checkout button.</note>');
    expect(unit.notes.map((n) => n.text)).toEqual(['The big green checkout button.', 'checkout.pay']);
  });

  it('adds a note after the last child, indented like its siblings, in Angular\'s shape', () => {
    const raw = doc(BARE_UNIT);
    const { out, unit } = apply(raw, (u) => [
      { from: 'description', priority: newNotePriority(u), text: 'Heading on the billing page' },
    ]);
    expect(lineDiff(raw, out)).toEqual({ added: 1, removed: 0 });
    expect(out).toContain(
      '        </context-group>\n        <note priority="1" from="description">Heading on the billing page</note>\n      </trans-unit>',
    );
    expect(unit.notes).toHaveLength(1);
  });

  it('deletes a note with the line it sat on, leaving no blank line', () => {
    const raw = doc(ANGULAR_UNIT);
    const { out, unit } = apply(raw, (u) => [specOf(u.notes[0]!)]);
    expect(lineDiff(raw, out)).toEqual({ added: 0, removed: 1 });
    expect(out).not.toContain('from="meaning"');
    expect(out).not.toMatch(/\n\s*\n/);
    expect(unit.notes).toHaveLength(1);
  });

  it('escapes what it writes, and reads back exactly what was typed', () => {
    const raw = doc(BARE_UNIT);
    const text = 'Shown when <b> & "quotes" appear';
    const { out, unit } = apply(raw, () => [{ from: null, priority: '1', text }]);
    expect(out).toContain('&lt;b&gt; &amp;');
    expect(unit.notes[0]!.text).toBe(text);
    expect(unit.notes[0]!.attrs['from']).toBeUndefined();
  });

  it('rewrites only the one element whose `from` changed', () => {
    const raw = doc(ANGULAR_UNIT);
    const { out } = apply(raw, (u) => [{ ...specOf(u.notes[0]!), from: 'meaning' }, specOf(u.notes[1]!)]);
    expect(lineDiff(raw, out)).toEqual({ added: 1, removed: 1 });
  });
});
