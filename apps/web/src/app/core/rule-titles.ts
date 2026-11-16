// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { RuleId } from '@lexi/shared/constants';

/**
 * What a validation rule is called when it is being counted or configured,
 * rather than explained.
 *
 * The engine's per-finding messages are about one string ("target is missing
 * INTERPOLATION_1"); the dashboard rail is about a class of problem across a
 * project and the Settings validation pane is about a rule as a whole, so
 * both need the other register. Deliberately not derived from the rule id.
 *
 * Extracted out of the dashboard page once the Settings validation pane
 * needed the same labels — one map, not two copies drifting apart.
 */
export const RULE_TITLE: Readonly<Record<RuleId, string>> = {
  'placeholder.mismatch': 'Placeholders do not match the source',
  'placeholder.pairing': 'Unpaired opening or closing tags',
  'icu.structure': 'Broken ICU structure',
  'icu.pluralCoverage': 'Plural categories incomplete',
  'icu.deadCategory': 'Plural categories the locale never uses',
  'target.empty': 'Empty targets',
  'target.identicalToSource': 'Targets identical to the source',
  'whitespace.edges': 'Leading or trailing whitespace differs',
  'punctuation.terminal': 'Terminal punctuation differs from the source',
  'language.script': 'Answer is in the wrong script',
  'xml.wellFormed': 'Target is not well-formed',
  'glossary.term': 'Term base term not used',
  'glossary.dnt': 'Do-not-translate term was translated',
};

/**
 * A rule's short name, as S12's rule list and findings header show it
 * ("Placeholder mismatch"). A name for the rule itself, where `RULE_TITLE`
 * describes a set of failures.
 */
export const RULE_NAME: Readonly<Record<RuleId, string>> = {
  'placeholder.mismatch': 'Placeholder mismatch',
  'placeholder.pairing': 'Inline tag mismatch',
  'icu.structure': 'ICU structure',
  'icu.pluralCoverage': 'Plural categories incomplete',
  'icu.deadCategory': 'Unreachable plural category',
  'target.empty': 'Empty target',
  'target.identicalToSource': 'Target identical to source',
  'whitespace.edges': 'Whitespace differs',
  'punctuation.terminal': 'Terminal punctuation',
  'language.script': 'Wrong script',
  'xml.wellFormed': 'Not well-formed',
  'glossary.term': 'Term base deviation',
  'glossary.dnt': 'Do-not-translate term translated',
};

/** S12's one-line explanation under the findings header: what the rule wants. */
export const RULE_DESCRIPTION: Readonly<Record<RuleId, string>> = {
  'placeholder.mismatch':
    'Placeholder ids in the target must match the source exactly: same ids, same count.',
  'placeholder.pairing':
    'Every opening tag in the target must be closed, in the same nesting order as the source.',
  'icu.structure':
    'Plural and select keywords, variable names and explicit =N selectors must survive untranslated.',
  'icu.pluralCoverage':
    'The target locale’s CLDR plural categories must all be covered, or some counts render wrong.',
  'icu.deadCategory': 'The target has a plural branch its locale never selects.',
  'target.empty': 'The target exists but has no text.',
  'target.identicalToSource':
    'The target reads exactly like the source. Some strings legitimately do; most were never translated.',
  'whitespace.edges':
    'Leading and trailing whitespace should match the source, which templates may rely on.',
  'punctuation.terminal': 'The source ends with terminal punctuation and the target does not.',
  'language.script': 'The target is written in a script the locale does not use.',
  'xml.wellFormed': 'The target is not well-formed XML.',
  'glossary.term':
    'A term base term in the source is not translated the way the term base says, or was translated where the term base keeps it as written.',
  'glossary.dnt': 'A do-not-translate term in the source does not appear verbatim in the target.',
};
