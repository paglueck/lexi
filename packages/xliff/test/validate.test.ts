// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { validateUnit, validateSegments, DEFAULT_SEVERITIES, RULE_IDS, type RuleId } from '../src/validate.js';
import { editedText } from '../src/segments.js';
import { scan } from '../src/scan.js';
import { oneUnit, ph } from './fixtures.js';

const check = (
  source: string,
  target: string | undefined,
  options: { targetLocale?: string; sourceLocale?: string; severities?: Partial<Record<RuleId, 'error' | 'warning' | 'off'>> } = {},
) => {
  const raw = oneUnit(target === undefined ? { id: 'a', source } : { id: 'a', source, target });
  const unit = scan(raw).files[0]!.units[0]!;
  return validateUnit(raw, unit, {
    sourceLocale: options.sourceLocale ?? 'en-GB',
    targetLocale: options.targetLocale ?? 'de',
    severities: { ...DEFAULT_SEVERITIES, ...options.severities },
  });
};

const ruleIds = (findings: ReturnType<typeof check>) => findings.map((f) => f.rule);

describe('placeholder.mismatch', () => {
  it('passes when the target reproduces every placeholder', () => {
    const findings = check(`Hi ${ph.interpolation(0)}`, `Hallo ${ph.interpolation(0)}`);
    expect(ruleIds(findings)).not.toContain('placeholder.mismatch');
  });

  it('passes when the target reorders them, because word order differs', () => {
    const source = `${ph.interpolation(0, '{{ a }}')} and ${ph.interpolation(1, '{{ b }}')}`;
    const target = `${ph.interpolation(1, '{{ b }}')} und ${ph.interpolation(0, '{{ a }}')}`;
    expect(ruleIds(check(source, target))).not.toContain('placeholder.mismatch');
  });

  it('reports a dropped placeholder as an error', () => {
    const findings = check(`Hi ${ph.interpolation(0)}`, 'Hallo');
    const finding = findings.find((f) => f.rule === 'placeholder.mismatch');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('INTERPOLATION');
  });

  it('reports an invented placeholder', () => {
    const findings = check('Hi', `Hallo ${ph.interpolation(0)}`);
    expect(ruleIds(findings)).toContain('placeholder.mismatch');
  });

  it('reports a duplicated placeholder', () => {
    const findings = check(`Hi ${ph.interpolation(0)}`, `Hallo ${ph.interpolation(0)}${ph.interpolation(0)}`);
    expect(ruleIds(findings)).toContain('placeholder.mismatch');
  });
});

describe('placeholder.pairing', () => {
  it('passes for a correctly paired tag', () => {
    const source = `${ph.startTag('strong')}x${ph.closeTag('strong')}`;
    expect(ruleIds(check(source, `${ph.startTag('strong')}y${ph.closeTag('strong')}`)))
      .not.toContain('placeholder.pairing');
  });

  it('reports a missing closing tag', () => {
    const source = `${ph.startTag('strong')}x${ph.closeTag('strong')}`;
    const findings = check(source, `${ph.startTag('strong')}y`);
    expect(ruleIds(findings)).toContain('placeholder.pairing');
  });

  it('reports crossed nesting', () => {
    const source = `${ph.startTag('b')}${ph.startTag('i')}x${ph.closeTag('i')}${ph.closeTag('b')}`;
    const target = `${ph.startTag('b')}${ph.startTag('i')}y${ph.closeTag('b')}${ph.closeTag('i')}`;
    expect(ruleIds(check(source, target))).toContain('placeholder.pairing');
  });

  it('pairs numbered repeats with their own partner', () => {
    const source =
      `${ph.startTag('span')}a${ph.closeTag('span')}` +
      `<x id="START_TAG_SPAN_1" ctype="x-span" equiv-text="&lt;span&gt;"/>b<x id="CLOSE_TAG_SPAN_1" ctype="x-span" equiv-text="&lt;/span&gt;"/>`;
    expect(ruleIds(check(source, source))).not.toContain('placeholder.pairing');
  });
});

