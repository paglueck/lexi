// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { scan, XlfScanError } from '../src/scan.js';
import { sliceSpan } from '../src/model.js';
import { angularXlf, oneUnit, ph } from './fixtures.js';

describe('scan — document level', () => {
  it('detects LF line endings and no BOM', () => {
    const doc = scan(oneUnit({ id: 'a', source: 'Hello' }));
    expect(doc.eol).toBe('\n');
    expect(doc.bom).toBe(false);
  });

  it('detects CRLF line endings', () => {
    const doc = scan(angularXlf({ eol: '\r\n', files: [{ units: [{ id: 'a', source: 'Hello' }] }] }));
    expect(doc.eol).toBe('\r\n');
  });

  it('detects a BOM and keeps it in the raw text', () => {
    const raw = angularXlf({ bom: true, files: [{ units: [{ id: 'a', source: 'Hello' }] }] });
    const doc = scan(raw);
    expect(doc.bom).toBe(true);
    expect(doc.raw.startsWith('﻿')).toBe(true);
  });

  it('keeps the raw text verbatim', () => {
    const raw = oneUnit({ id: 'a', source: 'Hello' });
    expect(scan(raw).raw).toBe(raw);
  });
});

describe('scan — file level', () => {
  it('reads the file attributes, decoded', () => {
    const doc = scan(angularXlf({ files: [{ sourceLanguage: 'en-GB', targetLanguage: 'pt-BR', units: [] }] }));
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0]!.attrs).toMatchObject({
      'source-language': 'en-GB',
      'target-language': 'pt-BR',
      datatype: 'plaintext',
      original: 'ng2.template',
    });
  });

  it('spans the whole <file> element', () => {
    const raw = angularXlf({ files: [{ units: [{ id: 'a', source: 'Hi' }] }] });
    const doc = scan(raw);
    const text = sliceSpan(raw, doc.files[0]!.span);
    expect(text.startsWith('<file ')).toBe(true);
    expect(text.endsWith('</file>')).toBe(true);
  });

  it('handles several <file> elements in one document', () => {
    const doc = scan(angularXlf({
      files: [
        { targetLanguage: 'de', units: [{ id: 'a', source: 'Hi' }] },
        { targetLanguage: 'fr', units: [{ id: 'a', source: 'Hi' }, { id: 'b', source: 'Ho' }] },
      ],
    }));
    expect(doc.files.map((f) => f.units.length)).toEqual([1, 2]);
    expect(doc.files[1]!.attrs['target-language']).toBe('fr');
  });

  it('reports whether any target in the file carries a state attribute', () => {
    const withState = scan(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo', state: 'translated' }));
    const withoutState = scan(oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' }));
    expect(withState.files[0]!.hasAnyStateAttr).toBe(true);
    expect(withoutState.files[0]!.hasAnyStateAttr).toBe(false);
  });
});

describe('scan — trans-unit identity and spans', () => {
  it('reads the unit id and attributes', () => {
    const doc = scan(oneUnit({ id: 'checkout.pay_now', source: 'Pay now' }));
    const unit = doc.files[0]!.units[0]!;
    expect(unit.id).toBe('checkout.pay_now');
    expect(unit.attrs).toMatchObject({ id: 'checkout.pay_now', datatype: 'html' });
  });

  it('decodes an escaped id rather than reporting it raw', () => {
    const raw = oneUnit({ id: `it's & "quoted"`, source: 'x' });
    expect(raw).toContain('&apos;');
    expect(scan(raw).files[0]!.units[0]!.id).toBe(`it's & "quoted"`);
  });

  it('spans the whole <trans-unit> element', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi' });
    const unit = scan(raw).files[0]!.units[0]!;
    const text = sliceSpan(raw, unit.span);
    expect(text.startsWith('<trans-unit ')).toBe(true);
    expect(text.endsWith('</trans-unit>')).toBe(true);
  });

  it('spans the <source> inner XML exactly, placeholders included', () => {
    const source = `You have ${ph.interpolation(0, '{{ n }}')} invoices`;
    const raw = oneUnit({ id: 'a', source });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(sliceSpan(raw, unit.source.innerSpan)).toBe(source);
  });

  it('spans the <target> inner XML exactly', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi', target: 'Hallo Welt', state: 'translated' });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(sliceSpan(raw, unit.target!.innerSpan)).toBe('Hallo Welt');
  });

  it('reports no target when the element is absent', () => {
    const unit = scan(oneUnit({ id: 'a', source: 'Hi' })).files[0]!.units[0]!;
    expect(unit.target).toBeUndefined();
  });

  it('recognises a self-closed <target/>, as ng-extract-i18n-merge writes for new units', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi', targetSelfClosing: true, state: 'new' });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.target).toBeDefined();
    expect(unit.target!.selfClosing).toBe(true);
    expect(unit.target!.attrs['state']).toBe('new');
    expect(sliceSpan(raw, unit.target!.innerSpan)).toBe('');
  });

  it('recognises an empty but paired <target></target>', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi', target: '' });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.target!.selfClosing).toBe(false);
    expect(sliceSpan(raw, unit.target!.innerSpan)).toBe('');
  });

  it('recognises a self-closed <source/>', () => {
    const raw = oneUnit({ id: 'a', source: '' }).replace('<source></source>', '<source/>');
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.source.selfClosing).toBe(true);
  });
});

