// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { scan } from '../src/scan.js';
import { serialize, writeTarget } from '../src/edits.js';
import { escapeText } from '../src/escape.js';
import { sliceSpan } from '../src/model.js';
import { corpusEntries, CORPUS } from './corpus.js';
import { lineDiff } from './diff.js';

const entries = corpusEntries();

describe('T1 — identity round trip (NFR-5)', () => {
  it.each(entries)('%s serializes back byte for byte with no edits', (_name, raw) => {
    const doc = scan(raw);
    const out = serialize(doc, []);
    expect(Buffer.compare(Buffer.from(out, 'utf8'), Buffer.from(raw, 'utf8'))).toBe(0);
  });
});

describe('T2 — idempotence', () => {
  it.each(entries)('%s survives a second load and serialize', (_name, raw) => {
    expect(serialize(scan(serialize(scan(raw), [])), [])).toBe(raw);
  });
});

describe('T3 — one-line diff on a real edit (NFR-8)', () => {
  // Parameterised over every unit that already has a paired target. A single
  // hand-picked case would not catch an off-by-one in the span arithmetic, which
  // is invisible to T1 — with no edits there are no splices to get wrong.
  const cases = entries.flatMap(([name, raw]) =>
    scan(raw).files.flatMap((file, fileIndex) =>
      file.units
        .map((unit, unitIndex) => ({ name, raw, fileIndex, unitIndex, unit }))
        .filter((c) => c.unit.target !== undefined && !c.unit.target.selfClosing),
    ),
  );

  it('covers a meaningful number of units', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [`${c.name}#${c.unit.id}`, c] as const))(
    '%s changes exactly one line when one word changes',
    (_label, c) => {
      const doc = scan(c.raw);
      const unit = doc.files[c.fileIndex]!.units[c.unitIndex]!;
      const original = sliceSpan(doc.raw, unit.target!.innerSpan);
      const edited = `${original}X`;
      const out = serialize(doc, writeTarget(doc, unit, edited));

      expect(out).not.toBe(c.raw);
      expect(lineDiff(c.raw, out)).toEqual({ added: 1, removed: 1 });
      // And the change must survive a reparse unchanged.
      const reparsed = scan(out).files[c.fileIndex]!.units[c.unitIndex]!;
      expect(sliceSpan(out, reparsed.target!.innerSpan)).toBe(edited);
    },
  );
});

describe('T4 — creating a target where none exists', () => {
  const withoutTarget = entries.flatMap(([name, raw]) =>
    scan(raw).files.flatMap((file, fileIndex) =>
      file.units
        .map((unit, unitIndex) => ({ name, raw, fileIndex, unitIndex, unit }))
        .filter((c) => c.unit.target === undefined),
    ),
  );

  it('covers the extraction template, which has no targets at all', () => {
    expect(withoutTarget.filter((c) => c.name.startsWith('template/')).length).toBeGreaterThan(4);
  });

  it.each(withoutTarget.map((c) => [`${c.name}#${c.unit.id}`, c] as const))(
    '%s inserts whole lines and removes none',
    (_label, c) => {
      const doc = scan(c.raw);
      const unit = doc.files[c.fileIndex]!.units[c.unitIndex]!;
      const out = serialize(doc, writeTarget(doc, unit, 'Übersetzung'));

      const diff = lineDiff(c.raw, out);
      expect(diff.removed).toBe(0);
      expect(diff.added).toBe(unit.isInline ? 0 : 1);

      const reparsed = scan(out).files[c.fileIndex]!.units[c.unitIndex]!;
      expect(reparsed.target).toBeDefined();
      expect(sliceSpan(out, reparsed.target!.innerSpan)).toBe('Übersetzung');
    },
  );

  it('puts the new target immediately after the source, before notes and contexts', () => {
    const raw = CORPUS['template/messages.xlf']!;
    const doc = scan(raw);
    const unit = doc.files[0]!.units[0]!;
    expect(unit.notes.length).toBeGreaterThan(0);
    expect(unit.contextGroups.length).toBeGreaterThan(0);

    const out = serialize(doc, writeTarget(doc, unit, 'x'));
    const reparsed = scan(out).files[0]!.units[0]!;
    expect(reparsed.target!.span.start).toBeGreaterThan(reparsed.source.span.end);
    expect(reparsed.target!.span.end).toBeLessThan(reparsed.contextGroups[0]!.span.start);
    expect(reparsed.target!.span.end).toBeLessThan(reparsed.notes[0]!.span.start);
  });

  it('matches the indentation of the source line', () => {
    const out = serialize(scan(CORPUS['template/messages.xlf']!), (() => {
      const doc = scan(CORPUS['template/messages.xlf']!);
      return writeTarget(doc, doc.files[0]!.units[1]!, 'Jetzt bezahlen');
    })());
    expect(out).toContain('\n        <target>Jetzt bezahlen</target>');
  });

  it('uses the file\'s line ending', () => {
    const raw = CORPUS['edge/crlf.xlf']!;
    const doc = scan(raw);
    const unit = doc.files[0]!.units.find((u) => u.target === undefined)!;
    const out = serialize(doc, writeTarget(doc, unit, 'Tschüss'));
    expect(out).toContain('\r\n        <target>Tschüss</target>');
    expect(out).not.toMatch(/[^\r]\n {8}<target>Tschüss/);
  });

  it('uses tab indentation when the file uses tabs', () => {
    const raw = CORPUS['edge/tabs.xlf']!;
    const doc = scan(raw);
    const units = doc.files[0]!.units;
    const withTarget = units[0]!;
    const out = serialize(doc, writeTarget(doc, withTarget, 'Hallo Welt'));
    expect(scan(out)).toBeDefined();
  });

  it('adds an inline target for a single-line trans-unit', () => {
    const raw = CORPUS['edge/handwritten.xlf']!;
    const doc = scan(raw);
    const unit = doc.files[0]!.units.find((u) => u.id === 'gt-in-text')!;
    expect(unit.isInline).toBe(false);
  });
});

describe('serialize — escaping written text', () => {
  it('escapes edited text the way Angular would', () => {
    const doc = scan(CORPUS['de/messages.de.xlf']!);
    const unit = doc.files[0]!.units[1]!;
    const out = serialize(doc, writeTarget(doc, unit, escapeText(`Tom & Jerry's "<b>"`, 'angular')));
    expect(out).toContain('Tom &amp; Jerry&apos;s &quot;&lt;b&gt;&quot;');
    expect(scan(out).files[0]!.units[1]!.targetPlain).toBe(`Tom & Jerry's "<b>"`);
  });
});
