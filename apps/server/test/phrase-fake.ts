// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A fake Phrase API behind an injected `fetch`: enough of `/user`,
 * `/accounts`, `/projects`, `/locales` (list and show), `/branches`, `/tags`,
 * `/keys`, `/translations` and `/uploads` for the client and the routes, plus a record of every request so
 * a test can assert what was sent. It answers on any host (the EU and the US
 * data center alike); `requests` shows which one was called.
 */
export interface FakeKey {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /** Base (`en-GB`) text; an object for a plural key; absent for none. */
  readonly base?: string | Readonly<Record<string, string>>;
}

/** The default keys: three tagged `checkout-v2` (one plural, one without base text), one not. */
export const FAKE_KEYS: readonly FakeKey[] = [
  {
    id: 'k1',
    name: 'checkout.pay',
    description: 'Main button',
    tags: ['checkout-v2'],
    base: 'Pay {amount} now & go',
  },
  { id: 'k2', name: 'checkout.items', tags: ['checkout-v2'], base: { one: '1 item', other: '{count} items' } },
  { id: 'k3', name: 'checkout.blank', tags: ['checkout-v2'] },
  { id: 'k4', name: 'legacy.title', tags: ['legacy'], base: 'Old' },
];

export interface FakeUpload {
  readonly projectId: string;
  readonly fields: Record<string, string>;
  readonly fileName: string;
  readonly fileText: string;
}

export interface FakeLocale {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly default?: boolean;
}

export interface FakePhrase {
  readonly fetch: typeof fetch;
  readonly requests: Array<{ method: string; url: string; auth: string | null }>;
  readonly uploads: FakeUpload[];
  /** Polls an upload stays `processing` for before it settles. */
  processingPolls: number;
  /** Uploads whose `locale_id` is in here end in `error`. */
  failLocales: Set<string>;
  token: string;
  keys: FakeKey[];
  /** Page size the fake uses for keys and translations, whatever `per_page` says. */
  pageSize: number;
  /** Answer this many requests with 429 (and a reset header) before serving again. */
  rateLimited: number;
  /** When set, `/keys` waits for it — or for the request's abort signal. */
  hold: Promise<void> | null;
  /** Whether a locale's show carries `statistics.keys_total_count` (the key count). */
  localeStatistics: boolean;
  /** The project's locales, as `/locales` lists them. */
  locales: FakeLocale[];
  /** A branch's locales, when they differ from the main project's. */
  branchLocales: Map<string, FakeLocale[]>;
  /** A branch's keys, when it has its own; a branch not in here shows the main project's. */
  branchKeys: Map<string, FakeKey[]>;
  /**
   * Phrase's mistake, reproduced: an upload whose `locale_id` is in here
   * creates a locale (named after it) and reports `locales_created: 1`.
   */
  createLocaleFor: Set<string>;
}

/** Phrase's own words when an XLIFF upload with a fixed language brings source and target. */
export const TWO_LANGUAGES =
  'You have specified a language but the file contains more than one source or target languages. Try to exclude source or target translations or refrain from specifying a language and use auto-detection.';