describe('scan — notes and context groups', () => {
  it('reads notes with their from and priority attributes, in document order', () => {
    const raw = oneUnit({
      id: 'a', source: 'Hi',
      description: 'Shown on the billing page.',
      meaning: 'billing.period-summary',
    });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.notes.map((n) => n.attrs['from'])).toEqual(['description', 'meaning']);
    expect(unit.notes.map((n) => n.attrs['priority'])).toEqual(['1', '1']);
    expect(unit.notes.map((n) => n.text)).toEqual(['Shown on the billing page.', 'billing.period-summary']);
  });

  it('decodes note text', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi', description: `Marek's "note" & more` });
    expect(scan(raw).files[0]!.units[0]!.notes[0]!.text).toBe(`Marek's "note" & more`);
  });

  it('reads context-group location entries', () => {
    const raw = oneUnit({
      id: 'a', source: 'Hi',
      contextGroups: [
        { sourcefile: 'src/app/a.component.html', linenumber: 42 },
        { sourcefile: 'src/app/b.component.html', linenumber: 17 },
      ],
    });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.contextGroups).toHaveLength(2);
    expect(unit.contextGroups[0]!.purpose).toBe('location');
    expect(unit.contextGroups[0]!.sourcefile).toBe('src/app/a.component.html');
    expect(unit.contextGroups[0]!.linenumber).toBe('42');
    expect(unit.contextGroups[1]!.sourcefile).toBe('src/app/b.component.html');
  });

  it('has no notes or context groups when none are written', () => {
    const unit = scan(oneUnit({ id: 'a', source: 'Hi' })).files[0]!.units[0]!;
    expect(unit.notes).toEqual([]);
    expect(unit.contextGroups).toEqual([]);
  });
});

describe('scan — indentation context for inserting a target', () => {
  it('captures the indentation of the <source> line', () => {
    const unit = scan(oneUnit({ id: 'a', source: 'Hi' })).files[0]!.units[0]!;
    expect(unit.siblingIndent).toBe(' '.repeat(8));
    expect(unit.isInline).toBe(false);
  });

  it('captures tab indentation as written', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi' }).replace(/\n {8}<source>/, '\n\t\t\t\t<source>');
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.siblingIndent).toBe('\t\t\t\t');
  });

  it('marks a single-line trans-unit as inline', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi' }).replace(/\n {8}<source>Hi<\/source>/, '<source>Hi</source>');
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.isInline).toBe(true);
    expect(unit.siblingIndent).toBe('');
  });
});

describe('scan — decoded plain text and placeholder inventory', () => {
  it('renders placeholders as their equiv-text in the plain source', () => {
    const raw = oneUnit({ id: 'a', source: `You have ${ph.interpolation(0, '{{ n }}')} invoices` });
    expect(scan(raw).files[0]!.units[0]!.sourcePlain).toBe('You have {{ n }} invoices');
  });

  it('falls back to the placeholder id when there is no equiv-text', () => {
    const raw = oneUnit({ id: 'a', source: 'Before <x id="CUSTOM"/> after' });
    expect(scan(raw).files[0]!.units[0]!.sourcePlain).toBe('Before CUSTOM after');
  });

  it('decodes entities in the plain text', () => {
    const raw = oneUnit({ id: 'a', source: 'Fish &amp; chips &lt;b&gt; &apos;x&apos;' });
    expect(scan(raw).files[0]!.units[0]!.sourcePlain).toBe(`Fish & chips <b> 'x'`);
  });

  it('handles a double-escaped ampersand without losing a level', () => {
    const raw = oneUnit({ id: 'a', source: 'a&amp;amp;b' });
    expect(scan(raw).files[0]!.units[0]!.sourcePlain).toBe('a&amp;b');
  });

  it('collects placeholder ids in document order', () => {
    const source = `${ph.startTag('strong')}${ph.interpolation(0)} x${ph.closeTag('strong')}${ph.interpolation(1)}`;
    const unit = scan(oneUnit({ id: 'a', source })).files[0]!.units[0]!;
    expect(unit.sourcePhIds).toEqual([
      'START_TAG_STRONG', 'INTERPOLATION', 'CLOSE_TAG_STRONG', 'INTERPOLATION_1',
    ]);
  });

  it('collects target placeholder ids and plain text too', () => {
    const raw = oneUnit({
      id: 'a',
      source: `Hello ${ph.interpolation(0, '{{ name }}')}`,
      target: `Hallo ${ph.interpolation(0, '{{ name }}')}`,
    });
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.targetPhIds).toEqual(['INTERPOLATION']);
    expect(unit.targetPlain).toBe('Hallo {{ name }}');
  });
});

