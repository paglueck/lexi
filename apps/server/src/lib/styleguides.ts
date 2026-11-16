// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite, looksLikeLocaleTag } from '@lexi/xliff';
import { estimateTokens, GLOBAL_GUIDE_KEY, type StyleGuideSummary } from '@lexi/shared';

import { badRequest } from './http-error.js';
import { resolveForCreate } from './paths.js';
import { ensureLexiDir } from './lexi-dir.js';
import { readSharedSources, requireLinkedFolder, styleGuideDirOf } from './shared-sources.js';
import type { ServerConfig } from '../config.js';

/**
 * `.lexi/styleguides/` — the layered style guides (FR-5.1, FR-5.2, FR-5.5).
 *
 * M9 only READS them; M10 is the editor that writes them. Reading first is not
 * an accident of ordering — it means the composed prompt is real from the first
 * milestone that sends anything, and the screen that says "there is no German
 * style guide yet" is telling the truth about the same files M10 will edit.
 *
 * Plain `.md` on disk, so they diff and review in Git like any other document.
 * They are injected VERBATIM (FR-5.3): what the user wrote is what the model
 * sees, never a summary of it.
 *
 * The folder is `styleGuideDirOf`'s answer, not a constant: a project may link
 * a shared one (`shared-sources.ts`), and then every read and write below goes
 * there instead. Resolved per call, so a link changes nothing that is cached.
 */

export { STYLEGUIDE_DIR } from './shared-sources.js';

/** The global guide's filename. A locale guide is `<locale>.md`. */
export const GLOBAL_GUIDE = 'global.md';

export interface StyleGuide {
  /** `global.md`, `de.md` — what S5 and S6 print as the source label. */
  readonly name: string;
  readonly text: string;
}

export const styleGuidePath = async (projectPath: string, name: string): Promise<string> =>
  join(await styleGuideDirOf(projectPath), name);

/**
 * Read one guide, or null when it does not exist.
 *
 * An unreadable file is null too, and deliberately so: a style guide that
 * cannot be read must degrade to "no guide" rather than take the whole
 * translation path down with it. The screen says which guides are empty, so
 * the absence is visible rather than silent.
 */
export async function readStyleGuide(
  projectPath: string,
  name: string,
): Promise<StyleGuide | null> {
  const text = await readFile(await styleGuidePath(projectPath, name), 'utf8').catch(() => null);
  if (text === null || text.trim() === '') return null;
  return { name, text: text.trim() };
}

export interface StyleGuides {
  readonly global: StyleGuide | null;
  readonly locale: StyleGuide | null;
}

/**
 * The pair a prompt needs: the global guide and the one for this locale.
 *
 * `pt-BR.md` is tried before `pt.md`. A guide written for the exact locale is
 * the one its author meant; falling back to the language lets a team keep one
 * Portuguese guide for both regions without copying it.
 */
export async function readStyleGuides(projectPath: string, locale: string): Promise<StyleGuides> {
  const language = locale.split('-')[0] ?? locale;
  const candidates = language === locale ? [`${locale}.md`] : [`${locale}.md`, `${language}.md`];

  const global = await readStyleGuide(projectPath, GLOBAL_GUIDE);
  for (const name of candidates) {
    const guide = await readStyleGuide(projectPath, name);
    if (guide !== null) return { global, locale: guide };
  }
  return { global, locale: null };
}

/* ---- M10: the write half ------------------------------------------------- */

/**
 * `global` / `de` / `pt-BR` → the file it names. Anything else is refused.
 *
 * **This is the security boundary of M10.** `:key` comes off the URL and
 * decides a filename, which no other route parameter in this codebase does, so
 * it is checked against an ALLOWLIST rather than escaped or normalised. A shape
 * that admits only 2–3 alpha language, an optional 4-alpha script and an
 * optional 2-alpha or 3-digit region cannot express a separator, a dot or a
 * traversal — there is nothing left to sanitize afterwards.
 *
 * `resolveForCreate` jails the result as well. That is belt and
 * braces on purpose: the allowlist is the part that is obviously correct by
 * inspection, and the jail is the part that stays correct if this is ever
 * called from somewhere new.
 *
 * Note that `src` IS accepted, even though locale detection ignores a `src/`
 * folder. That rule is about misreading a directory a repository happens to have; here the key is a name
 * the user chose, and `src` is genuinely Logudorese Sardinian — refusing it
 * would be this tool deciding somebody's locale does not exist.
 */
