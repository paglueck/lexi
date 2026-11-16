// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  PHRASE_HOSTS,
  type PhraseParamValue,
  type PhraseProjectSummary,
  type PhraseRegionCode,
} from '@lexi/shared';

/**
 * A small client for the Phrase Strings REST API (v2) — the calls a push and a
 * tag checkout need, and nothing that would make lexi a second Phrase UI.
 *
 * `fetch`, the poll delay and the rate-limit wait are injectable so the tests
 * can run against a fake server without a network or a clock. The token never
 * leaves this module in an error message: Phrase does not echo it, and nothing
 * here does either.
 *
 * Rate limits are waited out, not reported: a 429 (or a response that says no
 * requests are left) pauses until Phrase's reset time and tries again, at most
 * three times per request. A checkout of a few thousand keys is dozens of
 * pages, and failing it on page 31 because the user's other tools spent the
 * budget would be the wrong answer to a limit that lifts within a minute.
 */

export const DEFAULT_PHRASE_HOST = PHRASE_HOSTS.EU;

/** How often one request is retried after a rate-limit wait. */
const RATE_LIMIT_RETRIES = 3;

export class PhraseError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'config'
      | 'network'
      | 'auth'
      | 'not-found'
      | 'rate-limit'
      | 'http'
      | 'upload'
      | 'aborted',
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'PhraseError';
  }
}

export interface PhraseUser {
  readonly name: string;
  readonly username: string;
}

/** What an upload reports once Phrase has processed it. */
export interface PhraseUploadOutcome {
  readonly id: string;
  readonly state: string;
  readonly summary: Record<string, number>;
  readonly error: string | null;
  /** The upload in the Phrase app, when Phrase says. */
  readonly url: string | null;
}

/** A locale as `listLocales` reports it; `isDefault` is Phrase's `default` flag. */
export interface PhraseLocaleRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isDefault: boolean;
}

export interface PhraseTagRow {
  readonly name: string;
  readonly keysCount: number;
  readonly updatedAt: string | null;
}

export interface PhraseBranchRow {
  readonly name: string;
  readonly updatedAt: string | null;
}

export interface PhraseKeyRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly plural: boolean;
}

export interface PhraseTranslationRow {
  readonly keyId: string;
  readonly content: string;
  /** `one`, `other`, … for a plural key's forms; '' otherwise. */
  readonly pluralSuffix: string;
}

/** Per-call options of the paginated reads a checkout makes. */
export interface PhraseListOptions {
  readonly signal?: AbortSignal | undefined;
  /** Stop after this many pages — the tag preview needs only the first. */
  readonly maxPages?: number | undefined;
  /** Called after each page with the rows read so far. */
  readonly onPage?: ((rowsSoFar: number, pages: number) => void) | undefined;
  /** Read this branch instead of the main project; a branch has its own locales, keys and tags. */
  readonly branch?: string | null | undefined;
}

export interface PhraseClientOptions {
  /** An explicit API base (`.phrase.yml`'s `host`). Wins over `region`. */
  readonly host?: string | undefined;
  /** The data center the token belongs to; picks the host when none is given. */
  readonly region?: PhraseRegionCode | undefined;
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** Between two polls of an upload's state. */
  readonly pollIntervalMs?: number;
  /** How long one upload may stay `processing` before the push gives up on it. */
  readonly uploadTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Rate-limit pause; injectable so a test need not wait. Must reject when `signal` aborts. */
  readonly delay?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Longest single rate-limit pause. Phrase's window is a minute. */
  readonly maxRateLimitWaitMs?: number | undefined;
  /** Called before a rate-limit pause starts, with its length. */
  readonly onWait?: ((ms: number) => void) | undefined;
  /** Called when the pause is over and the request is retried. */
  readonly onWaitEnd?: (() => void) | undefined;
}

