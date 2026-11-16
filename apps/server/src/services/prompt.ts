// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CLDR_CATEGORIES,
  composeSegments,
  looksLikeIcu,
  maskSegments,
  plainText,
  pluralCategoriesFor,
  type MaskResult,
  type Segment,
} from '@lexi/xliff';
import {
  estimateTokens,
  termPromptLine,
  type PlaceholderStyle,
  type PromptBlock,
  type PromptPlaceholder,
  type PromptTerm,
  type PromptTotals,
} from '@lexi/shared';

import type { StyleGuides } from '../lib/styleguides.js';

/**
 * The composed prompt (requirements §6), in ONE place on the server.
 *
 * The client renders the blocks it is handed and composes nothing. That is the
 * entire point of S5: a preview assembled in the browser would be a second
 * implementation of this file, and the two would agree right up until somebody
 * edited one of them — at which point the screen whose job is to prove what the
 * model receives would be quietly lying.
 *
 * The block ORDER is the contract, and it is the order of the pushes below:
 * role and output contract, invariants, global style guide, locale style guide,
 * terminology, then the user message. Nothing here reads a file or a socket, so
 * the whole thing is a pure function of its inputs and testable as one.
 */

export interface PromptUnit {
  readonly unitId: string;
  readonly sourceSegments: readonly Segment[];
  readonly notes: readonly { readonly from: string | null; readonly text: string }[];
  readonly locations: readonly {
    readonly sourcefile: string;
    readonly linenumber: string | null;
  }[];
  /** The translation file being written, relative to the project root (FR-4.3b). */
  readonly relPath: string | undefined;
}

export interface PromptInput {
  readonly unit: PromptUnit;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly placeholderStyle: PlaceholderStyle;
  readonly styleguides: StyleGuides;
  /** FR-5.9: only the Term Base entries whose term appears in this string. */
  readonly glossary: readonly PromptTerm[];
  /** The whole term base's size, for S5's "2 of 148 terms matched". */
  readonly glossaryTotal: number;
  /** FR-6.12's "shorter" / "more formal", for a retry. */
  readonly instruction?: string | undefined;
  readonly contextWindow: number;
}

export interface ComposedPrompt {
  readonly blocks: readonly PromptBlock[];
  /** The system message as it is actually sent: the system blocks, joined. */
  readonly system: string;
  readonly user: string;
  readonly schema: string;
  readonly placeholders: readonly PromptPlaceholder[];
  /** The mask the restore gate needs afterwards. Null in `raw` style. */
  readonly mask: MaskResult | null;
  readonly totals: PromptTotals;
  /**
   * The Term Base entries this prompt was built with, and how many there were
   * to choose from (FR-5.9).
   *
   * Carried on the result rather than recomputed by the preview route, for the
   * reason the whole composer exists: S5 must show what was SENT. Two call
   * sites matching terms independently would agree until one of them changed.
   */
  readonly terminology: {
    readonly matched: readonly PromptTerm[];
    readonly total: number;
  };
}

/**
 * The output contract (FR-6.9).
 *
 * One line, no pretty-printing: a schema spread over five lines invites a model
 * to answer in the same shape, and pretty-printed JSON is exactly what a
 * tolerant parser has to work hardest to recover from.
 */
export const RESPONSE_SCHEMA =
  '{"translation": string, "confidence": "high"|"medium"|"low", "notes_for_reviewer": string|null}';

const BLOCK_SEPARATOR = '\n\n';

/**
 * The batch contract (FR-6.8): one item per unit, each carrying the key it was
 * given AND its source copied back. Requirements §6 asks for the key; the key alone
 * cannot catch the failure that matters most — a model that hands one
 * string's translation back under another string's key, which parses as a
 * perfect answer. The echoed source travels WITH the translation, so a swapped
 * item arrives with the wrong source for its key and is refused.
 */
export const BATCH_RESPONSE_SCHEMA =
  '{"items": [{"key": string, "source": string, "translation": string, "confidence": "high"|"medium"|"low", "notes_for_reviewer": string|null}]}';

/**
 * Several units' prompts as ONE request (FR-6.8).
 *
 * Built from each unit's own composed prompt rather than from scratch, so a
 * batch can never describe a unit differently than the single-unit path (and
 * S5's preview) would: the user sections are each unit's user message
 * verbatim, under a server-assigned key; the style guides are the same for
 * every unit of a job and are sent once; the terminology is the union of what
 * each unit matched; the ICU invariant is included if ANY unit needs it.
 *
 * Keys are `u1…uN`, never unit ids — short, unambiguous, and not something the
 * model could copy out of a source string by accident.
 */