describe('target.empty', () => {
  it('reports a missing target', () => {
    expect(ruleIds(check('Hi', undefined))).toContain('target.empty');
  });

  it('reports a whitespace-only target', () => {
    expect(ruleIds(check('Hi', '   '))).toContain('target.empty');
  });

  it('does not report a target that is only a placeholder', () => {
    const findings = check(ph.interpolation(0), ph.interpolation(0));
    expect(ruleIds(findings)).not.toContain('target.empty');
  });

  it('suppresses every other target rule once the target is empty', () => {
    // One finding per problem, not a cascade the reader has to filter by hand.
    expect(ruleIds(check(`Hi ${ph.interpolation(0)}`, undefined))).toEqual(['target.empty']);
  });
});

describe('target.identicalToSource', () => {
  it('reports a target identical to the source as possibly untranslated', () => {
    const findings = check('Billing', 'Billing');
    expect(ruleIds(findings)).toContain('target.identicalToSource');
    expect(findings.find((f) => f.rule === 'target.identicalToSource')?.severity).toBe('warning');
  });

  it('stays quiet when the target locale is the source locale', () => {
    expect(ruleIds(check('Billing', 'Billing', { targetLocale: 'en-GB' })))
      .not.toContain('target.identicalToSource');
  });
});

describe('whitespace.edges', () => {
  it('reports a lost leading space', () => {
    expect(ruleIds(check(' Hi', 'Hallo'))).toContain('whitespace.edges');
  });

  it('reports a changed amount of trailing space', () => {
    expect(ruleIds(check('Hi ', 'Hallo  '))).toContain('whitespace.edges');
  });

  it('passes when both edges match exactly', () => {
    expect(ruleIds(check(' Hi ', ' Hallo '))).not.toContain('whitespace.edges');
  });
});

describe('punctuation.terminal', () => {
  it('reports a dropped full stop', () => {
    expect(ruleIds(check('Done.', 'Fertig'))).toContain('punctuation.terminal');
  });

  it('accepts a script-appropriate terminator', () => {
    expect(ruleIds(check('Really?', 'حقا؟', { targetLocale: 'ar' })))
      .not.toContain('punctuation.terminal');
  });

  it('stays quiet when the source ends with a placeholder', () => {
    const source = `Total ${ph.interpolation(0)}`;
    expect(ruleIds(check(source, `Summe ${ph.interpolation(0)}`))).not.toContain('punctuation.terminal');
  });

  it('stays quiet when the source has no terminal punctuation', () => {
    expect(ruleIds(check('Billing', 'Abrechnung'))).not.toContain('punctuation.terminal');
  });
});

describe('icu.structure', () => {
  const src = '{VAR_PLURAL, plural, =0 {no items} one {1 item} other {# items}}';

  it('passes a faithful translation', () => {
    const target = '{VAR_PLURAL, plural, =0 {keine} one {1 Element} other {# Elemente}}';
    expect(ruleIds(check(src, target))).not.toContain('icu.structure');
  });

  it('reports a target that is not parseable ICU', () => {
    expect(ruleIds(check(src, '{VAR_PLURAL, plural, one {kaputt}'))).toContain('icu.structure');
  });

  it('reports a translated argument name', () => {
    const target = '{VAR_PLURALIS, plural, =0 {keine} one {1} other {#}}';
    expect(ruleIds(check(src, target))).toContain('icu.structure');
  });

  it('reports a translated type keyword', () => {
    const target = '{VAR_PLURAL, auswahl, =0 {keine} one {1} other {#}}';
    expect(ruleIds(check(src, target))).toContain('icu.structure');
  });

  it('reports a dropped explicit selector, which is value-based and locale-independent', () => {
    const target = '{VAR_PLURAL, plural, one {1 Element} other {# Elemente}}';
    expect(ruleIds(check(src, target))).toContain('icu.structure');
  });

  it('does not require a keyword the target locale has no use for', () => {
    // Japanese has only `other`; demanding the source's `one` would be wrong.
    const target = '{VAR_PLURAL, plural, =0 {なし} other {#件}}';
    expect(ruleIds(check(src, target, { targetLocale: 'ja' }))).not.toContain('icu.structure');
  });

  it('says nothing about units that are not ICU at all', () => {
    expect(ruleIds(check('Plain', 'Einfach'))).not.toContain('icu.structure');
  });
});

