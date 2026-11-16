// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Did the answer come back in the right writing system?" — the cheap half of
 * FR-6.11's language check.
 *
 * Deliberately a SCRIPT check and not a language check. Telling German from
 * Dutch needs a model or a dictionary, and getting it wrong would mean warning
 * a translator about a translation that is perfectly good. Telling Arabic from
 * Latin needs a codepoint range, is never wrong, and catches the failure that
 * actually happens with small local models: asked for `ar`, `ru` or `ja`, they
 * answer in English — or echo the source — and the result looks plausible to
 * anyone who does not read the language.
 *
 * So: a warning only when the target locale's script is known, the text carries
 * enough letters to judge, and almost none of them are in that script.
 */

export const SCRIPTS = ['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'cjk', 'devanagari', 'thai'] as const;
export type Script = (typeof SCRIPTS)[number];

/**
 * The script a language is written in, where it has exactly one that matters.
 *
 * Languages written in more than one script in practice — Serbian, Azerbaijani,
 * Kurdish, Punjabi — are deliberately absent: a check that has to guess which
 * of two correct answers the team meant has no business warning anybody.
 */
const LANGUAGE_SCRIPTS: Readonly<Record<string, Script>> = {
  ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', be: 'cyrillic', mk: 'cyrillic', kk: 'cyrillic',
  el: 'greek',
  ar: 'arabic', fa: 'arabic', ur: 'arabic', ps: 'arabic', sd: 'arabic', dv: 'arabic',
  he: 'hebrew', yi: 'hebrew',
  ja: 'cjk', ko: 'cjk', zh: 'cjk',
  hi: 'devanagari', mr: 'devanagari', ne: 'devanagari',
  th: 'thai',
  // Latin is the default below rather than an entry here: listing every locale
  // that uses it would be a maintenance job with no upside.
};

/** The script of one codepoint, or undefined for digits, punctuation and spaces. */
export function scriptOf(codePoint: number): Script | undefined {
  if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) return 'latin';
  if (codePoint < 0xc0) return undefined;
  if (codePoint <= 0x24f) return 'latin';
  if (codePoint >= 0x370 && codePoint <= 0x3ff) return 'greek';
  if (codePoint >= 0x400 && codePoint <= 0x52f) return 'cyrillic';
  if (codePoint >= 0x590 && codePoint <= 0x5ff) return 'hebrew';
  if (codePoint >= 0x600 && codePoint <= 0x6ff) return 'arabic';
  if (codePoint >= 0x750 && codePoint <= 0x77f) return 'arabic';
  if (codePoint >= 0x900 && codePoint <= 0x97f) return 'devanagari';
  if (codePoint >= 0xe00 && codePoint <= 0xe7f) return 'thai';
  if (codePoint >= 0xfb1d && codePoint <= 0xfb4f) return 'hebrew';
  if (codePoint >= 0xfb50 && codePoint <= 0xfdff) return 'arabic';
  if (codePoint >= 0x1e00 && codePoint <= 0x1eff) return 'latin';
  // Kana, Hangul and the CJK ideograph blocks, which no other script overlaps.
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) return 'cjk';
  if (codePoint >= 0x3130 && codePoint <= 0x318f) return 'cjk';
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 'cjk';
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 'cjk';
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return 'cjk';
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 'cjk';
  return undefined;
}

export const scriptForLocale = (locale: string): Script | undefined =>
  LANGUAGE_SCRIPTS[(locale.split('-')[0] ?? '').toLowerCase()];

/**
 * Below this many letters the sample is too small to judge: "OK", "PDF" and a
 * lone digit are legitimate translations into any language on earth.
 */
const MIN_LETTERS = 8;

/** At least this share must be in the expected script before we keep quiet. */
const MIN_SHARE = 0.2;

export interface ScriptVerdict {
  readonly expected: Script;
  readonly found: Script;
  readonly share: number;
}

/**
 * Report a target that is overwhelmingly in the wrong writing system.
 *
 * Returns undefined when the locale's script is unknown, the sample is too
 * short, or enough of the text is in the expected script — which includes every
 * ordinary case of a proper noun, a product name or a code fragment left in
 * Latin inside a Russian sentence.
 */
export function wrongScript(text: string, targetLocale: string): ScriptVerdict | undefined {
  const expected = scriptForLocale(targetLocale);
  if (expected === undefined) return undefined;

  const counts = new Map<Script, number>();
  let letters = 0;
  for (const ch of text) {
    const script = scriptOf(ch.codePointAt(0) ?? 0);
    if (script === undefined) continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
    letters += 1;
  }
  if (letters < MIN_LETTERS) return undefined;

  const share = (counts.get(expected) ?? 0) / letters;
  if (share >= MIN_SHARE) return undefined;

  let found: Script = expected;
  let best = -1;
  for (const [script, n] of counts) {
    if (n > best) {
      best = n;
      found = script;
    }
  }
  return { expected, found, share };
}