describe('scan — well-formedness', () => {
  it('rejects a mismatched closing tag', () => {
    expect(() => scan('<xliff version="1.2"><file></body></xliff>')).toThrow(XlfScanError);
  });

  it('rejects an unclosed element', () => {
    expect(() => scan('<xliff version="1.2"><file>')).toThrow(XlfScanError);
  });

  it('rejects a document whose root is not <xliff>', () => {
    expect(() => scan('<nope/>')).toThrow(/root/i);
  });

  it('points at the element that was left open, not at the stray closing tag', () => {
    // Line 1 <xliff>, line 2 <file>, line 3 </body>. The actionable location is the
    // <file> that never closes, which is also what XML parsers report for this class
    // of error — "unexpected </body>" leaves the reader hunting for the real cause.
    let caught: unknown;
    try {
      scan('<xliff version="1.2">\n  <file>\n  </body>\n</xliff>');
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(XlfScanError);
    expect((caught as XlfScanError).message).toMatch(/<file>.*never closed/);
    expect((caught as XlfScanError).line).toBe(2);
    expect((caught as XlfScanError).column).toBe(3);
  });
});

describe('scan — tolerance for real-world files', () => {
  it('does not throw on an unknown entity, so a hand-edited file stays openable', () => {
    const raw = oneUnit({ id: 'a', source: 'x&nbsp;y' });
    expect(() => scan(raw)).not.toThrow();
  });

  it('keeps XML comments in the raw text without disturbing spans', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi' }).replace('<body>', '<body><!-- generated -->');
    const doc = scan(raw);
    expect(doc.files[0]!.units).toHaveLength(1);
    expect(sliceSpan(raw, doc.files[0]!.units[0]!.source.innerSpan)).toBe('Hi');
  });

  it('accepts single-quoted attribute values', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi' }).replace('datatype="html"', "datatype='html'");
    expect(scan(raw).files[0]!.units[0]!.attrs['datatype']).toBe('html');
  });

  it('accepts a CDATA section inside a note', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi', description: 'PLACEHOLDER' })
      .replace('PLACEHOLDER', '<![CDATA[a < b]]>');
    expect(scan(raw).files[0]!.units[0]!.notes[0]!.text).toBe('a < b');
  });

  it('carries an unknown extension element through without complaint', () => {
    const raw = oneUnit({ id: 'a', source: 'Hi', target: 'Hallo' })
      .replace('</trans-unit>', '  <lx:origin xmlns:lx="urn:x">machine</lx:origin>\n      </trans-unit>');
    const unit = scan(raw).files[0]!.units[0]!;
    expect(unit.target).toBeDefined();
    expect(sliceSpan(raw, unit.target!.innerSpan)).toBe('Hallo');
  });
});

describe('scan — the invariant every span must satisfy', () => {
  it('slices every recorded element span back to text that starts with < and ends with >', () => {
    const raw = angularXlf({
      files: [{
        targetLanguage: 'de',
        units: [
          { id: 'a', source: `Hi ${ph.interpolation(0)}`, target: 'Hallo', state: 'translated',
            description: 'd', meaning: 'm',
            contextGroups: [{ sourcefile: 'src/a.html', linenumber: 1 }] },
          { id: 'b', source: 'Bye', targetSelfClosing: true, state: 'new' },
        ],
      }],
    });
    const doc = scan(raw);
    const refs = doc.files.flatMap((f) => [
      ...f.units.flatMap((u) => [u.source, ...(u.target ? [u.target] : []), ...u.notes]),
    ]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const text = sliceSpan(raw, ref.span);
      expect(text.startsWith('<')).toBe(true);
      expect(text.endsWith('>')).toBe(true);
      expect(ref.openTagSpan.end).toBeLessThanOrEqual(ref.innerSpan.start);
      expect(ref.innerSpan.start).toBeLessThanOrEqual(ref.innerSpan.end);
      expect(ref.innerSpan.end).toBeLessThanOrEqual(ref.span.end);
    }
  });
});