export function composeBatchPrompt(
  prompts: readonly ComposedPrompt[],
  keys: readonly string[],
  sourceLocale: string,
  targetLocale: string,
): { system: string; user: string; schema: string } {
  const block = (p: ComposedPrompt, id: string): string =>
    p.blocks.find((b) => b.id === id)?.content ?? '';

  const icu = prompts.find((p) => block(p, 'invariants').includes('ICU message'));
  const invariants = block(icu ?? prompts[0]!, 'invariants');

  const seen = new Set<string>();
  const terms: PromptTerm[] = [];
  for (const p of prompts) {
    for (const t of p.terminology.matched) {
      if (seen.has(t.term)) continue;
      seen.add(t.term);
      terms.push(t);
    }
  }

  const system = [
    `You are a professional software localization specialist translating user interface ` +
      `strings from ${sourceLocale} to ${targetLocale}.\n\n` +
      `You are given ${prompts.length} separate strings, each under its own key. Translate each ` +
      `one on its own; they are not one text. Return only a single JSON object matching this ` +
      `schema, with no commentary and no code fences — exactly one item per key, every key once, ` +
      `each item's "key" copied exactly and its "source" copied exactly from that item's Source ` +
      `line, tokens included:\n${BATCH_RESPONSE_SCHEMA}`,
    invariants,
    block(prompts[0]!, 'styleguide.global'),
    block(prompts[0]!, `styleguide.${targetLocale}`),
    terms.length === 0 ? '' : terminologyTable(terms, targetLocale),
  ]
    .filter((c) => c !== '')
    .join(BLOCK_SEPARATOR);

  const user = prompts.map((p, i) => `### Item ${keys[i]}\n${p.user}`).join(BLOCK_SEPARATOR);

  return { system, user, schema: BATCH_RESPONSE_SCHEMA };
}

/** Notes Angular writes, told apart by `from` (FR-4.3). */
const noteOf = (unit: PromptUnit, from: string): string | undefined =>
  unit.notes.find((n) => n.from === from && n.text.trim() !== '')?.text.trim();