describe('icu.pluralCoverage', () => {
  const src = '{VAR_PLURAL, plural, one {1 item} other {# items}}';

  it('passes German, which needs the same two categories as English', () => {
    const target = '{VAR_PLURAL, plural, one {1 Element} other {# Elemente}}';
    expect(ruleIds(check(src, target))).not.toContain('icu.pluralCoverage');
  });

  it('reports the categories Polish needs but an English-shaped translation omits', () => {
    const target = '{VAR_PLURAL, plural, one {1 element} other {# elementow}}';
    const findings = check(src, target, { targetLocale: 'pl' });
    const finding = findings.find((f) => f.rule === 'icu.pluralCoverage');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('few');
    expect(finding?.message).toContain('many');
  });

  it('passes Polish once all four categories are present', () => {
    const target = '{VAR_PLURAL, plural, one {1} few {#} many {#} other {#}}';
    expect(ruleIds(check(src, target, { targetLocale: 'pl' }))).not.toContain('icu.pluralCoverage');
  });

  it('reports all four categories Arabic is missing', () => {
    const target = '{VAR_PLURAL, plural, one {1} other {#}}';
    const finding = check(src, target, { targetLocale: 'ar' }).find((f) => f.rule === 'icu.pluralCoverage');
    for (const category of ['zero', 'two', 'few', 'many']) {
      expect(finding?.message).toContain(category);
    }
  });

  it('warns about a branch the target locale can never select', () => {
    const target = '{VAR_PLURAL, plural, one {1} few {#} other {#}}';
    const findings = check(src, target, { targetLocale: 'de' });
    const finding = findings.find((f) => f.rule === 'icu.deadCategory');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('few');
  });
});

describe('severity configuration', () => {
  it('honours a rule turned off', () => {
    expect(ruleIds(check('Done.', 'Fertig', { severities: { 'punctuation.terminal': 'off' } })))
      .not.toContain('punctuation.terminal');
  });

  it('honours a rule promoted to an error', () => {
    const findings = check('Done.', 'Fertig', { severities: { 'punctuation.terminal': 'error' } });
    expect(findings.find((f) => f.rule === 'punctuation.terminal')?.severity).toBe('error');
  });

  it('cannot turn off the internal well-formedness check', () => {
    expect(DEFAULT_SEVERITIES['xml.wellFormed']).toBe('error');
  });

  it('has a default severity for every rule', () => {
    for (const id of RULE_IDS) expect(DEFAULT_SEVERITIES[id]).toBeDefined();
  });
});

/**
 * FR-6.11's language check, and the reason it checks the SCRIPT rather than the
 * language: a rule that tried to tell German from Dutch would warn about good
 * translations, while one that tells Arabic from Latin is never wrong about the
 * failure that actually happens — a small model asked for `ar` answering in
 * English.
 */
describe('language.script', () => {
  const findings = (target: string, locale: string): string[] =>
    validateSegments([editedText('Save your changes now')], [editedText(target)], {
      sourceLocale: 'en-GB',
      targetLocale: locale,
      severities: DEFAULT_SEVERITIES,
    }).map((f) => f.rule);

  it('warns when a Russian target came back in Latin script', () => {
    expect(findings('Save your changes now, please', 'ru')).toContain('language.script');
  });

  it('says nothing about a real Russian translation', () => {
    expect(findings('Сохраните изменения сейчас', 'ru')).not.toContain('language.script');
  });

  it('says nothing about a Latin product name inside a Russian sentence', () => {
    expect(findings('Сохранить в Lexi Workspace сейчас', 'ru')).not.toContain('language.script');
  });

  it('stays quiet for a locale whose script is ambiguous or Latin', () => {
    expect(findings('Speichern Sie Ihre Änderungen', 'de')).not.toContain('language.script');
    expect(findings('Sacuvajte izmene odmah', 'sr')).not.toContain('language.script');
  });

  it('stays quiet on a sample too short to judge', () => {
    expect(findings('OK', 'ru')).not.toContain('language.script');
  });

  it('is a warning, never an error — it must not be able to block a save', () => {
    const list = validateSegments([editedText('Save your changes now')], [editedText('Save your changes now, please')], {
      sourceLocale: 'en-GB',
      targetLocale: 'ar',
      severities: DEFAULT_SEVERITIES,
    });
    expect(list.find((f) => f.rule === 'language.script')?.severity).toBe('warning');
  });
});

