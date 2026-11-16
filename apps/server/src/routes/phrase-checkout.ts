// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  PhraseCheckoutRequestSchema,
  PhraseCheckoutValidateRequestSchema,
  type PhraseCheckoutBranchesResponse,
  type PhraseCheckoutResult,
  type PhraseCheckoutValidateResponse,
  PhraseCheckoutScopeSchema,
  type PhraseCheckoutScope,
  type PhraseProjectDetail,
  type PhraseScopeKeys,
  type PhraseScopePreview,
  type PhraseTagsResponse,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { EventBus } from '../lib/event-bus.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import {
  PhraseClient,
  type PhraseKeyRow,
  type PhraseTranslationRow,
} from '../services/phrase-client.js';
import {
  PhraseCheckout,
  fetchScopeKeyTexts,
  validateCheckoutTarget,
  withBaseForm,
} from '../services/phrase-checkout.js';
import type { SettingsService } from '../services/settings-service.js';
import { phraseCall, type PhraseRouteOptions } from './phrase.js';

/** How many keys the scope preview shows. */
const PREVIEW_SAMPLE = 6;
/** How many of the chosen tags the preview samples keys from. */
const PREVIEW_TAGS = 3;

/**
 * S18 — the checkout dialog's reads, and the checkout itself.
 *
 * Ungated: a checkout is how a project comes to exist, so nothing is open yet.
 * The reads go through a saved token by id; the browser never holds one.
 */