export function composePrompt(input: PromptInput): ComposedPrompt {
  const { unit, sourceLocale, targetLocale, placeholderStyle } = input;
  const blocks: PromptBlock[] = [];

  const mask = placeholderStyle === 'masked' ? maskSegments(unit.sourceSegments) : null;
  const placeholders = placeholdersOf(unit.sourceSegments, mask);
  const sourceText = mask !== null ? mask.masked : composeSegments(unit.sourceSegments, 'angular');
  const isIcu = looksLikeIcu(plainText(unit.sourceSegments));

  const push = (
    block: Omit<PromptBlock, 'tokens' | 'empty'> & { readonly empty?: boolean },
  ): void => {
    blocks.push({
      ...block,
      tokens: estimateTokens(block.content),
      empty: block.empty ?? block.content.trim() === '',
    });
  };

  /* 1. Role and the hard output contract. */
  push({
    id: 'role',
    kind: 'role',
    role: 'system',
    title: 'Role & output contract',
    caption: `${sourceLocale} → ${targetLocale}`,
    source: null,
    content:
      `You are a professional software localization specialist translating user interface ` +
      `strings from ${sourceLocale} to ${targetLocale}.\n\n` +
      `Return only a single JSON object matching this schema, with no commentary and no code ` +
      `fences:\n${RESPONSE_SCHEMA}`,
  });

  /* 2. The invariants that always apply, whichever prompt shape is in use. */
  push({
    id: 'invariants',
    kind: 'invariants',
    role: 'system',
    title: 'Invariants',
    caption:
      placeholderStyle === 'masked'
        ? 'Placeholder tokens are restored mechanically after generation; a mismatch is refused, not repaired.'
        : 'Raw XLIFF markup carries a higher breakage risk. The elements are re-attached from the source on the way back.',
    source: null,
    content: invariantsOf(placeholderStyle, isIcu, targetLocale),
  });

  /* 3. The global style guide, verbatim (FR-5.3). */
  const global = input.styleguides.global;
  push({
    id: 'styleguide.global',
    kind: 'styleguide',
    role: 'system',
    title: 'Global style guide',
    caption:
      global === null
        ? 'No global style guide yet. Every locale would inherit it, so it is the single highest-value thing to write.'
        : 'Injected verbatim — what you wrote is what the model sees.',
    source: global?.name ?? null,
    content: global === null ? '' : `# Global style guide\n${global.text}`,
  });

  /* 4. The locale extension, which overrides the global guide on conflict. */
  const locale = input.styleguides.locale;
  push({
    id: `styleguide.${targetLocale}`,
    kind: 'styleguide',
    role: 'system',
    title: `${targetLocale} style guide`,
    caption:
      locale === null
        ? `No ${targetLocale} style guide yet. Register, form of address and length pitfalls are what a locale guide is for.`
        : 'These rules override the global guide wherever the two conflict.',
    source: locale?.name ?? null,
    content:
      locale === null
        ? ''
        : `## Locale-specific style guide (${targetLocale})\n` +
          `The following rules are specific to ${targetLocale} and take precedence over the ` +
          `global style guide wherever the two conflict.\n${locale.text}`,
  });

  /* 5. Only the terminology this string actually needs (FR-5.9). */
  push({
    id: 'terminology',
    kind: 'terminology',
    role: 'system',
    title: 'Terminology',
    caption:
      input.glossaryTotal === 0
        ? 'No term base yet.'
        : `${input.glossary.length} of ${input.glossaryTotal} terms matched this string.`,
    source: null,
    content: input.glossary.length === 0 ? '' : terminologyTable(input.glossary, targetLocale),
  });

  /* 6. The unit itself. */
  const user = userMessage(input, sourceText, placeholders);
  push({
    id: 'user',
    kind: 'user',
    role: 'user',
    title:
      placeholderStyle === 'masked'
        ? 'User message · masked tokens'
        : 'User message · raw XLIFF markup',
    caption:
      placeholderStyle === 'masked'
        ? 'Restored after generation.'
        : 'Higher breakage risk — kept so the two prompts can be compared on the same unit.',
    source: null,
    content: user,
    empty: false,
  });

  const system = blocks
    .filter((b) => b.role === 'system' && b.content !== '')
    .map((b) => b.content)
    .join(BLOCK_SEPARATOR);

  const systemTokens = estimateTokens(system);
  const userTokens = estimateTokens(user);

  return {
    blocks,
    system,
    user,
    schema: RESPONSE_SCHEMA,
    placeholders,
    mask,
    terminology: {
      matched: input.glossary,
      total: input.glossaryTotal,
    },
    totals: {
      tokens: systemTokens + userTokens,
      system: systemTokens,
      user: userTokens,
      contextWindow: input.contextWindow,
      estimated: true,
    },
  };
}

/**
 * The placeholder legend, in whichever vocabulary the model is being given.
 *
 * In masked style the token is `[[n]]`; in raw style the model sees the element
 * itself, so the "token" it must reproduce is the element's id. Either way the
 * label is the `equiv-text`, because that is the only part a translator — or a
 * model — can reason about when deciding where the thing belongs in a sentence.
 */
function placeholdersOf(
  segments: readonly Segment[],
  mask: MaskResult | null,
): PromptPlaceholder[] {
  if (mask !== null) {
    return mask.tokens.map((t) => ({ token: `[[${t.index}]]`, label: t.label, id: t.segment.id }));
  }
  const out: PromptPlaceholder[] = [];
  const walk = (nodes: readonly Segment[]): void => {
    for (const node of nodes) {
      if (node.k === 'p')
        out.push({ token: node.id, label: node.equivText ?? node.id, id: node.id });
      else if (node.k === 'g') {
        out.push({ token: node.id, label: node.openRaw, id: node.id });
        walk(node.children);
      }
    }
  };
  walk(segments);
  return out;
}

