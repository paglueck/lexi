// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, createXliffDocument, type CreateUnitSpec } from '@lexi/xliff';
import {
  PHRASE_HOSTS,
  type PhraseCheckoutRequest,
  type PhraseCheckoutScope,
  type PhraseCheckoutResult,
  type PhraseCheckoutStep,
  type PhraseCheckoutStepState,
  type PhraseOrigin,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { EventBus } from '../lib/event-bus.js';
import { HttpError, badRequest, conflict, notFound, upstream } from '../lib/http-error.js';
import { JailError, resolveForCreate } from '../lib/paths.js';
import { writeLexiJson } from '../lib/lexi-dir.js';
import { recentIdFor, recordRecent } from '../lib/recents.js';
import {
  PhraseClient,
  PhraseError,
  type PhraseClientOptions,
  type PhraseKeyRow,
  type PhraseTranslationRow,
} from './phrase-client.js';
import { writePhraseConfig } from './phrase-config.js';
import type { SettingsService } from './settings-service.js';

/**
 * S18 — check a Phrase project out as a local XLIFF project: every key, or the
 * keys carrying any of one or more tags.
 *
 * Six steps, each a row of the dialog's log and a `phrase-checkout-progress`
 * event: fetch the keys (one paged list per tag, merged by key id — Phrase's
 * multi-tag search is not relied on), fetch their base text, write the base file, write the
 * target files, write the origin (`.lexi/phrase.json`, `.lexi/project.json`,
 * `.phrase.yml`), add the project to the recents.
 *
 * "Never leave a half-written project behind" is enforced by where the files
 * go, not by cleaning up afterwards: everything is written into a hidden
 * sibling, `{parent}/.{folder}.lexi-partial-{random}`, which is renamed into
 * place only once complete. A failure removes the sibling; the folder the user
 * named never exists in a half state. The dot keeps the sibling out of every
 * scan if a crash ever does leave one.
 *
 * Only the fetch is cancellable. Once writing starts it is quick, and a cancel
 * in the middle would only race the rename.
 *
 * One checkout at a time: the events carry no id, and two dialogs could not
 * tell their rows apart.
 */

/** What the client of a checkout needs from the route's test seams. */
export interface PhraseCheckoutOptions {
  readonly client?: Partial<Pick<PhraseClientOptions, 'fetch' | 'delay'>> | undefined;
  /** Runs after the files are written and before the rename — a test's fault injection point. */
  readonly beforeRename?: ((tempDir: string) => Promise<void>) | undefined;
}

/** A failure that already says which step it belongs to and what to show. */
class StepError extends Error {
  constructor(
    message: string,
    readonly http: HttpError,
  ) {
    super(message);
  }
}

const FOLDER_COPY = {
  empty: 'Enter a folder name.',
  separator: "A folder name can't contain / or :",
  dots: "A folder name can't be . or ..",
  exists: 'This folder already exists. Choose another name.',
  outside: 'This folder is outside the folders Lexi may write to.',
  notAbsolute: 'Choose a full folder path.',
  invalid: 'This folder path is not valid.',
  parentNotDir: 'The parent folder is a file.',
} as const;

/** Where a validated checkout goes. */
export interface CheckoutTarget {
  /** Jailed, realpath'd where it exists; may not exist yet. */
  readonly parent: string;
  readonly folder: string;
  readonly path: string;
}

/**
 * The folder checks of step 3, without writing anything. An existing EMPTY
 * folder is fine — it is what "New Folder" in a file manager leaves behind.
 */
export async function validateCheckoutTarget(
  cfg: ServerConfig,
  parentDir: string,
  folderName: string,
): Promise<{ error: string } | CheckoutTarget> {
  const folder = folderName.trim();
  if (folder === '') return { error: FOLDER_COPY.empty };
  if (/[/\\:]/.test(folder) || folder.includes('\0')) return { error: FOLDER_COPY.separator };
  if (folder === '.' || folder === '..') return { error: FOLDER_COPY.dots };

  let parent: string;
  try {
    parent = await resolveForCreate(parentDir, cfg);
  } catch (error) {
    if (!(error instanceof JailError)) throw error;
    return {
      error:
        error.message === 'path must be absolute'
          ? FOLDER_COPY.notAbsolute
          : error.message === 'outside the allowed roots'
            ? FOLDER_COPY.outside
            : FOLDER_COPY.invalid,
    };
  }

  const parentStat = await stat(parent).catch(() => null);
  if (parentStat !== null && !parentStat.isDirectory()) return { error: FOLDER_COPY.parentNotDir };

  const path = join(parent, folder);
  const existing = await stat(path).catch(() => null);
  if (existing !== null) {
    if (!existing.isDirectory()) return { error: FOLDER_COPY.exists };
    const entries = await readdir(path).catch(() => ['?']);
    if (entries.length > 0) return { error: FOLDER_COPY.exists };
  }
  return { parent, folder, path };
}

export class PhraseCheckout {
  #running: { readonly controller: AbortController; phase: 'fetch' | 'write' } | null = null;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly settings: SettingsService,
    private readonly bus: EventBus,
    private readonly opts: PhraseCheckoutOptions = {},
  ) {}

  get running(): boolean {
    return this.#running !== null;
  }

  /**
   * Abort a checkout that is still fetching. `'idle'` when none runs,
   * `'writing'` when it is past the point of no return.
   */
  cancel(): 'cancelled' | 'idle' | 'writing' {
    const run = this.#running;
    if (run === null) return 'idle';
    if (run.phase === 'write') return 'writing';
    run.controller.abort();
    return 'cancelled';
  }

  async run(req: PhraseCheckoutRequest): Promise<PhraseCheckoutResult> {
    if (this.#running !== null) throw conflict('A checkout is already running.');
    const run = { controller: new AbortController(), phase: 'fetch' as 'fetch' | 'write' };
    this.#running = run;
    try {
      return await this.#run(req, run);
    } finally {
      this.#running = null;
    }
  }

  async #run(
    req: PhraseCheckoutRequest,
    run: { readonly controller: AbortController; phase: 'fetch' | 'write' },
  ): Promise<PhraseCheckoutResult> {
    const target = await validateCheckoutTarget(this.cfg, req.parentDir, req.folderName);
    if ('error' in target) throw badRequest(target.error);
    const secret = this.settings.tokenSecret(req.tokenId);
    if (secret === null) throw notFound('No saved Phrase token with that id.');

    const signal = run.controller.signal;
    let step: PhraseCheckoutStep = 'fetch-keys';
    const emit = (state: PhraseCheckoutStepState, detail = ''): void =>
      this.bus.publish({ type: 'phrase-checkout-progress', step, state, detail });

    const client = new PhraseClient({
      token: secret.token,
      region: secret.region,
      ...this.opts.client,
      onWait: () => emit('waiting', 'Waiting for Phrase rate limit…'),
      onWaitEnd: () => emit('running'),
    });

    let temp: string | null = null;
    try {
      /* 1 — keys */
      emit('running');
      const branch = req.branch ?? null;
      const [project, locales, branches] = await Promise.all([
        client.project(req.projectId),
        client.listLocales(req.projectId, { signal, branch }),
        branch === null ? [] : client.listBranches(req.projectId, { signal }),
      ]);
      if (branch !== null && !branches.some((b) => b.name === branch)) {
        throw stepError(notFound(`Phrase project has no open branch ${branch}.`));
      }
      const base = locales.find((l) => l.isDefault);
      if (base === undefined || base.code === '') {
        throw stepError(badRequest('This Phrase project has no default locale.'));
      }
      const byCode = new Map(locales.map((l) => [l.code, l]));
      const targets = [...new Set(req.locales)].filter((code) => code !== base.code);
      const unknown = targets.filter((code) => !byCode.has(code));
      if (unknown.length > 0) {
        throw stepError(badRequest(`The Phrase project has no locale ${unknown.join(', ')}.`));
      }
      const unsafe = targets.filter((code) => !SAFE_LOCALE.test(code));
      if (!SAFE_LOCALE.test(base.code) || unsafe.length > 0) {
        throw stepError(
          badRequest(
            `Locale code ${[base.code, ...unsafe].find((c) => !SAFE_LOCALE.test(c))} cannot be a file name.`,
          ),
        );
      }
      if (targets.length === 0) throw stepError(badRequest('Choose at least one target locale.'));

      const tags = scopeTags(req.scope);
      // Mid-list the count may include keys an earlier tag already had.
      const running = (n: number, what: string, i: number): string =>
        tags.length > 1 ? `${n} ${what} · tag ${i + 1}/${tags.length}` : `${n} ${what}`;

      const { keys, requests } = await fetchScopeKeys(client, req.projectId, req.scope, {
        signal,
        branch,
        onPage: (n, i) => emit('running', running(n, 'keys', i)),
      });
      if (keys.length === 0) {
        throw stepError(
          badRequest(
            req.scope.kind === 'all'
              ? 'This project has no keys.'
              : `No keys are tagged ${req.scope.tags.join(', ')}.`,
          ),
        );
      }
      emit('done', `${keys.length} keys · ${requests} ${requests === 1 ? 'request' : 'requests'}`);

      /* 2 — base text */
      step = 'fetch-base';
      emit('running');
      const translations = await fetchScopeBase(client, req.projectId, base.id, req.scope, {
        signal,
        branch,
        onPage: (n, i) => emit('running', running(n, 'translations', i)),
      });
      const units = unitsOf(keys, translations);
      const missing = units.filter((u) => u.missingText).length;
      emit(
        'done',
        `${units.length - missing} translations` +
          (missing === 0
            ? ''
            : ` · ${missing} ${missing === 1 ? 'key has' : 'keys have'} no base text`),
      );

      // Past this point the checkout runs to the end or rolls back.
      if (signal.aborted) throw new PhraseError('Cancelled.', 'aborted');
      run.phase = 'write';

      /* 3 — base file */
      step = 'write-base';
      emit('running');
      await mkdir(target.parent, { recursive: true });
      temp = join(
        target.parent,
        `.${target.folder}.lexi-partial-${randomBytes(4).toString('hex')}`,
      );
      await mkdir(temp);
      const files: string[] = [];
      const write = async (relPath: string, text: string): Promise<void> => {
        await atomicWrite(join(temp as string, relPath), text);
        files.push(relPath);
      };
      await write('messages.xlf', createXliffDocument({ sourceLanguage: base.code, units }));
      emit('done', `source-language="${base.code}" · ${units.length} units`);

      /* 4 — target files */
      step = 'write-targets';
      emit('running');
      const targetFiles = targets.map((code) => ({
        relPath: `messages.${code}.xlf`,
        locale: code,
      }));
      for (const { relPath, locale } of targetFiles) {
        await write(
          relPath,
          createXliffDocument({
            sourceLanguage: base.code,
            targetLanguage: locale,
            units: units.map((u) => ({ ...u, emptyTarget: true })),
          }),
        );
      }
      emit('done', targets.join(', '));

      /* 5 — origin */
      step = 'write-origin';
      emit('running');
      // The mapping names the base explicitly: `messages.xlf` carries no locale
      // in its name, and without this line a resume would leave it out.
      await writeLexiJson(this.cfg, temp, 'project.json', {
        version: 1,
        sourceLocale: base.code,
        visibleLocales: [],
        mapping: [
          { relPath: 'messages.xlf', fileIndex: 0, locale: base.code },
          ...targetFiles.map((f) => ({ relPath: f.relPath, fileIndex: 0, locale: f.locale })),
        ],
      });
      files.push('.lexi/project.json');
      const origin: PhraseOrigin = {
        region: secret.region,
        projectId: req.projectId,
        projectName: project.name,
        branch,
        scope: req.scope,
        baseLocale: base.code,
        locales: targets,
        keyIds: keys.map((k) => k.id),
        fetchedAt: new Date().toISOString(),
        tokenRef: secret.id,
      };
      await writeLexiJson(this.cfg, temp, 'phrase.json', origin);
      files.push('.lexi/phrase.json');
      // Targets only: the base is Phrase's own text, and pushing it back would
      // overwrite whatever changed there since the checkout.
      files.push(
        await writePhraseConfig(
          temp,
          req.projectId,
          // Pinned by id where the code names exactly one locale; two locales
          // sharing a code stay a code, and the push status says so.
          targetFiles.map((f) => {
            const same = locales.filter((l) => l.code === f.locale);
            return { ...f, target: same.length === 1 ? (same[0] ?? null) : null };
          }),
          {
            ...(req.scope.kind === 'tags' ? { tags: req.scope.tags.join(',') } : {}),
            ...(secret.region === 'US' ? { host: PHRASE_HOSTS.US } : {}),
            ...(branch === null ? {} : { branch }),
          },
        ),
      );

      await this.opts.beforeRename?.(temp);
      const existing = await stat(target.path).catch(() => null);
      // Validated empty above; `rmdir` refuses if something appeared since.
      if (existing !== null) await rmdir(target.path);
      await rename(temp, target.path);
      temp = null;
      emit(
        'done',
        [
          'Phrase project',
          ...(branch === null ? [] : ['branch']),
          ...(req.scope.kind === 'all' ? [] : [req.scope.tags.length === 1 ? 'tag' : 'tags']),
          'key ids, fetch time',
        ].join(', '),
      );

      /* 6 — recents */
      step = 'add-recent';
      emit('running');
      await recordRecent(this.cfg, {
        id: recentIdFor(target.path),
        path: target.path,
        name: target.folder,
        openedAt: new Date().toISOString(),
        localeCount: targets.length,
        unitCount: units.length * targets.length,
        coverage: { translated: 0, draft: 0, needsReview: 0 },
      });
      await this.settings.setLastParentDir(target.parent);
      emit('done', 'Shown in the launch menu');

      return { path: target.path, files, keys: keys.length };
    } catch (error) {
      if (temp !== null) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      const http = asHttpError(error);
      emit('failed', http.message);
      throw http;
    }
  }
}