export function fakePhrase(): FakePhrase {
  const state: FakePhrase = {
    fetch: undefined as unknown as typeof fetch,
    requests: [],
    uploads: [],
    processingPolls: 1,
    failLocales: new Set(),
    token: 'good-token',
    keys: [...FAKE_KEYS],
    pageSize: 100,
    rateLimited: 0,
    hold: null,
    localeStatistics: true,
    locales: [
      { id: 'loc-de', name: 'de', code: 'de-DE' },
      { id: 'loc-en', name: 'en-GB', code: 'en-GB', default: true },
      { id: 'loc-fr', name: 'fr', code: 'fr-FR' },
    ],
    branchLocales: new Map(),
    branchKeys: new Map(),
    createLocaleFor: new Set(),
  };
  const polls = new Map<string, number>();
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    state.requests.push({ method, url: url.href, auth: headers.get('authorization') });

    if (headers.get('authorization') !== `token ${state.token}`) {
      return json({ message: 'Unauthorized' }, { status: 401 });
    }
    const path = url.pathname.replace(/^\/v2/, '');

    if (state.rateLimited > 0) {
      state.rateLimited -= 1;
      return json(
        { message: 'Rate limit exceeded' },
        {
          status: 429,
          headers: {
            'x-rate-limit-limit': '1000',
            'x-rate-limit-remaining': '0',
            'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 2),
          },
        },
      );
    }

    if (path === '/user') return json({ id: 'u1', name: 'Jane Doe', username: 'jdoe' });

    if (path === '/accounts') return json([{ id: 'a1', name: 'ACME' }]);

    /** One page of `rows`, with a `Link: rel="next"` while more are left. */
    const paged = (rows: readonly unknown[]): Response => {
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = rows.slice((page - 1) * state.pageSize, page * state.pageSize);
      const more = page * state.pageSize < rows.length;
      const next = new URL(url.href);
      next.searchParams.set('page', String(page + 1));
      return json(slice, more ? { headers: { link: `<${next.href}>; rel="next"` } } : {});
    };
    /** The keys and locales of the `branch` parameter's branch, else the main project's. */
    const keysOf = (): FakeKey[] => {
      const branch = url.searchParams.get('branch');
      return (branch === null ? undefined : state.branchKeys.get(branch)) ?? state.keys;
    };
    const localesOf = (): FakeLocale[] => {
      const branch = url.searchParams.get('branch');
      return (branch === null ? undefined : state.branchLocales.get(branch)) ?? state.locales;
    };
    /** `tags:x` or `tags:"x y"` from the `q` parameter. */
    const tagOf = (): string | null => {
      const q = url.searchParams.get('q');
      const m = q === null ? null : /^tags:(?:"((?:[^"\\]|\\.)*)"|(\S+))$/.exec(q);
      return m === null ? null : (m[1]?.replace(/\\"/g, '"') ?? m[2] ?? null);
    };

    if (path === '/projects') {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page === 1) {
        return json([{ id: 'p2', name: 'Web', account: { name: 'ACME' } }], {
          headers: { link: `<${url.origin}/v2/projects?page=2&per_page=100>; rel="next"` },
        });
      }
      return json([{ id: 'p1', name: 'App', account: { name: 'ACME' } }]);
    }

    let m = /^\/projects\/([^/]+)$/.exec(path);
    if (m) {
      return m[1] === 'missing'
        ? json({ message: 'Not Found' }, { status: 404 })
        : json({ id: m[1], name: `Project ${m[1]}` });
    }

    m = /^\/projects\/([^/]+)\/locales$/.exec(path);
    if (m) {
      return json(localesOf().map((l) => ({ ...l, default: l.default === true })));
    }

    m = /^\/projects\/([^/]+)\/locales\/([^/]+)$/.exec(path);
    if (m) {
      return json({
        id: m[2],
        ...(state.localeStatistics
          ? { statistics: { keys_total_count: keysOf().length, translations_completed_count: 0 } }
          : {}),
      });
    }

    m = /^\/projects\/([^/]+)\/branches$/.exec(path);
    if (m) {
      return paged([
        {
          name: 'release-2',
          state: 'success',
          merged_at: null,
          updated_at: '2026-11-01T09:00:00Z',
        },
        { name: 'done', state: 'merged', merged_at: '2026-10-20T09:00:00Z', updated_at: null },
        { name: 'feature-x', state: 'success', merged_at: null, updated_at: null },
      ]);
    }

    m = /^\/projects\/([^/]+)\/tags$/.exec(path);
    if (m) {
      const keys = keysOf();
      const names = [...new Set(keys.flatMap((k) => k.tags))].sort();
      return paged(
        names.map((name) => ({
          name,
          keys_count: keys.filter((k) => k.tags.includes(name)).length,
          created_at: '2026-10-01T09:00:00Z',
          updated_at: '2026-10-30T09:00:00Z',
        })),
      );
    }

    m = /^\/projects\/([^/]+)\/keys$/.exec(path);
    if (m) {
      if (state.hold !== null) {
        const signal = init.signal;
        await new Promise<void>((resolve, reject) => {
          void state.hold?.then(resolve);
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      const tag = tagOf();
      return paged(
        keysOf()
          .filter((k) => tag === null || k.tags.includes(tag))
          .map((k) => ({
            id: k.id,
            name: k.name,
            description: k.description ?? null,
            plural: typeof k.base === 'object',
            tags: k.tags,
          })),
      );
    }

    m = /^\/projects\/([^/]+)\/locales\/([^/]+)\/translations$/.exec(path);
    if (m) {
      const tag = tagOf();
      const baseId = localesOf().find((l) => l.default === true)?.id ?? 'loc-en';
      const rows =
        m[2] !== baseId
          ? []
          : keysOf()
              .filter((k) => tag === null || k.tags.includes(tag))
              .flatMap((k) => {
                const key = { id: k.id, name: k.name, plural: typeof k.base === 'object' };
                if (k.base === undefined) return [];
                if (typeof k.base === 'string') {
                  return [{ id: `t-${k.id}`, content: k.base, plural_suffix: '', key }];
                }
                return Object.entries(k.base).map(([suffix, content]) => ({
                  id: `t-${k.id}-${suffix}`,
                  content,
                  plural_suffix: suffix,
                  key,
                }));
              });
      return paged(rows);
    }

    m = /^\/projects\/([^/]+)\/uploads$/.exec(path);
    if (m && method === 'POST') {
      const form = init.body as FormData;
      const fields: Record<string, string> = {};
      let fileName = '';
      let fileText = '';
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') fields[key] = value;
        else {
          fileName = (value as File).name;
          fileText = await (value as Blob).text();
        }
      }
      state.uploads.push({ projectId: m[1] as string, fields, fileName, fileText });
      const id = `up${state.uploads.length}`;
      polls.set(id, 0);
      // Phrase's rule, as it answered a real push: a fixed language for a file
      // that still brings both of XLIFF's sides is refused.
      const on = (key: string) => fields[`format_options[${key}]`] === 'true';
      if (
        on('override_file_language') &&
        !on('ignore_source_translations') &&
        !on('ignore_target_translations')
      ) {
        return json(
          {
            id,
            state: 'error',
            error_message: TWO_LANGUAGES,
            url: `https://app.phrase.com/uploads/${id}`,
            summary: {},
          },
          { status: 201 },
        );
      }
      return json(
        { id, state: 'processing', summary: {}, locale_id: fields['locale_id'] },
        { status: 201 },
      );
    }

    m = /^\/projects\/([^/]+)\/uploads\/([^/]+)$/.exec(path);
    if (m) {
      const id = m[2] as string;
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      const upload = state.uploads[Number(id.slice(2)) - 1];
      if (n < state.processingPolls) return json({ id, state: 'processing', summary: {} });
      if (upload && state.failLocales.has(upload.fields['locale_id'] ?? '')) {
        // `error_message` is where the real API puts the reason.
        return json({
          id,
          state: 'error',
          error_message: 'Could not parse the file',
          url: `https://app.phrase.com/uploads/${id}`,
          summary: {},
        });
      }
      const localeId = upload?.fields['locale_id'] ?? '';
      const create = n === state.processingPolls && state.createLocaleFor.has(localeId);
      if (create) state.locales.push({ id: `new-${localeId}`, name: localeId, code: localeId });
      return json({
        id,
        state: 'success',
        summary: {
          translation_keys_created: 1,
          translations_created: 2,
          translations_updated: 0,
          ...(state.createLocaleFor.has(localeId) ? { locales_created: 1 } : {}),
        },
      });
    }

    return json({ message: `no route ${method} ${path}` }, { status: 404 });
  };
  (state as { fetch: typeof fetch }).fetch = impl as typeof fetch;
  return state;
}