function invariantsOf(style: PlaceholderStyle, isIcu: boolean, targetLocale: string): string {
  const lines: string[] =
    style === 'masked'
      ? [
          'Reproduce every [[n]] token exactly as written, including both brackets and the number.',
          'Every token in the source must appear exactly once in the translation, and no others. Put each one where it is natural for the target language.',
          'Never translate a token, renumber one, or invent one.',
          'Do not add markup the source does not have; keep any markup that is part of the source text exactly as written.',
        ]
      : [
          'Reproduce every <x .../> element exactly as written, with every attribute unchanged. Never translate an attribute value.',
          'Every element in the source must appear exactly once in the translation, and no others.',
          'Keep <g id="…">…</g> pairs intact and correctly nested. The text inside them is translatable; the tags are not.',
        ];

  lines.push(
    'Translate for the meaning in context, not word by word.',
    'Do not add or remove punctuation that changes meaning, and keep any leading or trailing spaces the source has.',
  );

  if (isIcu) {
    // FR-PH-4 and FR-PH-5. The categories are the target locale's, not the
    // source's — which is the whole reason the check exists: a model shown an
    // English one/other message will happily hand back a Polish one that is
    // grammatically broken for 2 and for 22.
    const categories = CLDR_CATEGORIES.filter((c) =>
      pluralCategoriesFor(targetLocale, 'plural').has(c),
    );
    lines.push(
      'This string is an ICU message. Keep its structure exactly: the argument name, the keyword (plural, select, selectordinal), the braces, the category keywords and any explicit selectors such as =0 and =1. Only the text inside each branch is translatable.',
      `${targetLocale} uses the plural categories ${categories.join(', ')}. Provide a branch for each of them, adding the ones the source does not have.`,
    );
  }

  return `Always:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/**
 * FR-5.8's terminology, one line per term — the same `termPromptLine` the Term
 * Base editor previews. A term without a translation for this locale is stated
 * as "keep as written" rather than left out: that is the fallback rule, and the
 * validator holds the answer to it.
 */
function terminologyTable(terms: readonly PromptTerm[], targetLocale: string): string {
  return [
    '## Terminology',
    'Use these terms exactly as given. A term marked "keep as written" must appear unchanged in the translation. Notes in parentheses explain meaning or usage; they are not part of the translation.',
    ...terms.map((t) => termPromptLine(t, targetLocale)),
  ].join('\n');
}

/**
 * The user message (requirements Appendix A).
 *
 * Every field gets its own labelled line, and a missing one says so explicitly
 * rather than being omitted. That is not tidiness: local models under about 14B
 * invent context when a field is silently absent, which is exactly the failure
 * FR-4.5 names.
 */
function userMessage(
  input: PromptInput,
  sourceText: string,
  placeholders: readonly PromptPlaceholder[],
): string {
  const { unit, sourceLocale, targetLocale, placeholderStyle } = input;
  const lines: string[] = [`Unit id: ${unit.unitId}`];

  if (unit.locations.length > 0) {
    // FR-4.3a and FR-4.3b: the template path is cheap, reliable context. More
    // than one means the string is shared, which constrains how freely it can
    // be reworded — so the model is told, in as many words.
    const used = unit.locations
      .map((l) => (l.linenumber === null ? l.sourcefile : `${l.sourcefile} (line ${l.linenumber})`))
      .join(', ');
    lines.push(`Used in: ${used}`);
    if (unit.locations.length > 1) {
      lines.push(
        'This string is shared across several templates, so it must read correctly in all of them.',
      );
    }
  } else {
    lines.push('Used in: not recorded in the file.');
  }

  if (unit.relPath !== undefined) lines.push(`Translation file: ${unit.relPath}`);

  const meaning = noteOf(unit, 'meaning');
  const description = noteOf(unit, 'description');
  const others = unit.notes
    .filter((n) => n.from !== 'meaning' && n.from !== 'description' && n.text.trim() !== '')
    .map((n) => n.text.trim());

  lines.push(`Meaning: ${meaning ?? 'none given.'}`);
  lines.push(
    `Description: ${description ?? 'No context note was provided for this string. Do not invent one.'}`,
  );
  for (const note of others) lines.push(`Note: ${note}`);

  // Angular emits no `maxwidth` (requirements §13 Q4), so this line is honest about
  // there being no machine-readable limit rather than omitting the field.
  lines.push('Max length: none. Keep the translation close to the length of the source.');

  if (placeholders.length > 0) {
    lines.push(
      '',
      placeholderStyle === 'masked'
        ? `Placeholder tokens — reproduce each one exactly as written, in a position that is natural for ${targetLocale}. Do not translate their contents.`
        : `Placeholder elements — reproduce each one exactly as written, in a position that is natural for ${targetLocale}. Do not translate their attributes.`,
      ...placeholders.map((p) => `  ${p.token} = ${p.label}`),
    );
  } else {
    lines.push('Placeholders: none.');
  }

  if (input.instruction !== undefined && input.instruction.trim() !== '') {
    lines.push('', `Additional instruction for this attempt: ${input.instruction.trim()}`);
  }

  lines.push('', `Source (${sourceLocale}):`, sourceText);
  return lines.join('\n');
}
