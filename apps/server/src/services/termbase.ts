// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  LEGACY_GLOSSARY_FILE,
  TERMBASE_FILE,
  parseTermCsv,
  termsToCsv,
  type PromptTerm,
  type Term,
} from '@lexi/shared';
import {
  appearsIn,
  containsLoosely,
  textOnly,
  usableTranslation as translationFor,
  type GlossaryCheck,
  type Segment,
  atomicWrite,
} from '@lexi/xliff';

import { readLexiJson, writeLexiText } from '../lib/lexi-dir.js';
import { resolveForCreate } from '../lib/paths.js';
import { readSharedSources, requireLinkedFolder, termBaseFileOf } from '../lib/shared-sources.js';
import type { ServerConfig } from '../config.js';

/**
 * `.lexi/termbase.csv` — the Term Base (FR-5.8, formerly the glossary) and the
 * matcher that decides which of it reaches a prompt (FR-5.9).
 *
 * CSV because the Term Base imports CSV: the file a team commits and the file
 * it imports are the same format, read by the same RFC 4180 parser
 * (`@lexi/shared`'s `termbase-csv.ts`), and a column per locale diffs in Git
 * one translation at a time.
 *
 * THE FALLBACK RULE: a locale without a translation keeps the source term as
 * written. Such a term is still injected and still checked — it is an
 * instruction, not a missing entry.
 *
 * A project may link a shared folder instead (`shared-sources.ts`). Its
 * `termbase.csv` then REPLACES this one for every read and write, and is
 * typically shared by projects with different locales — which is why a save
 * there keeps the file's own column order rather than imposing this
 * project's.
 */

/**
 * Read the term base, or nothing at all.
 *
 * A file that will not parse reads as EMPTY rather than as an error. That is
 * the `.lexi/` convention and it is load-bearing here: this file is committed
 * and edited by hand, and a stray quote in it must not be able to make a
 * project unopenable. The screen shows the count, so an empty term base where
 * there should be 148 terms is visible rather than silent.
 *
 * Every column is kept, including a locale the project no longer has, and a
 * DNT row's translations are kept too — DNT locks them, it does not delete them.
 *
 * A project that has no `termbase.csv` yet but still has the old
 * `glossary.json` is migrated here, once: the CSV is written and the JSON is
 * left where it is for the user to delete.
 */
export async function loadTermBase(cfg: ServerConfig, projectPath: string): Promise<Term[]> {
  const stored = await readStoredTermBase(projectPath);
  if (stored !== null) return stored;
  // Never migrate INTO a shared folder: this project's old glossary would
  // become every other project's Term Base.
  if ((await readSharedSources(projectPath)).termbase !== null) return [];
  const legacy = await readLegacyGlossary(projectPath);
  // Locale order is unknown here; the next save writes project order.
  if (legacy.length > 0) {
    const locales = [...new Set(legacy.flatMap((t) => Object.keys(t.translations)))].sort();
    await saveTermBase(cfg, projectPath, legacy, locales);
  }
  return legacy;
}

/**
 * The same read without the migration write, for callers that have no
 * business writing to `.lexi/` — composing a prompt is a read.
 */
export async function readTermBase(projectPath: string): Promise<Term[]> {
  const stored = await readStoredTermBase(projectPath);
  if (stored !== null) return stored;
  if ((await readSharedSources(projectPath)).termbase !== null) return [];
  return readLegacyGlossary(projectPath);
}

