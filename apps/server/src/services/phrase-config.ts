// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { glob, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { Document, isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';
import {
  PhraseParamValueSchema,
  type PhraseLocaleRef,
  type PhraseParamValue,
  type PhrasePushFile,
  type PhraseRegionCode,
  type PhraseTokenSource,
  PHRASE_HOSTS,
} from '@lexi/shared';

import { conflict } from '../lib/http-error.js';
import { DEFAULT_PHRASE_HOST } from './phrase-client.js';
import { xliffSide, xliffUploadOptions, type XliffSide } from '../lib/xliff-language.js';

/**
 * `.phrase.yml` — the Phrase CLI's config, read the way `phrase push` reads it.
 *
 * Only the push half matters to lexi. A source is a `file` pattern plus the
 * upload `params`; the pattern may carry `<locale_name>`, `<locale_code>` and
 * `<tag>` placeholders and the `*` / `**` wildcards, and is relative to the
 * folder the config lives in — the project root, for lexi.
 *
 * What is not understood is reported, not guessed: a source whose locale cannot
 * be worked out, or a pattern that matches no file, becomes a sentence in
 * `problems` and is left out of the push.
 */

export const PHRASE_CONFIG_FILES = ['.phrase.yml', '.phrase.yaml'] as const;

const SourceSchema = z.object({
  file: z.string().min(1),
  project_id: z.string().optional(),
  params: z.record(z.string(), PhraseParamValueSchema).optional(),
});

const ConfigSchema = z.object({
  phrase: z.object({
    access_token: z.string().optional(),
    project_id: z.string().optional(),
    file_format: z.string().optional(),
    host: z.string().optional(),
    push: z.object({ sources: z.array(SourceSchema).optional() }).optional(),
  }),
});

export interface PhraseConfig {
  /** Relative to the project root. */
  readonly file: string;
  readonly projectId: string | null;
  readonly accessToken: string | null;
  /** The config's `host`, or the EU default when it names none. */
  readonly host: string;
  /** Whether `host` was written in the file, so it beats a token's data center. */
  readonly hostSet: boolean;
  readonly fileFormat: string | null;
  readonly sources: ReadonlyArray<z.infer<typeof SourceSchema>>;
}

/** `null` when there is no config; throws a readable error when there is a broken one. */
export async function readPhraseConfig(root: string): Promise<PhraseConfig | null> {
  for (const name of PHRASE_CONFIG_FILES) {
    const text = await readFile(join(root, name), 'utf8').catch(() => null);
    if (text === null) continue;

    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (error) {
      throw new PhraseConfigError(`${name} is not valid YAML: ${(error as Error).message}`);
    }
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new PhraseConfigError(
        `${name} is not a Phrase config: ${issue?.path.join('.') || 'phrase'} — ${issue?.message ?? 'invalid'}`,
      );
    }
    const phrase = parsed.data.phrase;
    return {
      file: name,
      projectId: blankToNull(phrase.project_id),
      accessToken: blankToNull(phrase.access_token),
      host: blankToNull(phrase.host) ?? DEFAULT_PHRASE_HOST,
      hostSet: blankToNull(phrase.host) !== null,
      fileFormat: blankToNull(phrase.file_format),
      sources: phrase.push?.sources ?? [],
    };
  }
  return null;
}

export class PhraseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhraseConfigError';
  }
}

/** The token a Phrase call uses, where it came from, and the API base it goes to. */
export interface ResolvedPhraseToken {
  readonly token: string;
  readonly source: PhraseTokenSource;
  readonly host: string;
}

/**
 * The token to push with, and where it came from: a token saved in lexi first
 * (the caller has already picked it — `.lexi/phrase.json`'s `tokenRef`, else
 * the first valid one), then the config file, then the environment variable
 * the CLI also honours.
 *
 * The host is the config's `host` when it sets one — it is the project's
 * statement of where it lives — and otherwise the saved token's data center.
 */