export function guideKeyToName(key: string): string {
  if (key === GLOBAL_GUIDE_KEY) return GLOBAL_GUIDE;
  if (!looksLikeLocaleTag(key)) {
    throw badRequest(
      `"${key}" is not a style guide. Use "${GLOBAL_GUIDE_KEY}" or a locale tag such as "de" or "pt-BR".`,
    );
  }
  return `${key}.md`;
}

/** The inverse, for a filename already on disk. Null for anything unexpected. */
export function guideNameToKey(name: string): string | null {
  if (name === GLOBAL_GUIDE) return GLOBAL_GUIDE_KEY;
  if (!name.endsWith('.md')) return null;
  const key = name.slice(0, -'.md'.length);
  return looksLikeLocaleTag(key) ? key : null;
}

/**
 * Every guide that exists, global first and the locales in tag order.
 *
 * A file the directory contains but this function cannot name — a stray
 * `README.md`, an editor's backup — is skipped rather than reported. The
 * directory belongs to the user's repository; listing it is not the same as
 * owning everything in it.
 */
export async function listStyleGuides(projectPath: string): Promise<StyleGuideSummary[]> {
  const names = await readdir(await styleGuideDirOf(projectPath)).catch(() => [] as string[]);
  const summaries: StyleGuideSummary[] = [];

  for (const name of names.sort()) {
    const key = guideNameToKey(name);
    if (key === null) continue;
    const guide = await readStyleGuide(projectPath, name);
    if (guide === null) continue;
    summaries.push({
      key,
      name,
      locale: key === GLOBAL_GUIDE_KEY ? null : key,
      tokens: estimateTokens(guide.text),
      bytes: Buffer.byteLength(guide.text, 'utf8'),
    });
  }

  return summaries.sort((a, b) =>
    a.key === GLOBAL_GUIDE_KEY ? -1 : b.key === GLOBAL_GUIDE_KEY ? 1 : a.key.localeCompare(b.key),
  );
}

/**
 * Write one guide, or remove it when the editor has been emptied.
 *
 * Emptying deletes rather than leaving a blank file, because a zero-byte
 * `de.md` in somebody's repository is a question ("is this deliberate?") where
 * its absence is an answer. `readStyleGuide` already treats the two the same,
 * so nothing downstream can tell the difference — this is about the diff.
 *
 * A trailing newline is added if the user did not type one: it is a text file
 * in a Git repository, and a missing final newline is a diff-noise generator.
 */
export async function writeStyleGuide(
  cfg: ServerConfig,
  projectPath: string,
  key: string,
  text: string,
): Promise<void> {
  const name = guideKeyToName(key);

  if (text.trim() === '') {
    await deleteStyleGuide(cfg, projectPath, key);
    return;
  }

  // A linked folder is somebody else's repository: it must already be there
  // rather than be created, and `.lexi/`'s `.gitignore` has no business in it.
  const linked = (await readSharedSources(projectPath)).styleguides;
  if (linked === null) await ensureLexiDir(cfg, projectPath);
  else await requireLinkedFolder(linked);
  const dir = await resolveForCreate(await styleGuideDirOf(projectPath), cfg);
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, name), text.endsWith('\n') ? text : `${text}\n`);
}

/** Removing one that was never written is success, not a 404. */
export async function deleteStyleGuide(
  cfg: ServerConfig,
  projectPath: string,
  key: string,
): Promise<void> {
  const name = guideKeyToName(key);
  const dir = await resolveForCreate(await styleGuideDirOf(projectPath), cfg);
  await rm(join(dir, name), { force: true });
}

/** Whether the file is actually there — the editor shows a template if not. */
export async function styleGuideExists(projectPath: string, key: string): Promise<boolean> {
  const name = guideKeyToName(key);
  return stat(await styleGuidePath(projectPath, name))
    .then((s) => s.isFile())
    .catch(() => false);
}