/** `termbase.csv`, or null when there is no such file yet. */
async function readStoredTermBase(projectPath: string): Promise<Term[] | null> {
  const raw = await readFile(await termBaseFileOf(projectPath), 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = parseTermCsv(raw, null, { stored: true });
  return parsed.rows.map(({ id, ...row }) => ({ id: id ?? randomUUID(), ...row }));
}

/** The pre-Term-Base file, read loosely: only what a Term carries survives. */
async function readLegacyGlossary(projectPath: string): Promise<Term[]> {
  const legacy = await readLexiJson<{ terms?: unknown }>(projectPath, LEGACY_GLOSSARY_FILE);
  if (legacy === null || !Array.isArray(legacy.terms)) return [];

  const terms: Term[] = [];
  for (const t of legacy.terms as Record<string, unknown>[]) {
    if (typeof t.term !== 'string' || t.term.trim() === '') continue;
    const translations: Record<string, string> = {};
    if (typeof t.translations === 'object' && t.translations !== null) {
      for (const [code, value] of Object.entries(t.translations as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim() !== '') translations[code] = value.trim();
      }
    }
    terms.push({
      id: typeof t.id === 'string' && t.id !== '' ? t.id : randomUUID(),
      term: t.term.trim(),
      note: typeof t.note === 'string' ? t.note : '',
      dnt: t.dnt === true,
      translations,
    });
  }
  return terms;
}

/**
 * Write the file, locale columns in project order — or, for a linked file, in
 * the order it already has, with this project's new locales appended. Another
 * project sharing the file may order its locales differently, and two
 * projects re-sorting each other's columns on every save would turn the
 * shared repository's history into noise.
 */
export async function saveTermBase(
  cfg: ServerConfig,
  projectPath: string,
  terms: readonly Term[],
  locales: readonly string[],
): Promise<void> {
  const linked = (await readSharedSources(projectPath)).termbase;
  if (linked === null) {
    await writeLexiText(cfg, projectPath, TERMBASE_FILE, termsToCsv(terms, locales));
    return;
  }

  await requireLinkedFolder(linked);
  const file = await resolveForCreate(await termBaseFileOf(projectPath), cfg);
  const existing = await existingLocaleColumns(file);
  const ordered = [...existing, ...locales.filter((c) => !existing.includes(c))];
  await atomicWrite(file, termsToCsv(terms, ordered));
}

/**
 * The locale columns of a term CSV's header, in file order: everything but
 * the fixed ones. `[]` when there is no file yet.
 */
async function existingLocaleColumns(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return [];
  const fixed = new Set(['id', 'term', 'note', 'dnt']);
  return parseTermCsv(raw, null, { stored: true }).recognised.filter((c) => !fixed.has(c));
}

/**
 * Whether two term lists say the same thing. Not `JSON.stringify` on the raw
 * objects: a term built by `newTerm` and the same term read back from the CSV
 * carry their keys in a different order, and must still compare equal.
 */
export function sameTerms(a: readonly Term[], b: readonly Term[]): boolean {
  const canonical = (terms: readonly Term[]): string =>
    JSON.stringify(
      terms.map((t) => [
        t.id,
        t.term,
        t.note,
        t.dnt,
        Object.entries(t.translations).sort(([x], [y]) => x.localeCompare(y)),
      ]),
    );
  return canonical(a) === canonical(b);
}

/** Defaults live here, in one place, so a partial create cannot half-fill a row. */
export function newTerm(over: Partial<Term> = {}): Term {
  return { id: randomUUID(), term: '', translations: {}, dnt: false, note: '', ...over };
}

/**
 * Which terms go into the prompt for this string, and how many there are
 * altogether (FR-5.9).
 *
 * Only terms that appear in the string — the Term Base footer says so. A term
 * with no translation for this locale is included, as "keep as written": that
 * is the fallback rule, and dropping it would let the model translate a term
 * the validator then holds it to.
 *
 * - **Case-sensitive, word boundaries where a term looks like a word.**
 *   `cart` must not match `carton`, and `Workspace` the product is not
 *   `workspace` the noun.
 * - **Longest term first.** When both `basket` and `basket is empty` match, the
 *   specific rule should be the one the model reads first.
 */
export function matchTerms(
  terms: readonly Term[],
  sourceText: string,
  locale: string,
): { matched: PromptTerm[]; total: number } {
  const matched = terms
    .filter((t) => t.term.trim() !== '' && appearsIn(sourceText, t))
    .sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term))
    .map<PromptTerm>((t) => ({
      term: t.term.trim(),
      translation: t.dnt ? '' : usableTranslation(t, locale),
      dnt: t.dnt,
      note: t.note.trim(),
    }));
  return { matched, total: terms.length };
}

/**
 * The Term Base's own answer for a string that IS a term — `MyCompany ID` and
 * nothing else — or null when the model has to be asked.
 *
 * Such a string needs no model: the Term Base already says what it must read,
 * and asking anyway costs a request and risks an answer the validator then
 * flags. So the whole source, trimmed, must equal the term — case-sensitive,
 * like `appearsIn` — and it must be plain text: a placeholder or a group makes
 * it more than the term.
 *
 * Every matching term answers: a DNT term with the term itself, a term with a
 * usable translation for this locale with that translation, and a term with
 * none for this locale with the term itself too — the fallback rule's "keep as
 * written", which for a string that is nothing BUT the term is the whole
 * answer. A term translated for `fr` only therefore answers `de` as written.
 * First matching term in file order wins.
 *
 * The answer keeps the source's surrounding whitespace, so the whitespace check
 * has nothing to say about it.
 */
export function exactTermMatch(
  terms: readonly Term[],
  sourceSegments: readonly Segment[],
  locale: string,
): { term: string; translation: string } | null {
  if (sourceSegments.length === 0 || sourceSegments.some((s) => s.k !== 't')) return null;
  const text = textOnly(sourceSegments);
  const core = text.trim();
  if (core === '') return null;
  for (const t of terms) {
    if (t.term.trim() !== core) continue;
    const answer = t.dnt ? core : usableTranslation(t, locale).trim() || core;
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    const trail = /\s*$/.exec(text)?.[0] ?? '';
    return { term: core, translation: lead + answer + trail };
  }
  return null;
}

/** The engine's fallback rule (exact locale, then language), over a whole entry. */
function usableTranslation(term: Term, locale: string): string {
  return translationFor(term.translations, locale);
}

/**
 * The term base as the validator reads it, for one target locale (FR-8.1).
 * Every named term is a check: a translation is held to its wording, and a
 * DNT term or a term without a translation for this locale to the term itself.
 */
export function glossaryChecks(terms: readonly Term[], locale: string): GlossaryCheck[] {
  return terms
    .filter((t) => t.term.trim() !== '')
    .map((t) => ({
      term: t.term.trim(),
      translation: t.dnt ? '' : usableTranslation(t, locale),
      dnt: t.dnt,
    }));
}

/**
 * How many of the injected terms the answer actually used — S11's "2 of 3
 * applied" (M14).
 *
 * A COUNT about one run, recorded next to the model and the temperature. The
 * per-target judgement is the `glossary.term` and `glossary.dnt` rules
 * (FR-8.1), which use the same loose target-side match (`containsLoosely`).
 *
 * A term that keeps the source — DNT, or no translation for this locale — is
 * "applied" when the term itself survived; every other term when its
 * translation appears. A plain case-insensitive substring: German compounds
 * "Konto" into "Kontoübersicht", and a sentence-initial capital is the same
 * term. Over-counting a coincidence is the cheaper mistake on a panel number.
 */
export function appliedTerms(terms: readonly PromptTerm[], targetText: string): number {
  const haystack = targetText.toLowerCase();
  let applied = 0;
  for (const term of terms) {
    const keep = term.dnt || term.translation.trim() === '';
    if (containsLoosely(haystack, keep ? term.term : term.translation)) applied += 1;
  }
  return applied;
}
