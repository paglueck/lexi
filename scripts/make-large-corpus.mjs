#!/usr/bin/env node
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generate a large synthetic project — the fixture NFR-3 is measured against.
 *
 * `testdata/northwind` is six tiny files: enough to prove the pipeline is
 * connected, useless for "20 locales x 20,000 units in under 10 seconds".
 * This writes a project at that scale.
 *
 * Plain string templating that mimics `@angular/compiler`'s serializer, exactly
 * like `scripts/make-testdata.mjs` and `packages/xliff/test/fixtures.ts`. It must
 * NEVER route through our own writer: a fixture produced by the code under test
 * makes every round-trip and parse assertion circular and green by definition.
 *
 * Output is gitignored. Regenerate with `npm run corpus:large`; the performance
 * tests import `generateLargeCorpus` directly and write to a tmpdir, so CI covers
 * them without anything large living in the repository.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const x = (id, equiv, ctype) =>
  `<x id="${id}"${ctype ? ` ctype="${ctype}"` : ''} equiv-text="${esc(equiv)}"/>`;

const cr = (n) => '\n' + ' '.repeat(n);

/** Deterministic, so two runs produce byte-identical files and diffs stay empty. */
const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

export const DEFAULT_LOCALES = ['de', 'fr', 'es', 'it', 'nl', 'pl', 'pt-BR', 'tr', 'ja', 'ar'];

/** The `<file>` groups a real Angular app splits its messages into. */
const GROUPS = ['messages', 'catalog', 'checkout', 'settings', 'errors'];

const NOUNS = [
  'invoice',
  'basket',
  'order',
  'product',
  'address',
  'payment',
  'session',
  'filter',
  'account',
  'shipment',
];
const VERBS = [
  'Save',
  'Remove',
  'Update',
  'Cancel',
  'Review',
  'Confirm',
  'Reset',
  'Archive',
  'Export',
  'Retry',
];
const TAILS = [
  'now',
  'later',
  'for this period',
  'before you continue',
  'from your account',
  'in this view',
];

/** A per-locale word so targets are not just copies of the source. */
const GREETING = {
  de: 'Bitte',
  fr: 'Veuillez',
  es: 'Por favor',
  it: 'Per favore',
  nl: 'Gelieve',
  pl: 'Prosze',
  'pt-BR': 'Por favor',
  tr: 'Lutfen',
  ja: 'Please',
  ar: 'الرجاء',
};

/**
 * Build one unit. Deliberately heterogeneous, because a corpus of 20,000
 * identical strings measures nothing that matters:
 *
 * - every 7th unit uses a developer-assigned `@@customId` (FR-2.5b's health metric)
 * - every 11th carries an interpolation, every 13th a START/CLOSE tag pair
 * - every 23rd is an ICU plural — and the non-English locales get only the
 *   English categories, so FR-PH-5 has something real to fire on
 * - roughly 70% carry a description note, ~15% a meaning note
 * - every 29th target is deliberately left missing, and every 37th left empty
 */
function makeUnit(i, rand) {
  const noun = NOUNS[i % NOUNS.length];
  const verb = VERBS[i % VERBS.length];
  const tail = TAILS[i % TAILS.length];
  const group = GROUPS[i % GROUPS.length];

  const custom = i % 7 === 0;
  const id = custom
    ? `${group}.${noun}_${verb.toLowerCase()}_${i}`
    : ((i * 2654435761) >>> 0).toString(16).padStart(8, '0') +
      ((i * 40503) >>> 0).toString(16).padStart(8, '0');

  const icu = i % 23 === 0;
  let source;
  if (icu) {
    source = `{VAR_PLURAL, plural, =0 {no ${noun}s} one {1 ${noun}} other {# ${noun}s}}`;
  } else if (i % 11 === 0) {
    source = `${verb} ${x('INTERPOLATION', `{{ ${noun}Count }}`)} ${noun}s ${tail}`;
  } else if (i % 13 === 0) {
    source =
      `${verb} ${x('START_TAG_STRONG', '<strong>', 'x-strong')}${noun}` +
      `${x('CLOSE_TAG_STRONG', '</strong>', 'x-strong')} ${tail}`;
  } else {
    source = `${verb} ${noun} ${tail}`;
  }

  return {
    id,
    group,
    icu,
    source,
    description:
      rand() < 0.7 ? `${verb} action on the ${group} screen, near the ${noun} list.` : undefined,
    meaning: rand() < 0.15 ? `${group}.${noun}` : undefined,
    loc: [`src/app/${group}/${noun}-${(i % 40) + 1}.component.html`, (i % 200) + 1],
    // The translation, per locale, built from the source so placeholders survive.
    translate: (locale) => {
      if (i % 29 === 0) return undefined; // no <target> at all
      if (i % 37 === 0) return ''; // present but empty
      const lead = GREETING[locale] ?? 'Please';
      if (icu) {
        // Only one/other/=0 — Polish and Arabic need more, which is the point.
        return `{VAR_PLURAL, plural, =0 {${lead} 0 ${noun}} one {${lead} 1 ${noun}} other {${lead} # ${noun}}}`;
      }
      return source.replace(verb, `${lead} ${verb.toLowerCase()}`);
    },
  };
}