export function resolvePhraseToken(
  saved: { readonly token: string; readonly region: PhraseRegionCode } | null,
  config: PhraseConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPhraseToken | null {
  const configHost = config?.hostSet ? config.host : null;
  if (saved !== null && saved.token.trim() !== '') {
    return {
      token: saved.token.trim(),
      source: 'settings',
      host: configHost ?? PHRASE_HOSTS[saved.region],
    };
  }
  const host = configHost ?? DEFAULT_PHRASE_HOST;
  if (config?.accessToken) return { token: config.accessToken, source: 'config', host };
  const fromEnv = env['PHRASE_ACCESS_TOKEN']?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env', host };
  return null;
}

/** Placeholders the CLI substitutes. Each matches one path segment's worth. */
const PLACEHOLDER = /<(locale_name|locale_code|tag)>/g;

/** Never descended into: the same list the project scan skips, plus VCS dirs. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.lexi', '.angular', 'dist', '.hg', '.svn']);

/**
 * Every file the config's push sources resolve to, one entry per file.
 *
 * A file matched by two sources is pushed twice, as `phrase push` would — the
 * config is the user's statement of intent and lexi does not second-guess it.
 */
export async function resolvePushSources(
  root: string,
  config: PhraseConfig,
): Promise<{ files: PhrasePushFile[]; problems: string[] }> {
  const files: PhrasePushFile[] = [];
  const problems: string[] = [];

  if (config.sources.length === 0) {
    problems.push(`${config.file} has no push.sources — there is nothing to push.`);
  }

  for (const source of config.sources) {
    const projectId = sourceProjectId(source, config);
    if (projectId === null) {
      problems.push(`No project_id for ${source.file}.`);
      continue;
    }

    const pattern = normalisePattern(source.file);
    const placeholders = [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1]);
    const fixedLocale = paramString(source.params, 'locale_id');
    const localeFrom = placeholders.find((p) => p === 'locale_name' || p === 'locale_code');
    if (fixedLocale === null && localeFrom === undefined) {
      problems.push(
        `${source.file} has neither a <locale_name> placeholder nor params.locale_id, so its locale is unknown.`,
      );
      continue;
    }

    const params: Record<string, PhraseParamValue> = {};
    if (config.fileFormat !== null) params['file_format'] = config.fileFormat;
    for (const [key, value] of Object.entries(source.params ?? {})) {
      if (key === 'project_id' || key === 'locale_id') continue;
      params[key] = value;
    }

    const matcher = patternToRegExp(pattern);
    const matched = (await listMatches(root, pattern)).flatMap((relPath) => {
      const match = matcher.exec(relPath);
      return match === null ? [] : [{ relPath, groups: match.groups ?? {} }];
    });
    if (matched.length === 0) {
      problems.push(`${source.file} matches no file.`);
      continue;
    }

    for (const { relPath, groups } of matched) {
      const tag = groups['tag'];
      const fileParams = { ...params };
      // `<tag>` in the path tags the upload with it, as the CLI does.
      if (tag !== undefined) fileParams['tags'] = mergeTags(fileParams['tags'], tag);
      const localeId =
        fixedLocale ?? (localeFrom === undefined ? undefined : groups[localeFrom]) ?? '';
      files.push({ relPath, localeId, projectId, params: fileParams });
    }
  }

  return { files, problems };
}

/** The Phrase project a source pushes to: its own, else the config's. */
function sourceProjectId(
  source: z.infer<typeof SourceSchema>,
  config: PhraseConfig,
): string | null {
  return (
    blankToNull(source.project_id) ?? paramString(source.params, 'project_id') ?? config.projectId
  );
}

/* -- locales ------------------------------------------------------------------ */

export type PhraseLocaleMatch =
  | { readonly kind: 'ok'; readonly locale: PhraseLocaleRef }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly matches: readonly PhraseLocaleRef[] };

/**
 * The one Phrase locale a config's `locale_id` means — strictly.
 *
 * An id wins outright. Otherwise exactly one locale may carry the value as its
 * code or its name; two different locales doing so (one's code, the other's
 * name: "Developer-German" with code `de` next to a locale named `de`) is
 * ambiguous, and nothing is guessed. Phrase creates a locale for a name it
 * does not know, so pushing on a guess can add one — which is exactly what
 * this refuses to risk.
 */
