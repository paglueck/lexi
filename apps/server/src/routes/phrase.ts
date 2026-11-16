// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  PhraseConnectRequestSchema,
  PhrasePushRequestSchema,
  PhraseStatusQuerySchema,
  type PhraseBranchesResponse,
  type PhraseLocaleRef,
  type PhraseOrigin,
  type PhraseParamValue,
  type PhrasePinLocalesResponse,
  type PhrasePushFile,
  type PhraseProjectsResponse,
  type PhrasePushFileResult,
  type PhrasePushResponse,
  type PhraseStatus,
  type PhraseStatusFile,
  type PhraseTestResponse,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { EventBus } from '../lib/event-bus.js';
import { HttpError, badRequest, conflict, notFound, upstream } from '../lib/http-error.js';
import { appendJobLogLine, readLexiJson } from '../lib/lexi-dir.js';
import { resolveWithinRoots } from '../lib/paths.js';
import {
  withXliffTargetLanguage,
  xliffSide,
  xliffUploadOptions,
  type XliffSide,
} from '../lib/xliff-language.js';
import { PhraseClient, PhraseError, type PhraseLocaleRow } from '../services/phrase-client.js';
import {
  PhraseConfigError,
  describePhraseLocale,
  phraseLocaleProblem,
  pinLocaleIds,
  readPhraseConfig,
  resolvePhraseLocale,
  type PhraseLocaleMatch,
  resolvePhraseToken,
  resolvePushSources,
  sideOptionProblems,
  unpinnedSources,
  writePhraseConfig,
  type PhraseConfig,
  type ResolvedPhraseToken,
} from '../services/phrase-config.js';
import type { ProjectService } from '../services/project-service.js';
import type { SettingsService } from '../services/settings-service.js';

/** Test seams: a fake Phrase server, a poll that does not wait, and a rate-limit pause. */
export interface PhraseRouteOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Replaces the client's rate-limit pause; must reject when the signal aborts. */
  readonly delay?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Checkout only: runs after the files are written, before the folder is moved into place. */
  readonly beforeCheckoutRename?: ((tempDir: string) => Promise<void>) | undefined;
}

/**
 * Phrase Strings — connect a project, and push it the way `phrase push` would.
 *
 * Everything here works on the OPEN project: the config is the one in its root,
 * and a push uploads its files as they are on disk. That is why a push refuses
 * while drafts are unsaved — they are not in the files yet, and pushing without
 * them would quietly leave out exactly the translations the user just made.
 *
 * A push never creates a Phrase locale (CI pipelines break on one). Phrase
 * creates a locale for any XLIFF whose target-language it does not know by
 * name, so: every file must resolve to exactly one existing locale before the
 * first upload; the upload names it by id with `override_file_language`; the
 * uploaded copy carries the locale's name as its target-language; and a
 * locale Phrase reports as created anyway stops the push and is named.
 */