describe('glossary.term and glossary.dnt (FR-8.1)', () => {
  const glossary = [
    { term: 'dashboard', translation: 'Übersicht', dnt: false },
    { term: 'Workspace', translation: '', dnt: true },
    { term: 'cart', translation: 'Warenkorb', dnt: false },
    { term: 'checkout', translation: '', dnt: false },
  ];
  const run = (source: string, target: string, severities = {}) =>
    validateSegments([editedText(source)], [editedText(target)], {
      sourceLocale: 'en-GB',
      targetLocale: 'de',
      severities: { ...DEFAULT_SEVERITIES, ...severities },
      glossary,
    });
  const rules = (source: string, target: string) => run(source, target).map((f) => f.rule);

  it('names the term and the wording it wanted when a translation ignores the glossary', () => {
    const findings = run('Open the dashboard', 'Öffne das Dashboard');
    expect(findings.find((f) => f.rule === 'glossary.term')?.message).toBe(
      '“dashboard” should be translated as “Übersicht” (term base).',
    );
    expect(findings.find((f) => f.rule === 'glossary.term')?.severity).toBe('warning');
  });

  it('accepts the wording inside a compound and at any case, as German writes it', () => {
    expect(rules('Open the dashboard', 'Zur Projektübersicht')).not.toContain('glossary.term');
    expect(rules('Open the dashboard', 'ÜBERSICHT öffnen')).not.toContain('glossary.term');
  });

  it('matches the SOURCE case-sensitively, so "Dashboard" is not the term "dashboard"', () => {
    expect(rules('Dashboard', 'Instrumententafel')).not.toContain('glossary.term');
    expect(rules('Open the dashboard', 'Instrumententafel')).toContain('glossary.term');
  });

  it('holds a term with no translation for the locale to the source term itself', () => {
    const findings = run('Go to checkout', 'Zur Kasse');
    expect(findings.find((f) => f.rule === 'glossary.term')?.message).toBe(
      '“checkout” has no de translation in the term base and should stay as written.',
    );
    expect(rules('Go to checkout', 'Zum Checkout')).not.toContain('glossary.term');
  });

  it('matches the SOURCE on word boundaries, so "cart" is not in "carton"', () => {
    expect(rules('Pack the carton', 'Karton packen')).not.toContain('glossary.term');
    expect(rules('Add to cart', 'In den Korb')).toContain('glossary.term');
  });

  it('flags a do-not-translate term that did not survive, matching the source case-sensitively', () => {
    expect(rules('Open your Workspace', 'Öffne deinen Arbeitsbereich')).toContain('glossary.dnt');
    expect(rules('Open your Workspace', 'Öffne deinen Workspace')).not.toContain('glossary.dnt');
    // Case-sensitive entry: "workspace" in the source is not the product name.
    expect(rules('a workspace', 'ein Arbeitsbereich')).not.toContain('glossary.dnt');
  });

  it('never fires without a glossary, on an empty target, or when switched off', () => {
    const none = validateSegments([editedText('Open the dashboard')], [editedText('Öffne')], {
      sourceLocale: 'en-GB',
      targetLocale: 'de',
      severities: DEFAULT_SEVERITIES,
    });
    expect(none.map((f) => f.rule)).not.toContain('glossary.term');
    expect(rules('Open the dashboard', '')).toEqual(['target.empty']);
    expect(run('Open the dashboard', 'Öffne', { 'glossary.term': 'off' }).map((f) => f.rule)).not.toContain(
      'glossary.term',
    );
  });
});