export function resolvePhraseLocale(
  value: string,
  locales: readonly PhraseLocaleRef[],
): PhraseLocaleMatch {
  const byId = locales.find((l) => l.id === value);
  if (byId !== undefined) return { kind: 'ok', locale: pick(byId) };
  const matches = locales.filter((l) => l.code === value || l.name === value).map(pick);
  const unique = [...new Map(matches.map((l) => [l.id, l])).values()];
  if (unique.length === 0) return { kind: 'missing' };
  if (unique.length === 1) return { kind: 'ok', locale: unique[0] as PhraseLocaleRef };
  return { kind: 'ambiguous', matches: unique };
}

/** The sentence for a locale that does not resolve; null when it does. */
export function phraseLocaleProblem(value: string, match: PhraseLocaleMatch): string | null {
  switch (match.kind) {
    case 'ok':
      return null;
    case 'missing':
      return `The Phrase project has no locale "${value}". Create it in Phrase first, or change locale_id — lexi never lets a push create one.`;
    case 'ambiguous':
      return `"${value}" matches ${match.matches.length} Phrase locales: ${match.matches
        .map((l) => `${l.name} (code ${l.code}, id ${l.id})`)
        .join(', ')}. Put the locale id into .phrase.yml (lexi can pin it).`;
  }
}

/** "Developer-German (de)" — how a resolved locale is named to a person. */
export function describePhraseLocale(locale: PhraseLocaleRef): string {
  return locale.name === locale.code ? locale.name : `${locale.name} (${locale.code})`;
}

const pick = (l: PhraseLocaleRef): PhraseLocaleRef => ({ id: l.id, name: l.name, code: l.code });

/**
 * Sources whose `params.locale_id` names a locale by code or name rather than
 * by id — what `pinLocaleIds` would rewrite. Placeholder sources have no
 * `locale_id` and are not counted.
 */
export function unpinnedSources(
  config: PhraseConfig,
  localesOf: (projectId: string) => readonly PhraseLocaleRef[] | undefined,
): number {
  let count = 0;
  for (const source of config.sources) {
    const value = paramString(source.params, 'locale_id');
    const projectId = sourceProjectId(source, config);
    if (value === null || projectId === null) continue;
    const locales = localesOf(projectId);
    const byName = locales !== undefined && !locales.some((l) => l.id === value);
    if (byName || missingSideOption(source.params)) count++;
  }
  return count;
}

/**
 * Sentences for sources that set `override_file_language` but ignore neither
 * side of the XLIFF: Phrase refuses such an upload ("the file contains more
 * than one source or target languages"), so a `phrase push` of them fails.
 * lexi's own push adds the option itself; pinning writes it into the file.
 */
export function sideOptionProblems(config: PhraseConfig): string[] {
  return config.sources
    .filter((source) => formatOptions(source.params)['override_file_language'] === true)
    .filter((source) => missingSideOption(source.params))
    .map(
      (source) =>
        `${source.file}: ${config.file} sets override_file_language without ignore_source_translations or ignore_target_translations, so the Phrase CLI's push of it fails. Pin the locale ids to add it.`,
    );
}

/** Neither `ignore_source_translations` nor `ignore_target_translations` is written. */
function missingSideOption(
  params: Readonly<Record<string, PhraseParamValue>> | undefined,
): boolean {
  const options = formatOptions(params);
  return (
    options['ignore_source_translations'] === undefined &&
    options['ignore_target_translations'] === undefined
  );
}

