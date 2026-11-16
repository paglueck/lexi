// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  PhraseTokenCreateRequestSchema,
  PhraseTokenSecretRequestSchema,
  PhraseTokenUpdateRequestSchema,
  PhraseTokenVerifyRequestSchema,
  type PhraseRegionCode,
  type PhraseToken,
  type PhraseTokenVerifyResponse,
  type PhraseTokensResponse,
} from '@lexi/shared';

import { badRequest, notFound, upstream } from '../lib/http-error.js';
import { PhraseClient, PhraseError } from '../services/phrase-client.js';
import type { PhraseTokenFacts, SettingsService } from '../services/settings-service.js';
import type { PhraseRouteOptions } from './phrase.js';

/**
 * S19 — the saved Phrase access tokens.
 *
 * Ungated like `/api/settings`: tokens are machine settings, and adding one is
 * what a user does before there is anything to check out. A secret goes in
 * through POST/PUT and never comes back out — every answer is the token DTO,
 * which carries the last four characters and nothing more.
 *
 * Saving verifies again on the server rather than trusting the browser's
 * earlier "Verify": what is stored is what was checked, by construction.
 */
export function registerPhraseTokens(
  app: FastifyInstance,
  settings: SettingsService,
  opts: PhraseRouteOptions = {},
): void {
  const verify = (token: string, region: PhraseRegionCode) =>
    verifyPhraseToken(token, region, opts);

  const need = (token: PhraseToken | null): PhraseToken => {
    if (token === null) throw notFound('No saved Phrase token with that id.');
    return token;
  };

  app.get('/api/phrase/tokens', async (): Promise<PhraseTokensResponse> => ({
    tokens: settings.tokens(),
  }));

  /** Check a token that is not saved. Saves nothing; a rejection is `ok: false`, not an error. */
  app.post('/api/phrase/tokens/verify', async (req): Promise<PhraseTokenVerifyResponse> => {
    const { token, region } = PhraseTokenVerifyRequestSchema.parse(req.body);
    const { ok, detail, user, org, scopes, projects } = await verify(token, region);
    return { ok, detail, user, org, scopes, projects };
  });

  app.post('/api/phrase/tokens', async (req, reply): Promise<PhraseToken> => {
    const { note, token, region } = PhraseTokenCreateRequestSchema.parse(req.body);
    const result = await verify(token, region);
    if (!result.ok) throw badRequest(result.detail);
    reply.code(201);
    return settings.addToken({ note, secret: token, region, facts: factsOf(result) });
  });

  app.patch('/api/phrase/tokens/:id', async (req): Promise<PhraseToken> => {
    const { id } = req.params as { id: string };
    const patch = PhraseTokenUpdateRequestSchema.parse(req.body);
    return need(await settings.updateToken(id, patch));
  });

  /** "Replace": verified against the token's data center before it is stored. */
  app.put('/api/phrase/tokens/:id/secret', async (req): Promise<PhraseToken> => {
    const { id } = req.params as { id: string };
    const { token } = PhraseTokenSecretRequestSchema.parse(req.body);
    const current = need(settings.token(id));
    const result = await verify(token, current.region);
    if (!result.ok) throw badRequest(result.detail);
    return need(await settings.replaceSecret(id, token, factsOf(result)));
  });

  /**
   * "Check again". Only a rejection (401) marks the token bad; a network
   * failure says nothing about the token, so it is a 502 and the stored status
   * stands.
   */
  app.post('/api/phrase/tokens/:id/check', async (req): Promise<PhraseToken> => {
    const { id } = req.params as { id: string };
    const secret = settings.tokenSecret(id);
    if (secret === null) throw notFound('No saved Phrase token with that id.');
    const result = await verify(secret.token, secret.region);
    if (result.ok) return need(await settings.recordTokenCheck(id, factsOf(result)));
    if (result.rejected) return need(await settings.recordTokenCheck(id, null));
    throw upstream(result.detail);
  });

  app.delete('/api/phrase/tokens/:id', async (req, reply): Promise<void> => {
    const { id } = req.params as { id: string };
    if (!(await settings.removeToken(id))) throw notFound('No saved Phrase token with that id.');
    reply.code(204);
  });
}

/**
 * `GET /user`, `GET /accounts` and `GET /projects` with a token. The user and
 * the projects must answer for the token to count as valid; the organisation
 * is best effort. Phrase has no endpoint that reports a token's own scopes,
 * so `scopes` stays '' (the screen shows "—").
 */
export async function verifyPhraseToken(
  token: string,
  region: PhraseRegionCode,
  opts: PhraseRouteOptions = {},
): Promise<PhraseTokenVerifyResponse & { rejected: boolean }> {
  const failed = (detail: string, rejected: boolean) => ({
    ok: false,
    detail,
    user: '',
    org: '',
    scopes: '',
    projects: [],
    rejected,
  });
  let client: PhraseClient;
  try {
    client = new PhraseClient({
      token,
      region,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      ...(opts.delay === undefined ? {} : { delay: opts.delay }),
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), false);
  }
  try {
    const me = await client.me();
    const [org, projects] = await Promise.all([
      client.accounts().then(
        (names) => names[0] ?? '',
        () => '',
      ),
      client.listProjects(),
    ]);
    return {
      ok: true,
      detail: '',
      user: me.username || me.name,
      org,
      scopes: '',
      projects,
      rejected: false,
    };
  } catch (error) {
    if (error instanceof PhraseError && error.status === 401) {
      return failed(
        `Phrase rejected this token (401). Check the data center: a token from ${region === 'EU' ? 'the US' : 'the EU'} is unknown here.`,
        true,
      );
    }
    return failed(error instanceof Error ? error.message : String(error), false);
  }
}

const factsOf = (r: PhraseTokenVerifyResponse): PhraseTokenFacts => ({
  user: r.user,
  org: r.org,
  scopes: r.scopes,
  projects: r.projects,
});