function renderUnit(u, locale) {
  const parts = [`${cr(6)}<trans-unit id="${esc(u.id)}" datatype="html">`];
  parts.push(`${cr(8)}<source>${u.source}</source>`);

  if (locale !== null) {
    const target = u.translate(locale);
    if (target === undefined) parts.push(`${cr(8)}<target state="new"/>`);
    else if (target === '') parts.push(`${cr(8)}<target state="new"></target>`);
    else parts.push(`${cr(8)}<target state="translated">${target}</target>`);
  }

  parts.push(`${cr(8)}<context-group purpose="location">`);
  parts.push(`${cr(10)}<context context-type="sourcefile">${esc(u.loc[0])}</context>`);
  parts.push(`${cr(10)}<context context-type="linenumber">${u.loc[1]}</context>`);
  parts.push(`${cr(8)}</context-group>`);

  if (u.description)
    parts.push(`${cr(8)}<note priority="1" from="description">${esc(u.description)}</note>`);
  if (u.meaning) parts.push(`${cr(8)}<note priority="1" from="meaning">${esc(u.meaning)}</note>`);

  parts.push(`${cr(6)}</trans-unit>`);
  return parts.join('');
}

function renderDoc({ targetLanguage, units, locale }) {
  const attrs = [
    'source-language="en-GB"',
    'datatype="plaintext"',
    'original="ng2.template"',
    ...(targetLanguage === null ? [] : [`target-language="${targetLanguage}"`]),
  ].join(' ');
  const body = units.map((u) => renderUnit(u, locale)).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" ?>\n` +
    `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">` +
    `${cr(2)}<file ${attrs}>${cr(4)}<body>${body}${cr(4)}</body>${cr(2)}</file>\n</xliff>\n`
  );
}

/**
 * Write a project of `units` translation units across `locales`, split into
 * one file group per GROUPS entry plus the extraction template.
 *
 * Returns the written paths, so a test can assert against them without
 * re-deriving the layout.
 */
export async function generateLargeCorpus({
  units = 20_000,
  locales = DEFAULT_LOCALES,
  outDir,
  quiet = false,
} = {}) {
  if (!outDir) throw new Error('generateLargeCorpus needs an outDir');
  const rand = rng(20_260_916);
  const all = Array.from({ length: units }, (_, i) => makeUnit(i, rand));

  const byGroup = new Map(GROUPS.map((g) => [g, []]));
  for (const u of all) byGroup.get(u.group).push(u);

  const written = [];
  for (const [group, groupUnits] of byGroup) {
    // The extraction template: languages agree, no <target> anywhere (FR-1.2a).
    const files = [
      [`${group}.xlf`, renderDoc({ targetLanguage: 'en-GB', units: groupUnits, locale: null })],
    ];
    for (const locale of locales) {
      files.push([
        `${group}.${locale}.xlf`,
        renderDoc({ targetLanguage: locale, units: groupUnits, locale }),
      ]);
    }
    for (const [name, content] of files) {
      const path = join(outDir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      written.push(path);
    }
  }

  if (!quiet) {
    process.stdout.write(
      `wrote ${written.length} files · ${units.toLocaleString()} units x ${locales.length} locales into ${outDir}\n`,
    );
  }
  return written;
}

// CLI: node scripts/make-large-corpus.mjs [units] [locales]
if (import.meta.url === `file://${process.argv[1]}`) {
  const units = Number(process.argv[2] ?? 20_000);
  const localeCount = Number(process.argv[3] ?? DEFAULT_LOCALES.length);
  await generateLargeCorpus({
    units,
    locales: DEFAULT_LOCALES.slice(0, localeCount),
    outDir: fileURLToPath(new URL('../testdata/large', import.meta.url)),
  });
}