/** Locale codes that are safe as part of `messages.{code}.xlf`. */
const SAFE_LOCALE = /^[A-Za-z0-9][A-Za-z0-9_@.-]*$/;

/** One list per tag; `undefined` stands for "no tag" — one list of every key. */
function scopeTags(scope: PhraseCheckoutScope): ReadonlyArray<string | undefined> {
  return scope.kind === 'all' ? [undefined] : scope.tags;
}

/** Progress of a scope fetch: rows so far (across tags) while on tag `tagIndex`. */
interface ScopeFetchOptions {
  readonly signal?: AbortSignal | undefined;
  /** Read this branch rather than the main project. */
  readonly branch?: string | null | undefined;
  readonly onPage?: ((rowsSoFar: number, tagIndex: number) => void) | undefined;
}

/**
 * Every key of a scope: one paged list per tag (Phrase's multi-tag search is
 * not relied on), merged by key id in first-seen order — a key with two of the
 * tags comes once, where its first tag put it. `requests` counts the pages.
 */
export async function fetchScopeKeys(
  client: PhraseClient,
  projectId: string,
  scope: PhraseCheckoutScope,
  options: ScopeFetchOptions = {},
): Promise<{ keys: PhraseKeyRow[]; requests: number }> {
  const keys: PhraseKeyRow[] = [];
  const keyIds = new Set<string>();
  let requests = 0;
  for (const [i, tag] of scopeTags(scope).entries()) {
    let pages = 0;
    const rows = await client.listKeys(projectId, tag, {
      signal: options.signal,
      branch: options.branch,
      onPage: (n, page) => {
        pages = page;
        options.onPage?.(keys.length + n, i);
      },
    });
    requests += pages;
    for (const key of rows) {
      if (keyIds.has(key.id)) continue;
      keyIds.add(key.id);
      keys.push(key);
    }
  }
  return { keys, requests };
}