export class PhraseClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #pollIntervalMs: number;
  readonly #uploadTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #maxWaitMs: number;
  readonly #onWait: ((ms: number) => void) | undefined;
  readonly #onWaitEnd: (() => void) | undefined;
  /** Epoch ms before which no request is sent: Phrase said none were left. */
  #resumeAt = 0;

  constructor(options: PhraseClientOptions) {
    if (options.token.trim() === '') {
      throw new PhraseError('No Phrase access token is configured.', 'config');
    }
    this.#base = normaliseHost(
      options.host ?? (options.region === undefined ? DEFAULT_PHRASE_HOST : PHRASE_HOSTS[options.region]),
    );
    this.#token = options.token.trim();
    this.#fetch = options.fetch ?? fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#delay = options.delay ?? abortableDelay;
    this.#maxWaitMs = options.maxRateLimitWaitMs ?? 65_000;
    this.#onWait = options.onWait;
    this.#onWaitEnd = options.onWaitEnd;
  }

  /** The API base this client talks to, scheme included. */
  get host(): string {
    return this.#base;
  }

  async me(): Promise<PhraseUser> {
    const body = asRecord(await (await this.#request('GET', '/user')).json());
    return { name: str(body?.['name']), username: str(body?.['username']) };
  }

  /** Every project the token can see, following the `Link: rel="next"` pages. */
  async listProjects(): Promise<PhraseProjectSummary[]> {
    const out: PhraseProjectSummary[] = [];
    let path: string | null = '/projects?per_page=100&page=1';
    // A hard cap rather than trusting the header forever: 50 pages is 5000 projects.
    for (let page = 0; path !== null && page < 50; page++) {
      const response = await this.#request('GET', path);
      const rows = await response.json();
      if (!Array.isArray(rows))
        throw new PhraseError('Phrase returned an unexpected project list.', 'http');
      for (const row of rows) {
        const r = asRecord(row);
        if (r === null || typeof r['id'] !== 'string') continue;
        out.push({
          id: r['id'],
          name: str(r['name']),
          account: str(asRecord(r['account'])?.['name']) || null,
        });
      }
      path = nextPage(response.headers.get('link'), this.#base);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The project's locales, so a config may name them by id, name or code, and
   * a checkout knows which one is the base (`default`).
   */
  async listLocales(
    projectId: string,
    options: PhraseListOptions = {},
  ): Promise<PhraseLocaleRow[]> {
    // A branch has locales of its own, with ids that need not match the main project's.
    return this.#list(
      `/projects/${enc(projectId)}/locales?${branchQuery(options.branch)}per_page=100&page=1`,
      'locale list',
      20,
      options,
      (r) =>
        typeof r['id'] !== 'string'
          ? null
          : {
              id: r['id'],
              name: str(r['name']),
              code: str(r['code']),
              isDefault: r['default'] === true,
            },
    );
  }

  /**
   * The project's open branches, by name. Merged ones are left out: Phrase
   * keeps listing them, but nothing should be pushed to a branch that is done.
   */
  async listBranches(
    projectId: string,
    options: PhraseListOptions = {},
  ): Promise<PhraseBranchRow[]> {
    const rows = await this.#list(
      `/projects/${enc(projectId)}/branches?per_page=100&page=1`,
      'branch list',
      10,
      options,
      (r) =>
        typeof r['name'] !== 'string' || r['name'] === '' || str(r['merged_at']) !== ''
          ? null
          : { name: r['name'], updatedAt: str(r['updated_at']) || null },
    );
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Names of the accounts the token belongs to, in Phrase's order. */
  async accounts(): Promise<string[]> {
    const rows = await this.#list('/accounts?per_page=100&page=1', 'account list', 5, {}, (r) =>
      typeof r['name'] === 'string' ? r['name'] : null,
    );
    return rows;
  }

  /** The project's tags with their key counts. */
  async listTags(projectId: string, options: PhraseListOptions = {}): Promise<PhraseTagRow[]> {
    return this.#list(
      `/projects/${enc(projectId)}/tags?${branchQuery(options.branch)}per_page=100&page=1`,
      'tag list',
      50,
      options,
      (r) =>
        typeof r['name'] !== 'string'
          ? null
          : {
              name: r['name'],
              keysCount: typeof r['keys_count'] === 'number' ? r['keys_count'] : 0,
              updatedAt: str(r['updated_at']) || null,
            },
    );
  }

  /**
   * Every key of the project, or every key carrying `tag` when one is given,
   * 100 per page, following `Link`. The cap is 1000 pages — 100 000 keys, far
   * past any project a person checks out.
   */
  async listKeys(
    projectId: string,
    tag: string | undefined,
    options: PhraseListOptions = {},
  ): Promise<PhraseKeyRow[]> {
    const query = tag === undefined ? '' : `q=${enc(tagQuery(tag))}&`;
    return this.#list(
      `/projects/${enc(projectId)}/keys?${branchQuery(options.branch)}${query}per_page=100&page=1`,
      'key list',
      1000,
      options,
      (r) =>
        typeof r['id'] !== 'string'
          ? null
          : {
              id: r['id'],
              name: str(r['name']),
              description: str(r['description']),
              plural: r['plural'] === true,
            },
    );
  }

  /**
   * One locale's translations — of every key, or of the keys carrying `tag`
   * when one is given. A plural key comes back once per form, each with its
   * `plural_suffix`; joining them to keys is the caller's business.
   */
  async listTranslations(
    projectId: string,
    localeId: string,
    options: PhraseListOptions & { readonly tag?: string | undefined } = {},
  ): Promise<PhraseTranslationRow[]> {
    const query = options.tag === undefined ? '' : `q=${enc(tagQuery(options.tag))}&`;
    return this.#list(
      `/projects/${enc(projectId)}/locales/${enc(localeId)}/translations?${branchQuery(options.branch)}${query}per_page=100&page=1`,
      'translation list',
      1000,
      options,
      (r) => {
        const key = asRecord(r['key']);
        const keyId = str(key?.['id']);
        if (keyId === '') return null;
        return { keyId, content: str(r['content']), pluralSuffix: str(r['plural_suffix']) };
      },
    );
  }

  /**
   * How many keys the project has, from the locale's `statistics` — null when
   * Phrase does not say.
   */
  async localeStatistics(
    projectId: string,
    localeId: string,
    options: Pick<PhraseListOptions, 'branch'> = {},
  ): Promise<number | null> {
    const query = options.branch == null ? '' : `?branch=${enc(options.branch)}`;
    const body = asRecord(
      await (
        await this.#request('GET', `/projects/${enc(projectId)}/locales/${enc(localeId)}${query}`)
      ).json(),
    );
    const total = asRecord(body?.['statistics'])?.['keys_total_count'];
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
  }

  /** A paginated GET, one row parser, following `Link: rel="next"` up to `cap` pages. */
  async #list<T>(
    first: string,
    what: string,
    cap: number,
    options: PhraseListOptions,
    parse: (row: Record<string, unknown>) => T | null,
  ): Promise<T[]> {
    const out: T[] = [];
    let path: string | null = first;
    const limit = Math.min(cap, options.maxPages ?? cap);
    for (let page = 0; path !== null && page < limit; page++) {
      const response = await this.#request('GET', path, undefined, options.signal);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new PhraseError(`Phrase returned an unexpected ${what}.`, 'http');
      for (const row of rows) {
        const r = asRecord(row);
        const parsed = r === null ? null : parse(r);
        if (parsed !== null) out.push(parsed);
      }
      options.onPage?.(out.length, page + 1);
      path = nextPage(response.headers.get('link'), this.#base);
    }
    return out;
  }

  /** The project's name, which `GET /api/phrase/status` shows next to its id. */
  async project(projectId: string): Promise<{ id: string; name: string }> {
    const body = asRecord(await (await this.#request('GET', `/projects/${enc(projectId)}`)).json());
    return { id: str(body?.['id']) || projectId, name: str(body?.['name']) };
  }

  /**
   * Upload one file and wait until Phrase has processed it.
   *
   * The upload endpoint only queues the file; whether keys were created, and
   * whether the file parsed at all, is known once its state leaves
   * `processing`. Reporting "pushed" before that would be reporting a guess.
   */
  async upload(
    projectId: string,
    absPath: string,
    params: Readonly<Record<string, PhraseParamValue>>,
    onProcessing?: () => void,
    /** Rewrites the uploaded copy of the file's text; the file on disk is not touched. */
    transform?: (text: string) => string,
    /** Stops the upload, or the wait for Phrase to process it, with an `aborted` error. */
    signal?: AbortSignal,
  ): Promise<PhraseUploadOutcome> {
    const form = new FormData();
    const bytes = await readFile(absPath);
    const body = transform === undefined ? bytes : transform(bytes.toString('utf8'));
    form.append('file', new Blob([body]), basename(absPath));
    for (const [key, value] of Object.entries(params)) appendField(form, key, value);

    const queued = parseUpload(
      await (
        await this.#request('POST', `/projects/${enc(projectId)}/uploads`, form, signal)
      ).json(),
    );
    onProcessing?.();

    const branch = typeof params['branch'] === 'string' ? params['branch'] : null;
    const query = branch === null ? '' : `?branch=${enc(branch)}`;
    const deadline = Date.now() + this.#uploadTimeoutMs;
    let current = queued;
    while (current.state !== 'success' && current.state !== 'error') {
      if (Date.now() > deadline) {
        throw new PhraseError(
          `Phrase is still processing ${basename(absPath)}. Check the upload in Phrase.`,
          'upload',
        );
      }
      try {
        await abortableDelay(this.#pollIntervalMs, signal);
      } catch {
        throw new PhraseError('Cancelled.', 'aborted');
      }
      current = parseUpload(
        await (
          await this.#request(
            'GET',
            `/projects/${enc(projectId)}/uploads/${enc(current.id)}${query}`,
            undefined,
            signal,
          )
        ).json(),
      );
    }
    return current;
  }

  /** One request, with the rate-limit waits and retries described at the top. */
  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: FormData,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const ahead = this.#resumeAt - Date.now();
      if (ahead > 0) await this.#wait(ahead, signal);

      const response = await this.#send(method, path, body, signal);
      const remaining = response.headers.get('x-rate-limit-remaining');
      if (remaining !== null && Number(remaining) <= 0) {
        const wait = rateLimitWaitMs(response.headers);
        if (wait !== null) this.#resumeAt = Date.now() + Math.min(wait, this.#maxWaitMs);
      }
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return this.#check(response);

      // Drained so the connection can be reused; the body says nothing new.
      await response.text().catch(() => '');
      this.#resumeAt = 0;
      await this.#wait(rateLimitWaitMs(response.headers) ?? 1000, signal);
    }
  }

  async #wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    const capped = Math.max(0, Math.min(ms, this.#maxWaitMs));
    this.#onWait?.(capped);
    try {
      await this.#delay(capped, signal);
    } catch {
      throw new PhraseError('Cancelled.', 'aborted');
    }
    this.#resumeAt = 0;
    this.#onWaitEnd?.();
  }

  async #send(
    method: 'GET' | 'POST',
    path: string,
    body: FormData | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    if (signal?.aborted) throw new PhraseError('Cancelled.', 'aborted');
    const url = path.startsWith('http') ? path : `${this.#base}${path}`;
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    try {
      return await this.#fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `token ${this.#token}`,
          // Phrase rejects requests without one.
          'user-agent': 'lexi',
        },
        ...(body === undefined ? {} : { body }),
        // The token must never follow a redirect somewhere else; Phrase's API
        // does not redirect, so a 3xx is reported as the error it is.
        redirect: 'manual',
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
    } catch (error) {
      if (signal?.aborted) throw new PhraseError('Cancelled.', 'aborted');
      const reason = error instanceof Error ? error.message : String(error);
      throw new PhraseError(`Could not reach ${new URL(url).origin}: ${reason}`, 'network');
    }
  }

  /** The response as-is when it is a success, otherwise the error it amounts to. */
  async #check(response: Response): Promise<Response> {
    if (response.ok) return response;

    const message = await errorMessage(response);
    switch (response.status) {
      case 401:
        throw new PhraseError(
          'Phrase rejected the access token. Check it in Settings.',
          'auth',
          401,
        );
      case 403:
        throw new PhraseError(`The access token may not do this: ${message}`, 'auth', 403);
      case 404:
        throw new PhraseError(`Not found in Phrase: ${message}`, 'not-found', 404);
      case 429: {
        const retry =
          response.headers.get('retry-after') ?? response.headers.get('x-rate-limit-reset');
        throw new PhraseError(
          `Phrase's rate limit was reached${retry ? ` — try again in ${retry} s` : ''}.`,
          'rate-limit',
          429,
        );
      }
      default:
        throw new PhraseError(
          `Phrase answered ${response.status}: ${message}`,
          'http',
          response.status,
        );
    }
  }
}