export function registerPhrase(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  settings: SettingsService,
  bus: EventBus,
  opts: PhraseRouteOptions = {},
): void {
  const open = () => {
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    return project;
  };

  const config = async (root: string): Promise<PhraseConfig | null> => {
    try {
      return await readPhraseConfig(root);
    } catch (error) {
      if (error instanceof PhraseConfigError) throw badRequest(error.message);
      throw error;
    }
  };

  /**
   * The token a call for the open project uses: the one its checkout recorded
   * in `.lexi/phrase.json` while it is still saved, else the first valid saved
   * token, else the config's or the environment's.
   */
  const tokenFor = async (cfgFile: PhraseConfig | null): Promise<ResolvedPhraseToken | null> => {
    const root = projects.current?.path;
    const origin =
      root === undefined ? null : await readLexiJson<Partial<PhraseOrigin>>(root, 'phrase.json');
    const ref = typeof origin?.tokenRef === 'string' ? origin.tokenRef : null;
    return resolvePhraseToken(settings.resolveToken(ref), cfgFile, opts.env);
  };

  /** A client for whatever token is configured, or null when there is none. */
  const clientFor = async (cfgFile: PhraseConfig | null): Promise<PhraseClient | null> => {
    const token = await tokenFor(cfgFile);
    if (token === null) return null;
    return new PhraseClient({
      token: token.token,
      host: token.host,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
      ...(opts.delay === undefined ? {} : { delay: opts.delay }),
    });
  };

  const requireClient = async (cfgFile: PhraseConfig | null): Promise<PhraseClient> => {
    const client = await clientFor(cfgFile);
    if (client === null) {
      throw badRequest('No Phrase access token. Add one in Settings, or set PHRASE_ACCESS_TOKEN.');
    }
    return client;
  };

  /**
   * What a push of the project would do. A broken config, a missing token or
   * an unreachable Phrase are problems in the answer, not failures: the
   * screen has to say what is wrong.
   */
  const statusOf = async (root: string, branch?: string | null): Promise<PhraseStatus> => {
    const empty = {
      configFile: null,
      projectId: null,
      projectName: null,
      host: '',
      files: [],
      unpinned: 0,
      branch: null,
    };
    let cfgFile: PhraseConfig | null;
    try {
      cfgFile = await readPhraseConfig(root);
    } catch (error) {
      if (!(error instanceof PhraseConfigError)) throw error;
      return {
        ...empty,
        tokenSource: (await tokenFor(null))?.source ?? null,
        problems: [error.message],
      };
    }

    const token = await tokenFor(cfgFile);
    if (cfgFile === null) return { ...empty, tokenSource: token?.source ?? null, problems: [] };

    const resolved = await resolvePushSources(root, cfgFile);
    const sources = withPickedBranch(resolved.files, branch, cfgFile.projectId);
    const problems = [...resolved.problems, ...sideOptionProblems(cfgFile)];
    let files: PhraseStatusFile[] = sources.map((f) => ({ ...f, target: null }));
    let projectName: string | null = null;
    let unpinned = 0;
    const client = await clientFor(cfgFile);
    if (client === null) {
      problems.push('No Phrase access token. Add one in Settings, or set PHRASE_ACCESS_TOKEN.');
    } else if (cfgFile.projectId !== null) {
      // Best effort: the status must render offline too.
      try {
        // Resolved exactly as the push will: on each file's branch.
        const locales = localeLister(client);
        const projectIds = [...new Set(sources.map((f) => f.projectId))];
        const [remote, resolution, mainLists] = await Promise.all([
          client.project(cfgFile.projectId),
          resolveTargets(sources, locales),
          Promise.all(projectIds.map(async (id) => [id, await locales(id, null)] as const)),
        ]);
        projectName = remote.name;
        problems.push(...resolution.problems);
        files = sources.map((f, i) => ({ ...f, target: resolution.targets[i] ?? null }));
        // Pinning writes main-project ids; a branch push follows them by code and name.
        const byProject = new Map(mainLists);
        unpinned = unpinnedSources(cfgFile, (id) => byProject.get(id));
      } catch (error) {
        problems.push(error instanceof PhraseError ? error.message : String(error));
      }
    }

    return {
      configFile: cfgFile.file,
      projectId: cfgFile.projectId,
      projectName,
      host: token?.host ?? cfgFile.host,
      tokenSource: token?.source ?? null,
      files,
      problems,
      unpinned,
      branch: cfgFile.projectId === null ? null : configuredBranch(sources, cfgFile.projectId),
    };
  };

  /**
   * `?branch=name` checks the files against that branch, `?branch=` against the
   * main project, and no parameter against whatever the config says — the
   * three ways a push can be asked for.
   */
  app.get('/api/phrase/status', async (req): Promise<PhraseStatus> => {
    const { branch } = PhraseStatusQuerySchema.parse(req.query ?? {});
    return statusOf(open().path, branch === undefined ? undefined : branch || null);
  });

  app.get('/api/phrase/projects', async (): Promise<PhraseProjectsResponse> => {
    const cfgFile = projects.current === null ? null : await config(projects.current.path);
    const client = await requireClient(cfgFile);
    return { projects: await phraseCall(() => client.listProjects()) };
  });

  /**
   * Ungated like Settings: a token is tested before any project is open. Tests
   * the token a push from the open project would use.
   */
  app.post('/api/phrase/test', async (): Promise<PhraseTestResponse> => {
    const cfgFile =
      projects.current === null
        ? null
        : await readPhraseConfig(projects.current.path).catch(() => null);
    const client = await clientFor(cfgFile);
    if (client === null) return { ok: false, detail: 'No Phrase access token is configured.' };
    try {
      const me = await client.me();
      const who = me.name && me.username ? `${me.name} (${me.username})` : me.name || me.username;
      return { ok: true, detail: `Signed in to Phrase as ${who || 'an unnamed user'}.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/phrase/connect', async (req): Promise<PhraseStatus> => {
    const { projectId } = PhraseConnectRequestSchema.parse(req.body);
    const project = open();
    if ((await config(project.path)) !== null) {
      throw conflict('This project already has a Phrase config.');
    }
    const dto = projects.toDto();
    const mapping = (dto?.files ?? []).flatMap((f) =>
      f.locale === null ? [] : [{ relPath: f.relPath, locale: f.locale }],
    );
    if (mapping.length === 0) throw badRequest('No file in this project has a locale to push.');

    // Pinned by id where the locale resolves to exactly one; the rest stay as
    // written and the status names them.
    const client = await clientFor(null);
    const locales =
      client === null ? [] : await client.listLocales(projectId).catch((): PhraseLocaleRow[] => []);
    await writePhraseConfig(
      project.path,
      projectId,
      await Promise.all(
        mapping.map(async (m) => {
          const match = resolvePhraseLocale(m.locale, locales);
          // The template pushes its <source> side, a translation its <target>.
          const text = await readFile(join(project.path, m.relPath), 'utf8').catch(() => '');
          return {
            ...m,
            target: match.kind === 'ok' ? match.locale : null,
            side: xliffSide(text),
          };
        }),
      ),
    );
    return statusOf(project.path);
  });

  /** Rewrite `.phrase.yml`'s locale ids to the Phrase ids they resolve to. All or nothing. */
  app.post('/api/phrase/pin-locales', async (): Promise<PhrasePinLocalesResponse> => {
    const project = open();
    const cfgFile = await config(project.path);
    if (cfgFile === null)
      throw badRequest('This project has no .phrase.yml. Connect it to Phrase first.');
    const client = await requireClient(cfgFile);
    const locales = localeLister(client);
    return phraseCall(() => pinLocaleIds(project.path, cfgFile, (id) => locales(id, null)));
  });

  /** The branches of the config's project, and the one the config already pushes to. */
  app.get('/api/phrase/branches', async (): Promise<PhraseBranchesResponse> => {
    const project = open();
    const cfgFile = await config(project.path);
    if (cfgFile?.projectId == null) {
      throw badRequest('This project has no Phrase project_id. Connect it to Phrase first.');
    }
    const client = await requireClient(cfgFile);
    const projectId = cfgFile.projectId;
    const [branches, { files }] = await Promise.all([
      phraseCall(() => client.listBranches(projectId)),
      resolvePushSources(project.path, cfgFile),
    ]);
    return { branches, configured: configuredBranch(files, projectId) };
  });

  /** The push under way, so a cancel can reach it; null when none runs. */
  let pushing: AbortController | null = null;

  app.post('/api/phrase/push', async (req): Promise<PhrasePushResponse> => {
    const { branch, verify } = PhrasePushRequestSchema.parse(req.body ?? {});
    if (pushing !== null) throw conflict('A push to Phrase is already running.');
    const controller = new AbortController();
    pushing = controller;
    try {
      return await push(branch, verify, controller.signal);
    } finally {
      pushing = null;
    }
  });

  /**
   * Stops the push under way: files not yet uploaded are not, and the wait
   * for the one Phrase is processing ends. 204 whether or not one ran.
   */
  app.post('/api/phrase/push/cancel', async (_req, reply): Promise<void> => {
    pushing?.abort();
    await reply.code(204).send();
  });

  const push = async (
    branch: string | null | undefined,
    verify: boolean | undefined,
    signal: AbortSignal,
  ): Promise<PhrasePushResponse> => {
    const project = open();
    if (projects.unsavedCount > 0) {
      throw conflict(
        `${projects.unsavedCount} unsaved ${projects.unsavedCount === 1 ? 'draft is' : 'drafts are'} not in the files yet. Save before pushing.`,
      );
    }

    const cfgFile = await config(project.path);
    if (cfgFile === null)
      throw badRequest('This project has no .phrase.yml. Connect it to Phrase first.');
    const client = await requireClient(cfgFile);

    const resolved = await resolvePushSources(project.path, cfgFile);
    if (resolved.files.length === 0) {
      throw badRequest(resolved.problems[0] ?? 'The Phrase config resolves to no file.');
    }
    const files = withPickedBranch(resolved.files, branch, cfgFile.projectId);

    // Every file resolves to exactly one existing locale, or nothing is pushed.
    const locales = localeLister(client);
    const { targets, problems: refusals } = await phraseCall(() => resolveTargets(files, locales));
    if (refusals.length > 0) {
      throw conflict(`Nothing was pushed. ${refusals.join(' ')}`);
    }

    const results: PhrasePushFileResult[] = [];
    const total = files.length;
    let stopped = false;
    for (const [index, file] of files.entries()) {
      // Non-null: any null target was a refusal above.
      const target = targets[index] as PhraseLocaleRef;
      const progress = (stage: 'uploading' | 'processing' | 'done' | 'failed') =>
        bus.publish({
          type: 'phrase-push-progress',
          index,
          total,
          relPath: file.relPath,
          localeId: file.localeId,
          stage,
        });
      const fail = (error: string) => {
        results.push({
          relPath: file.relPath,
          localeId: file.localeId,
          ok: false,
          summary: {},
          error,
        });
        progress('failed');
      };

      if (stopped) {
        fail('Not pushed: the push stopped after Phrase created a locale.');
        continue;
      }
      if (signal.aborted) {
        fail('Not pushed: the push was cancelled.');
        continue;
      }
      progress('uploading');
      try {
        const abs = await resolveWithinRoots(join(project.path, file.relPath), cfg);
        const side = isXliffUpload(file) ? xliffSide(await readFile(abs, 'utf8')) : null;
        const outcome = await client.upload(
          file.projectId,
          abs,
          {
            ...(side === null ? file.params : withLocaleOverride(file.params, side)),
            ...(verify === undefined ? {} : { verify_mentioned_translations: verify }),
            locale_id: target.id,
          },
          () => progress('processing'),
          // A translation's target-language is the one Phrase could read as a
          // locale name; the template's <source> side carries no such risk.
          side === 'target' ? (text) => withXliffTargetLanguage(text, target.name) : undefined,
          signal,
        );
        const created = outcome.summary['locales_created'] ?? 0;
        if (created > 0) stopped = true;
        const ok = outcome.state === 'success' && created === 0;
        results.push({
          relPath: file.relPath,
          localeId: file.localeId,
          ok,
          summary: outcome.summary,
          error:
            created > 0
              ? `Phrase created ${created === 1 ? 'a new locale' : `${created} new locales`} for this file instead of using ${describePhraseLocale(target)}. The push stopped here — delete the locale in Phrase.`
              : outcome.error,
        });
        progress(ok ? 'done' : 'failed');
      } catch (error) {
        fail(
          error instanceof PhraseError && error.kind === 'aborted'
            ? 'Cancelled while it was being uploaded. Phrase may still import it — check the upload in Phrase.'
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    }

    const createdLocales = await newLocales(client, files, locales).catch((error: unknown) => {
      app.log.warn({ err: error }, 'could not re-read the Phrase locales after a push');
      return [];
    });

    const response: PhrasePushResponse = {
      ok: results.every((r) => r.ok) && createdLocales.length === 0 && !signal.aborted,
      cancelled: signal.aborted,
      branch: cfgFile.projectId === null ? null : configuredBranch(files, cfgFile.projectId),
      results,
      createdLocales,
    };
    // Machine-local, like the job logs: who pushed what, and what Phrase said.
    await appendJobLogLine(cfg, project.path, 'phrase-push', {
      at: new Date().toISOString(),
      ...response,
    }).catch((error: unknown) => app.log.warn({ err: error }, 'could not log the Phrase push'));
    return response;
  };
}

type LocaleLister = (projectId: string, branch: string | null) => Promise<PhraseLocaleRow[]>;

/** A project's (or branch's) locales, each list read once per request. */
function localeLister(client: PhraseClient): LocaleLister {
  const cache = new Map<string, Promise<PhraseLocaleRow[]>>();
  return (projectId, branch) => {
    const key = `${projectId}\u0000${branch ?? ''}`;
    let list = cache.get(key);
    if (list === undefined) {
      list = client.listLocales(projectId, { branch });
      cache.set(key, list);
    }
    return list;
  };
}

/**
 * The locale a file uploads to, on its branch. A branch may carry its locales
 * under ids of its own, so a pinned id that is not there is followed to the
 * branch's locale with the same code AND name as the main project's — only
 * when there is exactly one.
 */
async function resolveTarget(
  file: PhrasePushFile,
  locales: LocaleLister,
): Promise<PhraseLocaleMatch> {
  const branch = branchOf(file);
  const onBranch = await locales(file.projectId, branch);
  const match = resolvePhraseLocale(file.localeId, onBranch);
  if (branch === null || match.kind !== 'missing') return match;
  const main = resolvePhraseLocale(file.localeId, await locales(file.projectId, null));
  if (main.kind !== 'ok') return main;
  const same = onBranch.filter((l) => l.code === main.locale.code && l.name === main.locale.name);
  return same.length === 1
    ? resolvePhraseLocale((same[0] as PhraseLocaleRow).id, onBranch)
    : { kind: 'missing' };
}

/**
 * Each file's target locale on its branch — null where it does not resolve to
 * exactly one — and a sentence per file that does not. Status and push both
 * use this, so what the dialog allows is what the push accepts.
 */
async function resolveTargets(
  files: readonly PhrasePushFile[],
  locales: LocaleLister,
): Promise<{ targets: Array<PhraseLocaleRef | null>; problems: string[] }> {
  const targets: Array<PhraseLocaleRef | null> = [];
  const problems = new Set<string>();
  for (const file of files) {
    const match = await resolveTarget(file, locales);
    const problem = phraseLocaleProblem(file.localeId, match);
    if (problem !== null) problems.add(`${file.relPath}: ${problem}`);
    targets.push(match.kind === 'ok' ? match.locale : null);
  }
  return { targets, problems: [...problems] };
}

/**
 * The files with the branch picked in the dialog applied — to the config's
 * project only: the branches offered are that project's, and another
 * project's sources keep whatever their own params say. `undefined` leaves
 * the config as it is.
 */
function withPickedBranch(
  files: readonly PhrasePushFile[],
  branch: string | null | undefined,
  projectId: string | null,
): PhrasePushFile[] {
  if (branch === undefined) return [...files];
  return files.map((f) => (f.projectId === projectId ? withBranch(f, branch) : f));
}

/**
 * Locales that exist after the push but did not before, as sentences — read
 * again from Phrase rather than trusted to the upload summaries.
 */
async function newLocales(
  client: PhraseClient,
  files: readonly PhrasePushFile[],
  before: LocaleLister,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const branch = branchOf(file);
    const key = `${file.projectId}\u0000${branch ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const known = new Set((await before(file.projectId, branch)).map((l) => l.id));
    for (const l of await client.listLocales(file.projectId, { branch })) {
      if (known.has(l.id)) continue;
      out.push(
        `Phrase now has a locale ${describePhraseLocale(l)} (id ${l.id})${branch === null ? '' : ` on branch ${branch}`} that the push created. Delete it in Phrase.`,
      );
    }
  }
  return out;
}

/** XLIFF by its `file_format`, or by the file's extension when none is given. */
function isXliffUpload(file: PhrasePushFile): boolean {
  const format = file.params['file_format'];
  return typeof format === 'string' && format !== ''
    ? /^(xlf|xliff)/i.test(format)
    : /\.(xlf|xliff)$/i.test(file.relPath);
}

/**
 * `format_options` set so Phrase takes the locale from `locale_id` and reads
 * one side of the file only (see `xliffUploadOptions`). These three keys are
 * forced even over the config: without the override a push cannot promise
 * that no locale is created, and without the ignore Phrase refuses the file.
 * Other format options are kept.
 */
function withLocaleOverride(
  params: Readonly<Record<string, PhraseParamValue>>,
  side: XliffSide,
): Record<string, PhraseParamValue> {
  const current = params['format_options'];
  const options = typeof current === 'object' && !Array.isArray(current) ? current : {};
  return { ...params, format_options: { ...options, ...xliffUploadOptions(side) } };
}

/** The `branch` upload param of one file, or null for the main project. */
function branchOf(file: PhrasePushFile): string | null {
  const value = file.params['branch'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The file with its upload pointed at `branch`, or at the main project for null. */
function withBranch(file: PhrasePushFile, branch: string | null): PhrasePushFile {
  const params = { ...file.params };
  if (branch === null) delete params['branch'];
  else params['branch'] = branch;
  return { ...file, params };
}

/**
 * The branch every file of `projectId` uploads to — null when they go to the
 * main project, disagree, or there are none.
 */
function configuredBranch(files: readonly PhrasePushFile[], projectId: string): string | null {
  const branches = new Set(files.filter((f) => f.projectId === projectId).map(branchOf));
  const [only] = branches;
  return branches.size === 1 ? (only ?? null) : null;
}

/** A Phrase failure as an HTTP answer the client can show as-is. */
export async function phraseCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof PhraseError) {
      if (error.kind === 'config') throw badRequest(error.message);
      throw upstream(error.message);
    }
    throw error;
  }
}