/**
 * The base locale's translations of a scope's keys, one paged list per tag.
 * A key with two of the tags comes back for both; the first copy is kept.
 */
export async function fetchScopeBase(
  client: PhraseClient,
  projectId: string,
  baseLocaleId: string,
  scope: PhraseCheckoutScope,
  options: ScopeFetchOptions = {},
): Promise<PhraseTranslationRow[]> {
  const translations: PhraseTranslationRow[] = [];
  const covered = new Set<string>();
  for (const [i, tag] of scopeTags(scope).entries()) {
    const rows = await client.listTranslations(projectId, baseLocaleId, {
      tag,
      signal: options.signal,
      branch: options.branch,
      onPage: (n) => options.onPage?.(translations.length + n, i),
    });
    const seen = new Set<string>();
    for (const row of rows) {
      if (covered.has(row.keyId)) continue;
      seen.add(row.keyId);
      translations.push(row);
    }
    for (const id of seen) covered.add(id);
  }
  return translations;
}

/**
 * Each key with the translation that is its base text: a plural key has one
 * translation per form, and its `other` form (else the first) is the source.
 * `form` is undefined for a key with no base text.
 */
export function withBaseForm(
  keys: readonly PhraseKeyRow[],
  translations: readonly PhraseTranslationRow[],
): Array<{ key: PhraseKeyRow; form: PhraseTranslationRow | undefined }> {
  const byKey = new Map<string, PhraseTranslationRow[]>();
  for (const t of translations) byKey.set(t.keyId, [...(byKey.get(t.keyId) ?? []), t]);
  return keys.map((key) => {
    const forms = byKey.get(key.id) ?? [];
    return { key, form: forms.find((f) => f.pluralSuffix === 'other') ?? forms[0] };
  });
}