/** `https://api.phrase.com/v2/` and `api.phrase.com/v2` both work as `phrase.host`. */
export function normaliseHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (trimmed === '') return DEFAULT_PHRASE_HOST;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(withScheme);
  } catch {
    throw new PhraseError(`"${host}" is not a usable Phrase host.`, 'config');
  }
  return withScheme;
}

/**
 * Multipart fields the way the Phrase API reads them: lists as a comma
 * separated string (`tags`), objects as `key[sub]` fields (`format_options`,
 * `locale_mapping`).
 */
function appendField(form: FormData, key: string, value: PhraseParamValue): void {
  if (Array.isArray(value)) form.append(key, value.join(','));
  else if (typeof value === 'object') {
    for (const [sub, v] of Object.entries(value)) form.append(`${key}[${sub}]`, String(v));
  } else form.append(key, String(value));
}

function parseUpload(raw: unknown): PhraseUploadOutcome {
  const r = asRecord(raw);
  if (r === null || typeof r['id'] !== 'string') {
    throw new PhraseError('Phrase returned an unexpected upload response.', 'http');
  }
  const summary: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(r['summary']) ?? {})) {
    if (typeof v === 'number') summary[k] = v;
  }
  const state = str(r['state']) || 'processing';
  const url = str(r['url']) || null;
  return {
    id: r['id'],
    state,
    summary,
    error: state === 'error' ? uploadError(r, url) : null,
    url,
  };
}

