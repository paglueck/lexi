// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { TransUnit } from './scan.js';
import { segmentsOf, placeholderIds, plainText, textOnly, type Segment } from './segments.js';
import { flattenForIcu, parseIcu, selectArguments, selectorsOf, type SelectNode } from './icu/parse.js';
import { missingPluralCategories, deadPluralCategories, type PluralType } from './icu/plurals.js';
import { wrongScript } from './script.js';
import { appearsIn, containsLoosely, type GlossaryCheck } from './glossary-match.js';

export const RULE_IDS = [
  'placeholder.mismatch',
  'placeholder.pairing',
  'icu.structure',
  'icu.pluralCoverage',
  'icu.deadCategory',
  'target.empty',
  'target.identicalToSource',
  'whitespace.edges',
  'punctuation.terminal',
  'language.script',
  'xml.wellFormed',
  'glossary.term',
  'glossary.dnt',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type Severity = 'error' | 'warning' | 'off';

/**
 * Defaults chosen so that anything Angular's runtime would choke on is an error
 * and anything a reviewer should merely look at is a warning.
 */
export const DEFAULT_SEVERITIES: Readonly<Record<RuleId, Severity>> = {
  'placeholder.mismatch': 'error',
  'placeholder.pairing': 'error',
  'icu.structure': 'error',
  'icu.pluralCoverage': 'error',
  'icu.deadCategory': 'warning',
  'target.empty': 'error',
  'target.identicalToSource': 'warning',
  'whitespace.edges': 'warning',
  'punctuation.terminal': 'warning',
  // A warning, never an error: the check cannot tell German from Dutch, only
  // Arabic from Latin, so the one thing it must never do is block a save.
  'language.script': 'warning',
  'xml.wellFormed': 'error',
  // Warnings: a glossary is guidance a translator may have a reason to leave
  // (a declension, a register the entry did not foresee). Configurable per
  // project like every rule (FR-8.2), up to an error for a team that wants it.
  'glossary.term': 'warning',
  'glossary.dnt': 'warning',
};

/**
 * The placeholder ids a placeholder finding is about.
 *
 * Carried beside the message rather than parsed out of it, so a screen can say
 * "CLOSE_LINK missing" and mark the offending chip without reading English.
 * `missing` is in the source but not the target, `unexpected` the reverse; a
 * pairing finding names the ids it is about in `unexpected`.
 */
export interface FindingPlaceholders {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export interface Finding {
  readonly rule: RuleId;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Only on `placeholder.mismatch` and `placeholder.pairing`. */
  readonly placeholders?: FindingPlaceholders;
}

type Add = (rule: RuleId, message: string, placeholders?: FindingPlaceholders) => void;

export interface ValidateContext {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly severities: Readonly<Record<RuleId, Severity>>;
  /**
   * The project's term base, resolved for `targetLocale` (FR-8.1). Absent
   * means "no term base", and the two glossary rules simply never fire.
   */
  readonly glossary?: readonly GlossaryCheck[];
}

/** Terminal punctuation across the scripts the product is likely to meet. */
const TERMINAL_PUNCTUATION = /[.!?:;…。！？؟۔।॥።፿]$/;

const countOf = (ids: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

const leadingSpace = (text: string): string => /^\s*/.exec(text)?.[0] ?? '';
const trailingSpace = (text: string): string => /\s*$/.exec(text)?.[0] ?? '';

/** Strip Angular's `START_TAG_` / `CLOSE_TAG_` prefix to get the pairing key. */
const pairKey = (id: string): { key: string; kind: 'open' | 'close' } | undefined => {
  if (id.startsWith('START_TAG_')) return { key: id.slice('START_TAG_'.length), kind: 'open' };
  if (id.startsWith('CLOSE_TAG_')) return { key: id.slice('CLOSE_TAG_'.length), kind: 'close' };
  return undefined;
};

/**
 * Validate one unit's target against its source.
 *
 * Pure, and computed from segments rather than from raw strings, so a rule can
 * never be fooled by escaping. Rules are independent except for one deliberate
 * dependency: an empty target short-circuits everything else, because reporting
 * eight consequences of one missing translation helps nobody.
 */
export function validateUnit(raw: string, unit: TransUnit, ctx: ValidateContext): Finding[] {
  const sourceSegments = segmentsOf(raw, unit.source.innerSpan);
  const targetSegments: Segment[] =
    unit.target && !unit.target.selfClosing ? segmentsOf(raw, unit.target.innerSpan) : [];
  return validateSegments(sourceSegments, targetSegments, ctx);
}

/**
 * The same rules, against segments that need not be in any document yet.
 *
 * `validateUnit` can only judge what has already been spliced into a file, which
 * is no use to an editor validating on every keystroke — and re-splicing a
 * document to ask a question about it would be both slow and a way to write
 * bytes nobody asked for. The rule bodies never needed the document: they were
 * always computed from segments, so a caller can validate a target that exists
 * only in a buffer.
 */
export function validateSegments(
  sourceSegments: readonly Segment[],
  targetSegments: readonly Segment[],
  ctx: ValidateContext,
): Finding[] {
  const findings: Finding[] = [];
  const add: Add = (rule, message, placeholders) => {
    const severity = ctx.severities[rule];
    if (severity === 'off') return;
    findings.push(placeholders === undefined ? { rule, severity, message } : { rule, severity, message, placeholders });
  };

  const sourceIds = placeholderIds(sourceSegments);
  const targetIds = placeholderIds(targetSegments);
  const targetText = plainText(targetSegments);

  if (targetIds.length === 0 && targetText.trim() === '') {
    add('target.empty', 'This string has no translation.');
    return findings;
  }

  checkPlaceholders(sourceIds, targetIds, add);
  checkPairing(targetIds, add);
  checkIcu(sourceSegments, targetSegments, ctx, add);

  const sourceText = plainText(sourceSegments);
  if (ctx.targetLocale !== ctx.sourceLocale && sourceText === targetText) {
    add(
      'target.identicalToSource',
      'The translation is identical to the source, which may mean it was never translated.',
    );
  }

  if (leadingSpace(sourceText) !== leadingSpace(targetText) || trailingSpace(sourceText) !== trailingSpace(targetText)) {
    add(
      'whitespace.edges',
      'Leading or trailing whitespace differs from the source. It matters when the string is concatenated in a template.',
    );
  }

  checkTerminalPunctuation(sourceSegments, targetSegments, add);

  // FR-6.11's "did the model answer in the right language", as much of it as
  // can be answered without a language model of our own.
  const script = wrongScript(textOnly(targetSegments), ctx.targetLocale);
  if (script !== undefined) {
    add(
      'language.script',
      `The translation is written in ${script.found} script, but ${ctx.targetLocale} uses ${script.expected}. A local model asked for a script it is weak at often answers in the wrong one.`,
    );
  }

  checkGlossary(textOnly(sourceSegments), textOnly(targetSegments), ctx.glossary ?? [], ctx.targetLocale, add);

  return findings;
}

/**
 * FR-8.1's "glossary violation" and "do-not-translate term translated", over
 * the Term Base.
 *
 * The term is looked for in the SOURCE with word boundaries (`appearsIn`, the
 * prompt's own matcher, so the model is held to exactly the terms it was
 * given) and the wording in the TARGET loosely (`containsLoosely`): compounds
 * and inflection would make a strict match cry wolf in half the languages.
 * Placeholder text is excluded on both sides — `{{ account }}` is code.
 *
 * A term with no translation for this locale keeps the source as written, so
 * it is held to the term itself, like DNT, under `glossary.term`.
 */
function checkGlossary(
  sourceText: string,
  targetText: string,
  glossary: readonly GlossaryCheck[],
  targetLocale: string,
  add: Add,
): void {
  for (const entry of glossary) {
    if (!appearsIn(sourceText, entry)) continue;
    if (entry.dnt) {
      if (!containsLoosely(targetText, entry.term)) {
        add('glossary.dnt', `“${entry.term}” is marked do-not-translate, but the translation does not contain it.`);
      }
    } else if (entry.translation === '') {
      if (!containsLoosely(targetText, entry.term)) {
        add(
          'glossary.term',
          `“${entry.term}” has no ${targetLocale} translation in the term base and should stay as written.`,
        );
      }
    } else if (!containsLoosely(targetText, entry.translation)) {
      add('glossary.term', `“${entry.term}” should be translated as “${entry.translation}” (term base).`);
    }
  }
}

function checkPlaceholders(
  sourceIds: readonly string[],
  targetIds: readonly string[],
  add: Add,
): void {
  const expected = countOf(sourceIds);
  const actual = countOf(targetIds);
  const missing: string[] = [];
  const extra: string[] = [];

  for (const [id, n] of expected) {
    const got = actual.get(id) ?? 0;
    for (let k = got; k < n; k++) missing.push(id);
  }
  for (const [id, n] of actual) {
    const want = expected.get(id) ?? 0;
    for (let k = want; k < n; k++) extra.push(id);
  }

  if (missing.length === 0 && extra.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`unexpected ${extra.join(', ')}`);
  add(
    'placeholder.mismatch',
    `The translation's placeholders do not match the source: ${parts.join('; ')}. Angular fails at runtime on this.`,
    { missing, unexpected: extra },
  );
}

function checkPairing(targetIds: readonly string[], add: Add): void {
  const stack: string[] = [];
  for (const id of targetIds) {
    const pair = pairKey(id);
    if (pair === undefined) continue;
    if (pair.kind === 'open') {
      stack.push(pair.key);
      continue;
    }
    const top = stack.pop();
    if (top === undefined) {
      add('placeholder.pairing', `The translation closes ${id} without opening it.`, { missing: [], unexpected: [id] });
      return;
    }
    if (top !== pair.key) {
      add('placeholder.pairing', `Tags are crossed: ${top} is closed by ${id}.`, { missing: [], unexpected: [id] });
      return;
    }
  }
  if (stack.length > 0) {
    add('placeholder.pairing', `The translation never closes: ${stack.join(', ')}.`, {
      missing: stack.map((key) => `CLOSE_TAG_${key}`),
      unexpected: [],
    });
  }
}

function checkIcu(
  sourceSegments: readonly Segment[],
  targetSegments: readonly Segment[],
  ctx: ValidateContext,
  add: Add,
): void {
  const sourceParse = parseIcu(flattenForIcu(sourceSegments).text);
  if (!sourceParse.ok) return; // a source we cannot read is not the target's fault
  const sourceArgs = selectArguments(sourceParse.nodes);
  if (sourceArgs.length === 0) return; // not an ICU message

  const targetFlat = flattenForIcu(targetSegments);
  const targetParse = parseIcu(targetFlat.text);
  if (!targetParse.ok) {
    add('icu.structure', `The translation is not valid ICU syntax: ${targetParse.error}.`);
    return;
  }
  const targetArgs = selectArguments(targetParse.nodes);
  if (targetArgs.length !== sourceArgs.length) {
    add(
      'icu.structure',
      `The source has ${sourceArgs.length} plural or select argument(s), the translation has ${targetArgs.length}.`,
    );
    return;
  }

  for (const [index, sourceArg] of sourceArgs.entries()) {
    const targetArg = targetArgs[index]!;
    if (targetArg.varName !== sourceArg.varName) {
      add('icu.structure', `The argument name must stay "${sourceArg.varName}"; the translation has "${targetArg.varName}".`);
      continue;
    }
    if (targetArg.type !== sourceArg.type) {
      add('icu.structure', `The keyword must stay "${sourceArg.type}"; the translation has "${targetArg.type}".`);
      continue;
    }

    // Explicit `=N` selectors are value-based and locale-independent, so dropping
    // one is a mistake. Keyword selectors are governed by the locale's own plural
    // categories instead — demanding the source's `one` in Japanese would be wrong.
    const targetSelectors = selectorsOf(targetArg);
    const droppedExplicit = selectorsOf(sourceArg)
      .filter((s) => s.startsWith('='))
      .filter((s) => !targetSelectors.includes(s));
    if (droppedExplicit.length > 0) {
      add('icu.structure', `The translation drops the explicit selector(s) ${droppedExplicit.join(', ')}.`);
    }

    checkPluralCoverage(targetArg, ctx, add);
  }
}

function checkPluralCoverage(
  arg: SelectNode,
  ctx: ValidateContext,
  add: Add,
): void {
  if (arg.type === 'select') return; // free-form selectors, no CLDR categories
  const type: PluralType = arg.type;
  const selectors = selectorsOf(arg);

  const missing = missingPluralCategories(ctx.targetLocale, type, selectors);
  if (missing.length > 0) {
    add(
      'icu.pluralCoverage',
      `${ctx.targetLocale} needs the plural categories ${missing.join(', ')}, which this translation does not cover. ` +
        'The string renders, but the grammar is wrong for some counts.',
    );
  }

  const dead = deadPluralCategories(ctx.targetLocale, type, selectors);
  if (dead.length > 0) {
    add(
      'icu.deadCategory',
      `${ctx.targetLocale} never selects the categor${dead.length === 1 ? 'y' : 'ies'} ${dead.join(', ')}; ` +
        'this branch is unreachable and usually means the text was copied from another locale.',
    );
  }
}

function checkTerminalPunctuation(
  sourceSegments: readonly Segment[],
  targetSegments: readonly Segment[],
  add: Add,
): void {
  // If the source ends with a placeholder, the sentence continues at runtime and
  // there is nothing meaningful to compare.
  const lastSource = sourceSegments[sourceSegments.length - 1];
  if (lastSource === undefined || lastSource.k !== 't') return;

  const sourceText = textOnly(sourceSegments);
  const targetText = textOnly(targetSegments);
  if (!TERMINAL_PUNCTUATION.test(sourceText.trimEnd())) return;
  if (TERMINAL_PUNCTUATION.test(targetText.trimEnd())) return;

  add(
    'punctuation.terminal',
    'The source ends with terminal punctuation and the translation does not.',
  );
}