function formatOptions(
  params: Readonly<Record<string, PhraseParamValue>> | undefined,
): Readonly<Record<string, unknown>> {
  const value = params?.['format_options'];
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * The side of the XLIFF a fixed (placeholder-free) source points at; null
 * when its file cannot be read or the pattern names several.
 */
async function sideOfSource(
  root: string,
  source: z.infer<typeof SourceSchema>,
): Promise<XliffSide | null> {
  const relPath = normalisePattern(source.file);
  if (/[*<]/.test(relPath)) return null;
  const text = await readFile(join(root, relPath), 'utf8').catch(() => null);
  return text === null ? null : xliffSide(text);
}

/**
 * Rewrite every `params.locale_id` of the config to the Phrase locale id it
 * resolves to, with the locale's name as a comment. Comments and layout of
 * the rest of the file are kept (the file is edited, not regenerated).
 *
 * All or nothing: when one value is missing or ambiguous, nothing is written
 * and the problems say which.
 */
export async function pinLocaleIds(
  root: string,
  config: PhraseConfig,
  localesOf: (projectId: string) => Promise<readonly PhraseLocaleRef[]>,
): Promise<{ pinned: number; problems: string[] }> {
  const path = join(root, config.file);
  const doc = parseDocument(await readFile(path, 'utf8'));
  const sources = doc.getIn(['phrase', 'push', 'sources'], true);
  if (!isSeq(sources)) return { pinned: 0, problems: [] };

  const problems: string[] = [];
  const edits: Array<{ index: number; locale: PhraseLocaleRef | null; side: XliffSide | null }> =
    [];
  for (const [index, source] of config.sources.entries()) {
    const value = paramString(source.params, 'locale_id');
    const projectId = sourceProjectId(source, config);
    if (value === null || projectId === null) continue;
    const match = resolvePhraseLocale(value, await localesOf(projectId));
    const problem = phraseLocaleProblem(value, match);
    if (problem !== null) {
      problems.push(`${source.file}: ${problem}`);
      continue;
    }
    const locale = match.kind === 'ok' && match.locale.id !== value ? match.locale : null;
    const side = missingSideOption(source.params) ? await sideOfSource(root, source) : null;
    if (locale !== null || side !== null) edits.push({ index, locale, side });
  }
  if (problems.length > 0 || edits.length === 0) return { pinned: 0, problems };

  for (const { index, locale, side } of edits) {
    const params = doc.getIn(['phrase', 'push', 'sources', index, 'params'], true);
    if (!isMap(params)) continue;
    if (locale !== null) {
      const node = doc.createNode(locale.id);
      node.comment = ` ${describePhraseLocale(locale)}`;
      params.set('locale_id', node);
    }
    // So the CLI (and CI) use the id too, instead of the file's target-language
    // — with one side of the XLIFF ignored, which Phrase requires for that.
    // Options already written are left as they are.
    if (params.has('format_options') && !isMap(params.get('format_options', true))) continue;
    if (!params.has('format_options')) params.set('format_options', doc.createNode({}));
    const wanted = side === null ? { override_file_language: true } : xliffUploadOptions(side);
    for (const [key, value] of Object.entries(wanted)) {
      if (!params.hasIn(['format_options', key])) params.setIn(['format_options', key], value);
    }
  }
  await writeFile(path, doc.toString(), 'utf8');
  return { pinned: edits.length, problems: [] };
}

/**
 * Write a new `.phrase.yml` for a Phrase project, from lexi's locale mapping —
 * one source per mapped file, each with its locale spelled out. Explicit rather
 * than a `<locale_name>` pattern, because lexi's mapping is explicit and a
 * pattern would have to be inferred from file names that need not agree.
 *
 * Never overwrites: a config that exists is somebody's, and lexi reads it.
 * The token is deliberately not written — the file is meant to be committed.
 *
 * A mapping entry with a `target` writes that Phrase locale's id as
 * `locale_id`, its name as a comment: an id is the one value Phrase cannot
 * read as some other locale. Without one, `locale` is written as it is.
 *
 * A checkout passes only its target files, with the tags it came from in
 * `options.tags` (comma-separated; none for an all-keys checkout) so a push
 * tags new keys the way they were found, and `host` when the token lives in
 * the US data center — the CLI would otherwise talk to the EU one.
 */
export async function writePhraseConfig(
  root: string,
  projectId: string,
  mapping: ReadonlyArray<{
    relPath: string;
    locale: string;
    target?: PhraseLocaleRef | null;
    /** Which side of the XLIFF the file is pushed for; a translation unless said. */
    side?: XliffSide;
  }>,
  options: {
    readonly tags?: string | undefined;
    readonly host?: string | undefined;
    /** The branch every source pushes to; left out for the main project. */
    readonly branch?: string | null | undefined;
  } = {},
): Promise<string> {
  for (const name of PHRASE_CONFIG_FILES) {
    const exists = await readFile(join(root, name), 'utf8').then(
      () => true,
      () => false,
    );
    if (exists) throw conflict(`${name} already exists in this project.`);
  }

  const seen = new Set<string>();
  const entries = mapping
    .filter((m) => (seen.has(m.relPath) ? false : (seen.add(m.relPath), true)))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const sources = entries.map((m) => ({
    file: `./${m.relPath}`,
    params: {
      file_format: 'xlf',
      locale_id: m.target?.id ?? m.locale,
      update_translations: true,
      // Phrase otherwise reads the locale from the file's target-language, by
      // name, and creates a locale when no name matches — the CLI included.
      // With a fixed locale it takes one side of the XLIFF only, so the other
      // is ignored.
      format_options: xliffUploadOptions(m.side ?? 'target'),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
      ...(options.branch == null ? {} : { branch: options.branch }),
    },
  }));

  const doc = new Document({
    phrase: {
      project_id: projectId,
      ...(options.host === undefined ? {} : { host: options.host }),
      file_format: 'xlf',
      push: { sources },
    },
  });
  for (const [index, m] of entries.entries()) {
    if (m.target == null) continue;
    const node = doc.getIn(['phrase', 'push', 'sources', index, 'params', 'locale_id'], true);
    if (isScalar(node)) node.comment = ` ${describePhraseLocale(m.target)}`;
  }
  const body = doc.toString();
  const header =
    '# Written by lexi. The access token is not stored here: lexi keeps it in its\n' +
    '# settings, and the Phrase CLI reads PHRASE_ACCESS_TOKEN or `access_token:`.\n';

  const name = PHRASE_CONFIG_FILES[0];
  // `wx`: a file that appeared between the check above and here is not clobbered.
  await writeFile(join(root, name), header + body, { encoding: 'utf8', flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw conflict(`${name} already exists in this project.`);
      throw error;
    },
  );
  return name;
}

/* -- patterns --------------------------------------------------------------- */

/** `./a/b.xlf` → `a/b.xlf`. The CLI accepts both. */
function normalisePattern(file: string): string {
  return file
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

/**
 * The pattern as a regular expression over `/`-separated relative paths, with
 * a named group per placeholder. Repeated placeholders must agree, which is
 * what a backreference expresses.
 */
export function patternToRegExp(pattern: string): RegExp {
  const named = new Set<string>();
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const placeholder = /^<(locale_name|locale_code|tag)>/.exec(pattern.slice(i));
    if (placeholder) {
      const name = placeholder[1] as string;
      out += named.has(name) ? `\\k<${name}>` : `(?<${name}>[^/]+?)`;
      named.add(name);
      i += placeholder[0].length;
    } else if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      out += (pattern[i] as string).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Candidate files for a pattern: its placeholders widened to `*`, then globbed. */
async function listMatches(root: string, pattern: string): Promise<string[]> {
  const globPattern = pattern.replace(PLACEHOLDER, '*');
  const out: string[] = [];
  for await (const entry of glob(globPattern, {
    cwd: root,
    // Called with the path relative to `cwd`; any ignored segment rules it out.
    exclude: (path: string) => path.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part)),
  })) {
    out.push(relative(root, join(root, entry)).split(sep).join('/'));
  }
  return out.sort();
}

function mergeTags(existing: PhraseParamValue | undefined, tag: string): string {
  const list =
    typeof existing === 'string'
      ? existing
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : Array.isArray(existing)
        ? [...existing]
        : [];
  if (!list.includes(tag)) list.push(tag);
  return list.join(',');
}

function paramString(
  params: Readonly<Record<string, PhraseParamValue>> | undefined,
  key: string,
): string | null {
  const value = params?.[key];
  return typeof value === 'string' || typeof value === 'number' ? blankToNull(String(value)) : null;
}

const blankToNull = (value: string | undefined | null): string | null =>
  value === undefined || value === null || value.trim() === '' ? null : value.trim();