/**
 * Every key of a scope with its base text — exactly the ids and sources a
 * checkout of that scope writes, in the same order. Text is '' for a key with
 * none, and for every key when the project has no default locale.
 */
export async function fetchScopeKeyTexts(
  client: PhraseClient,
  projectId: string,
  baseLocaleId: string | undefined,
  scope: PhraseCheckoutScope,
  options: Pick<ScopeFetchOptions, 'signal' | 'branch'> = {},
): Promise<Array<{ key: string; text: string }>> {
  const { keys } = await fetchScopeKeys(client, projectId, scope, options);
  const translations =
    baseLocaleId === undefined || keys.length === 0
      ? []
      : await fetchScopeBase(client, projectId, baseLocaleId, scope, options);
  return withBaseForm(keys, translations).map(({ key, form }) => ({
    key: key.name,
    text: form?.content ?? '',
  }));
}

/**
 * Join keys to their base text (see {@link withBaseForm}). A plural key's
 * other forms would need an ICU message Phrase did not write, so a note says so.
 */
function unitsOf(
  keys: readonly PhraseKeyRow[],
  translations: readonly PhraseTranslationRow[],
): Array<CreateUnitSpec & { missingText: boolean }> {
  return withBaseForm(keys, translations).map(({ key, form }) => {
    const notes = [
      ...(key.description.trim() === '' ? [] : [key.description]),
      ...(key.plural ? ['Plural key in Phrase'] : []),
    ];
    return {
      id: key.name,
      source: form?.content ?? '',
      notes,
      missingText: form === undefined,
    };
  });
}

const stepError = (http: HttpError): StepError => new StepError(http.message, http);

function asHttpError(error: unknown): HttpError {
  if (error instanceof StepError) return error.http;
  if (error instanceof HttpError) return error;
  if (error instanceof PhraseError) {
    if (error.kind === 'aborted') return conflict('Checkout cancelled.');
    if (error.kind === 'config') return badRequest(error.message);
    return upstream(error.message);
  }
  // The code, not the message: an fs message carries absolute paths.
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new HttpError(
    500,
    'internal',
    `Could not write the project${typeof code === 'string' ? ` (${code})` : ''}.`,
  );
}