/**
 * Why an upload failed, in Phrase's words: `error_message` (what the API
 * documents), else the older `error` / `errors[]` shapes. Only when Phrase
 * says nothing does lexi fall back to a sentence of its own, with the link.
 */
function uploadError(r: Record<string, unknown>, url: string | null): string {
  for (const key of ['error_message', 'error']) {
    const value = r[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const errors = Array.isArray(r['errors']) ? r['errors'] : [];
  const messages = errors.map((e) => str(asRecord(e)?.['message']) || String(e)).filter(Boolean);
  if (messages.length > 0) return messages.join('; ');
  return url === null
    ? 'Phrase could not process the file and did not say why.'
    : `Phrase could not process the file and did not say why — see ${url}`;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = asRecord(JSON.parse(text));
    const errors = Array.isArray(body?.['errors']) ? body['errors'] : [];
    const details = errors
      .map((e) => {
        const r = asRecord(e);
        return [str(r?.['field']), str(r?.['message'])].filter(Boolean).join(' ');
      })
      .filter(Boolean);
    const head = str(body?.['message']);
    return [head, ...details].filter(Boolean).join(' — ') || response.statusText;
  } catch {
    return text.slice(0, 200) || response.statusText;
  }
}

/** The `rel="next"` URL of a `Link` header, if it stays on the same host. */
function nextPage(link: string | null, base: string): string | null {
  if (link === null) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match?.[1] === undefined) continue;
    const url = new URL(match[1], base);
    // Never follow a header off the configured origin with the token attached.
    return url.origin === new URL(base).origin ? url.href : null;
  }
  return null;
}

/**
 * How long Phrase asks to wait: `Retry-After` in seconds, else
 * `X-Rate-Limit-Reset`, which Phrase sends as an epoch second (a small number
 * is read as seconds from now). Null when neither header says.
 */
function rateLimitWaitMs(headers: Headers): number | null {
  const retry = Number(headers.get('retry-after') ?? NaN);
  if (Number.isFinite(retry) && retry >= 0) return retry * 1000;
  const reset = Number(headers.get('x-rate-limit-reset') ?? NaN);
  if (!Number.isFinite(reset) || reset < 0) return null;
  return reset > 1e9 ? Math.max(0, reset * 1000 - Date.now()) : reset * 1000;
}

/**
 * Phrase's search qualifier for one tag. Quoted only when it has to be: a tag
 * with a space or a comma would otherwise split into several terms.
 */
/** `branch=name&` for a list URL that already has a `?`; '' for the main project. */
function branchQuery(branch: string | null | undefined): string {
  return branch == null ? '' : `branch=${enc(branch)}&`;
}

function tagQuery(tag: string): string {
  return /[\s,"]/.test(tag) ? `tags:"${tag.replace(/"/g, '\\"')}"` : `tags:${tag}`;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const enc = encodeURIComponent;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