export function registerPhraseCheckout(
  app: FastifyInstance,
  cfg: ServerConfig,
  settings: SettingsService,
  bus: EventBus,
  opts: PhraseRouteOptions = {},
): void {
  const checkout = new PhraseCheckout(cfg, settings, bus, {
    client: {
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.delay === undefined ? {} : { delay: opts.delay }),
    },
    beforeRename: opts.beforeCheckoutRename,
  });

  const clientFor = (tokenId: string): PhraseClient => {
    const secret = settings.tokenSecret(tokenId);
    if (secret === null) throw notFound('No saved Phrase token with that id.');
    return new PhraseClient({
      token: secret.token,
      region: secret.region,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.delay === undefined ? {} : { delay: opts.delay }),
    });
  };

  app.get(
    '/api/phrase/tokens/:tokenId/projects/:projectId',
    async (req): Promise<PhraseProjectDetail> => {
      const { tokenId, projectId } = req.params as { tokenId: string; projectId: string };
      const branch = branchParam(req.query);
      const client = clientFor(tokenId);
      const [project, locales] = await phraseCall(() =>
        Promise.all([client.project(projectId), client.listLocales(projectId, { branch })]),
      );
      return {
        id: project.id,
        name: project.name,
        baseLocale: locales.find((l) => l.isDefault)?.code ?? '',
        locales: locales.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          isDefault: l.isDefault,
        })),
      };
    },
  );

  /** The project's open branches, for the picker above step 2's scope. */
  app.get(
    '/api/phrase/tokens/:tokenId/projects/:projectId/branches',
    async (req): Promise<PhraseCheckoutBranchesResponse> => {
      const { tokenId, projectId } = req.params as { tokenId: string; projectId: string };
      const client = clientFor(tokenId);
      return { branches: await phraseCall(() => client.listBranches(projectId)) };
    },
  );

  app.get(
    '/api/phrase/tokens/:tokenId/projects/:projectId/tags',
    async (req): Promise<PhraseTagsResponse> => {
      const { tokenId, projectId } = req.params as { tokenId: string; projectId: string };
      const branch = branchParam(req.query);
      const client = clientFor(tokenId);
      return { tags: await phraseCall(() => client.listTags(projectId, { branch })) };
    },
  );

  /**
   * The first keys of a scope with their base text, for step 2.
   *
   * Query: `?scope=all` for every key, or one `tag` parameter per tag —
   * `?tag=a&tag=b`, each value URL-encoded — for the union of those tags. A
   * repeated parameter rather than a comma list, because a tag may itself
   * contain a comma. Exactly one of the two; 400 otherwise, 404 for a tag the
   * project does not have.
   *
   * One page of keys per tag (the first {@link PREVIEW_TAGS} tags), deduped by
   * key id, and one page of base translations per tag that contributed —
   * joined. A key whose text is on a later translation page shows as '' — a
   * preview, not a promise.
   */
  app.get(
    '/api/phrase/tokens/:tokenId/projects/:projectId/preview',
    async (req): Promise<PhraseScopePreview> => {
      const { tokenId, projectId } = req.params as { tokenId: string; projectId: string };
      const scope = previewScope(req.query);
      const branch = branchParam(req.query);
      const client = clientFor(tokenId);
      return phraseCall(async () => {
        if (scope.kind === 'all') {
          const [locales, keys] = await Promise.all([
            client.listLocales(projectId, { branch }),
            client.listKeys(projectId, undefined, { maxPages: 1, branch }),
          ]);
          const base = locales.find((l) => l.isDefault);
          const sample = keys.slice(0, PREVIEW_SAMPLE);
          const [keysCount, rows] = await Promise.all([
            base === undefined ? null : client.localeStatistics(projectId, base.id, { branch }),
            base === undefined || sample.length === 0
              ? []
              : client.listTranslations(projectId, base.id, { maxPages: 1, branch }),
          ]);
          return {
            scope,
            keysCount,
            exact: true,
            updatedAt: null,
            sample: withText(sample, rows),
          };
        }

        const sampled = scope.tags.slice(0, PREVIEW_TAGS);
        const [tags, locales, ...pages] = await Promise.all([
          client.listTags(projectId, { branch }),
          client.listLocales(projectId, { branch }),
          ...sampled.map((tag) => client.listKeys(projectId, tag, { maxPages: 1, branch })),
        ]);
        const found = scope.tags.map((name) => {
          const tag = tags.find((t) => t.name === name);
          if (tag === undefined) throw notFound(`Phrase project has no tag ${name}.`);
          return tag;
        });

        const sample: PhraseKeyRow[] = [];
        const used: string[] = [];
        const ids = new Set<string>();
        for (const [i, keys] of pages.entries()) {
          if (sample.length >= PREVIEW_SAMPLE) break;
          for (const key of keys) {
            if (sample.length >= PREVIEW_SAMPLE) break;
            if (ids.has(key.id)) continue;
            ids.add(key.id);
            sample.push(key);
            const tag = sampled[i] as string;
            if (!used.includes(tag)) used.push(tag);
          }
        }
        const base = locales.find((l) => l.isDefault);
        const rows =
          base === undefined
            ? []
            : (
                await Promise.all(
                  used.map((tag) =>
                    client.listTranslations(projectId, base.id, { tag, maxPages: 1, branch }),
                  ),
                )
              ).flat();

        const times = found
          .map((t) => t.updatedAt)
          .filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)));
        return {
          scope,
          keysCount: found.reduce((sum, t) => sum + t.keysCount, 0),
          exact: found.length === 1,
          updatedAt:
            times.length === 0
              ? null
              : times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
          sample: withText(sample, rows),
        };
      });
    },
  );

  /**
   * Every key of a scope with its base text — step 2's "Show all keys". The
   * same query as the preview; the same fetch, order and text as a checkout of
   * that scope would write. 404 for a tag the project does not have.
   *
   * A client that goes away (the user changed the scope) aborts the fetch.
   */
  app.get(
    '/api/phrase/tokens/:tokenId/projects/:projectId/keys',
    async (req, reply): Promise<PhraseScopeKeys> => {
      const { tokenId, projectId } = req.params as { tokenId: string; projectId: string };
      const scope = previewScope(req.query);
      const branch = branchParam(req.query);
      const client = clientFor(tokenId);
      const controller = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', onClose);
      try {
        return await phraseCall(async () => {
          const [tags, locales] = await Promise.all([
            scope.kind === 'all'
              ? []
              : client.listTags(projectId, { signal: controller.signal, branch }),
            client.listLocales(projectId, { signal: controller.signal, branch }),
          ]);
          if (scope.kind === 'tags') {
            const missing = scope.tags.find((name) => !tags.some((t) => t.name === name));
            if (missing !== undefined) throw notFound(`Phrase project has no tag ${missing}.`);
          }
          const base = locales.find((l) => l.isDefault);
          const keys = await fetchScopeKeyTexts(client, projectId, base?.id, scope, {
            signal: controller.signal,
            branch,
          });
          return { scope, keys };
        });
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  /** Step 3's inline check, as the user types. Never writes. */
  app.post(
    '/api/phrase/checkout/validate',
    async (req): Promise<PhraseCheckoutValidateResponse> => {
      const { parentDir, folderName } = PhraseCheckoutValidateRequestSchema.parse(req.body);
      const result = await validateCheckoutTarget(cfg, parentDir, folderName);
      return { error: 'error' in result ? result.error : null };
    },
  );

  /**
   * Run the checkout; answers when it is over. Progress travels as
   * `phrase-checkout-progress` events. 400 for a folder that fails validation,
   * 409 while another checkout runs or when this one was cancelled.
   */
  app.post('/api/phrase/checkout', async (req): Promise<PhraseCheckoutResult> => {
    const body = PhraseCheckoutRequestSchema.parse(req.body);
    return checkout.run(body);
  });

  /** 204 when cancelled or when nothing runs; 409 once it is writing. */
  app.post('/api/phrase/checkout/cancel', async (_req, reply): Promise<void> => {
    if (checkout.cancel() === 'writing') {
      throw conflict('The checkout is writing files and can no longer be cancelled.');
    }
    reply.code(204);
  });
}

/**
 * The optional `branch` query parameter: a branch name, or null for the main
 * project (left out or empty). 400 for more than one, or an overlong name.
 */
function branchParam(query: unknown): string | null {
  const value = ((query ?? {}) as Record<string, unknown>)['branch'];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 256) {
    throw badRequest('branch must be a single branch name.');
  }
  return value;
}

/**
 * The preview's scope from its query: `scope=all`, or one `tag` parameter per
 * tag. 400 for neither, both, or anything the scope schema refuses.
 */
function previewScope(query: unknown): PhraseCheckoutScope {
  const q = (query ?? {}) as Record<string, unknown>;
  const all = q['scope'];
  const tag = q['tag'];
  const tags = tag === undefined ? undefined : Array.isArray(tag) ? tag : [tag];
  if ((all === undefined) === (tags === undefined)) {
    throw badRequest('Pass either scope=all or one or more tag parameters.');
  }
  if (all !== undefined && all !== 'all') throw badRequest('scope must be all.');
  const parsed = PhraseCheckoutScopeSchema.safeParse(
    tags === undefined ? { kind: 'all' } : { kind: 'tags', tags },
  );
  if (!parsed.success) throw badRequest('The tags must be distinct and non-empty.');
  return parsed.data;
}

/** The sample keys with their base text, as a checkout would write it. */
function withText(
  keys: readonly PhraseKeyRow[],
  rows: readonly PhraseTranslationRow[],
): Array<{ key: string; text: string }> {
  return withBaseForm(keys, rows).map(({ key, form }) => ({
    key: key.name,
    text: form?.content ?? '',
  }));
}
