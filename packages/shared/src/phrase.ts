// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import { PHRASE_REGIONS, PHRASE_TOKEN_STATUSES } from './constants.js';

/**
 * Phrase Strings — pushing a project's XLIFF files with its `.phrase.yml`.
 *
 * lexi talks to the Phrase REST API (v2) itself rather than shelling out to the
 * Phrase CLI, but reads the same `.phrase.yml` the CLI reads, so `phrase push`
 * and lexi's "Push to Phrase" upload the same files with the same parameters.
 *
 * Access tokens are machine settings (`/api/phrase/tokens`) whose secrets never
 * reach the browser; `tokenSource` only says where the one in use was found.
 */

const PhraseScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * A `push.sources[].params` value, passed to the upload endpoint verbatim. The
 * object form is for `format_options` and `locale_mapping`, which the API takes
 * as nested form fields.
 */
export const PhraseParamValueSchema = z.union([
  PhraseScalarSchema,
  z.array(z.string()),
  z.record(z.string(), PhraseScalarSchema),
]);
export type PhraseParamValue = z.infer<typeof PhraseParamValueSchema>;

/** One file `push.sources` resolved to, with the locale and params it uploads with. */
export const PhrasePushFileSchema = z.object({
  /** Relative to the project root, `/`-separated. */
  relPath: z.string(),
  /** A Phrase locale id, name or code — resolved to an id against the project at push time. */
  localeId: z.string(),
  /** Usually the config's `project_id`; a source may name its own. */
  projectId: z.string(),
  /** Everything else the upload is sent with: `file_format`, `update_translations`, `tags`, … */
  params: z.record(z.string(), PhraseParamValueSchema),
});
export type PhrasePushFile = z.infer<typeof PhrasePushFileSchema>;

/** A Phrase locale a push file was resolved to — the id is what is uploaded with. */
export const PhraseLocaleRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
});
export type PhraseLocaleRef = z.infer<typeof PhraseLocaleRefSchema>;

/** A push file as the status shows it: with the Phrase locale it goes to. */
export const PhraseStatusFileSchema = PhrasePushFileSchema.extend({
  /**
   * The one Phrase locale `localeId` resolves to in the main project; null
   * when it resolves to none or to several (a problem says which), or when
   * Phrase could not be asked.
   */
  target: PhraseLocaleRefSchema.nullable(),
});
export type PhraseStatusFile = z.infer<typeof PhraseStatusFileSchema>;

export const PHRASE_TOKEN_SOURCES = ['settings', 'config', 'env'] as const;
export type PhraseTokenSource = (typeof PHRASE_TOKEN_SOURCES)[number];

/** `GET /api/phrase/status` — what a push would do, and what stops it. */
export const PhraseStatusSchema = z.object({
  /** `.phrase.yml` or `.phrase.yaml` in the project root, relative; null when absent. */
  configFile: z.string().nullable(),
  projectId: z.string().nullable(),
  /** Looked up in Phrase when a token is available; null when it could not be. */
  projectName: z.string().nullable(),
  /** The API base the config points at. */
  host: z.string(),
  tokenSource: z.enum(PHRASE_TOKEN_SOURCES).nullable(),
  files: z.array(PhraseStatusFileSchema),
  /** Sentences a user can act on: a pattern that matched nothing, a missing locale, … */
  problems: z.array(z.string()),
  /**
   * Sources whose `params.locale_id` is a code or name rather than the Phrase
   * locale id, and which `POST /api/phrase/pin-locales` can pin.
   */
  unpinned: z.number().int().nonnegative(),
  /** The branch the config's files were checked against; null for the main project. */
  branch: z.string().nullable(),
});
export type PhraseStatus = z.infer<typeof PhraseStatusSchema>;

/**
 * `GET /api/phrase/status` query: `branch=name` checks against that branch,
 * `branch=` (empty) against the main project, none against what the config says.
 */
export const PhraseStatusQuerySchema = z
  .object({ branch: z.string().max(256).optional() })
  .strict();

/**
 * `POST /api/phrase/pin-locales` — every `params.locale_id` of `.phrase.yml`
 * replaced by the Phrase locale id it resolves to. All or nothing: when one
 * does not resolve to exactly one locale, nothing is written.
 */
export const PhrasePinLocalesResponseSchema = z.object({
  /** Sources rewritten; 0 when there were problems. */
  pinned: z.number().int().nonnegative(),
  problems: z.array(z.string()),
});
export type PhrasePinLocalesResponse = z.infer<typeof PhrasePinLocalesResponseSchema>;

export const PhraseProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The account the project belongs to; several accounts per token are common. */
  account: z.string().nullable(),
});
export type PhraseProjectSummary = z.infer<typeof PhraseProjectSummarySchema>;

export const PhraseProjectsResponseSchema = z.object({
  projects: z.array(PhraseProjectSummarySchema),
});
export type PhraseProjectsResponse = z.infer<typeof PhraseProjectsResponseSchema>;

/** `POST /api/phrase/connect` — write a `.phrase.yml` for this Phrase project. */
export const PhraseConnectRequestSchema = z
  .object({ projectId: z.string().min(1).max(256) })
  .strict();
export type PhraseConnectRequest = z.infer<typeof PhraseConnectRequestSchema>;

/** `POST /api/phrase/test` — is the stored token accepted, and whose is it. */
export const PhraseTestResponseSchema = z.object({
  ok: z.boolean(),
  /** "Signed in as Jane Doe (jdoe)" or the reason it failed. */
  detail: z.string(),
});
export type PhraseTestResponse = z.infer<typeof PhraseTestResponseSchema>;

export const PhrasePushFileResultSchema = z.object({
  relPath: z.string(),
  localeId: z.string(),
  ok: z.boolean(),
  /** Phrase's upload summary — `translation_keys_created`, `translations_updated`, … */
  summary: z.record(z.string(), z.number()),
  error: z.string().nullable(),
});
export type PhrasePushFileResult = z.infer<typeof PhrasePushFileResultSchema>;

/** An open (not yet merged) branch of a Phrase project. */
export const PhraseBranchSchema = z.object({
  name: z.string(),
  /** ISO time; null when Phrase did not say. */
  updatedAt: z.string().nullable(),
});
export type PhraseBranch = z.infer<typeof PhraseBranchSchema>;

/** `GET /api/phrase/branches` — the branches a push of the open project may go to. */
export const PhraseBranchesResponseSchema = z.object({
  branches: z.array(PhraseBranchSchema),
  /**
   * The branch `.phrase.yml` already pushes to (`params.branch`, the same on
   * every source of the config's project); null when it names none, or several.
   */
  configured: z.string().nullable(),
});
export type PhraseBranchesResponse = z.infer<typeof PhraseBranchesResponseSchema>;

/**
 * `POST /api/phrase/push`. `branch` left out: the config decides, as `phrase
 * push` would. `null`: the main project, even when the config names a branch.
 * A name: that branch, for every source of the config's project.
 *
 * `verify` left out: the config's `verify_mentioned_translations` decides.
 * true/false: every upload is sent with that value, so the translations it
 * mentions land verified (or as Phrase would otherwise leave them).
 */
export const PhrasePushRequestSchema = z
  .object({
    branch: z.string().min(1).max(256).nullable().optional(),
    verify: z.boolean().optional(),
  })
  .strict();
export type PhrasePushRequest = z.infer<typeof PhrasePushRequestSchema>;

/**
 * `POST /api/phrase/push`. One file failing does not stop the others; a
 * cancel (`POST /api/phrase/push/cancel`) stops the ones not yet uploaded.
 */
export const PhrasePushResponseSchema = z.object({
  ok: z.boolean(),
  /** The push was cancelled; the files it did not reach say so. */
  cancelled: z.boolean(),
  /** The branch the config's project was pushed to; null for the main project. */
  branch: z.string().nullable(),
  results: z.array(PhrasePushFileResultSchema),
  /**
   * Locales Phrase created during the push — never intended, so always a
   * failure. Each entry is a sentence naming the locale.
   */
  createdLocales: z.array(z.string()),
});
export type PhrasePushResponse = z.infer<typeof PhrasePushResponseSchema>;

/* ---- tokens (S19) ---------------------------------------------------------- */

export const PhraseRegionSchema = z.enum(PHRASE_REGIONS);
export type PhraseRegion = z.infer<typeof PhraseRegionSchema>;

/**
 * A saved access token as the browser sees it — everything but the secret,
 * of which only the last four characters travel, so two tokens can be told
 * apart in a list.
 */
export const PhraseTokenSchema = z.object({
  /** Local id, never the token. `.lexi/phrase.json` refers to it as `tokenRef`. */
  id: z.string(),
  /** What the user wrote to tell tokens apart. */
  note: z.string(),
  region: PhraseRegionSchema,
  /** Last four characters of the secret. */
  suffix: z.string(),
  /** Phrase username; '' until the token was checked once. */
  user: z.string(),
  /** Account name; '' when unknown. */
  org: z.string(),
  /** Best effort; '' when Phrase did not say. */
  scopes: z.string(),
  /** Projects the token could read when last checked (kept when it is rejected). */
  projects: z.array(PhraseProjectSummarySchema),
  status: z.enum(PHRASE_TOKEN_STATUSES),
  /** ISO time of the last check; null if never checked. */
  checkedAt: z.string().nullable(),
});
export type PhraseToken = z.infer<typeof PhraseTokenSchema>;

export const PhraseTokensResponseSchema = z.object({ tokens: z.array(PhraseTokenSchema) });
export type PhraseTokensResponse = z.infer<typeof PhraseTokensResponseSchema>;

/** `POST /api/phrase/tokens/verify` — check a token that is not saved yet. */
export const PhraseTokenVerifyRequestSchema = z
  .object({ token: z.string().min(1).max(4096), region: PhraseRegionSchema })
  .strict();
export type PhraseTokenVerifyRequest = z.infer<typeof PhraseTokenVerifyRequestSchema>;

export const PhraseTokenVerifyResponseSchema = z.object({
  ok: z.boolean(),
  /** The reason it failed, as a sentence; '' when ok. */
  detail: z.string(),
  user: z.string(),
  org: z.string(),
  scopes: z.string(),
  projects: z.array(PhraseProjectSummarySchema),
});
export type PhraseTokenVerifyResponse = z.infer<typeof PhraseTokenVerifyResponseSchema>;

/** `POST /api/phrase/tokens` — the server verifies again before it saves. */
export const PhraseTokenCreateRequestSchema = z
  .object({
    note: z.string().trim().min(1).max(200),
    token: z.string().min(1).max(4096),
    region: PhraseRegionSchema,
  })
  .strict();
export type PhraseTokenCreateRequest = z.infer<typeof PhraseTokenCreateRequestSchema>;

/** `PATCH /api/phrase/tokens/:id`. */
export const PhraseTokenUpdateRequestSchema = z
  .object({
    note: z.string().max(200).optional(),
    region: PhraseRegionSchema.optional(),
  })
  .strict();
export type PhraseTokenUpdateRequest = z.infer<typeof PhraseTokenUpdateRequestSchema>;

/** `PUT /api/phrase/tokens/:id/secret` — replace the secret, verified first. */
export const PhraseTokenSecretRequestSchema = z
  .object({ token: z.string().min(1).max(4096) })
  .strict();
export type PhraseTokenSecretRequest = z.infer<typeof PhraseTokenSecretRequestSchema>;

/* ---- checkout (S18) -------------------------------------------------------- */

export const PhraseLocaleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  /** Phrase's `default` flag: the project's base locale. */
  isDefault: z.boolean(),
});
export type PhraseLocale = z.infer<typeof PhraseLocaleSchema>;

/** `GET /api/phrase/tokens/:tokenId/projects/:projectId`. */
export const PhraseProjectDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Code of the default locale; '' if the project has none. */
  baseLocale: z.string(),
  /** Every locale, base included, in Phrase's order. */
  locales: z.array(PhraseLocaleSchema),
});
export type PhraseProjectDetail = z.infer<typeof PhraseProjectDetailSchema>;

export const PhraseTagSchema = z.object({
  name: z.string(),
  keysCount: z.number().int().nonnegative(),
  /** ISO time; null when Phrase did not say. */
  updatedAt: z.string().nullable(),
});
export type PhraseTag = z.infer<typeof PhraseTagSchema>;

/** `GET /api/phrase/tokens/:tokenId/projects/:projectId/tags`. */
export const PhraseTagsResponseSchema = z.object({ tags: z.array(PhraseTagSchema) });
export type PhraseTagsResponse = z.infer<typeof PhraseTagsResponseSchema>;

/**
 * What a checkout takes: every key of the project, or the keys carrying any
 * of one or more tags (a union — a key with two of the tags comes once).
 */
export const PhraseCheckoutScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z
    .object({
      kind: z.literal('tags'),
      tags: z
        .array(z.string().min(1).max(512))
        .min(1)
        .max(200)
        .refine((tags) => new Set(tags).size === tags.length, 'tags must be unique'),
    })
    .strict(),
]);
export type PhraseCheckoutScope = z.infer<typeof PhraseCheckoutScopeSchema>;

/**
 * `GET …/projects/:projectId/preview?scope=all`, or one `tag` parameter per
 * tag (`?tag=a&tag=b`, each value URL-encoded — not a comma list, since a tag
 * may contain a comma) — the first keys of the scope with their base text.
 */
export const PhraseScopePreviewSchema = z.object({
  scope: PhraseCheckoutScopeSchema,
  /**
   * One tag: Phrase's exact count. Several: the sum, an upper bound because
   * tags may share keys. All: the base locale's key total. null when unknown.
   */
  keysCount: z.number().int().nonnegative().nullable(),
  /** False when `keysCount` is only an upper bound. */
  exact: z.boolean(),
  /** Latest change among the tags; null for all keys or when Phrase did not say. */
  updatedAt: z.string().nullable(),
  sample: z.array(z.object({ key: z.string(), text: z.string() })),
});
export type PhraseScopePreview = z.infer<typeof PhraseScopePreviewSchema>;

/**
 * `GET …/projects/:projectId/keys`, with the preview's query — every key of
 * the scope with its base text, deduped, in the order (and with the text) a
 * checkout of that scope writes.
 */
export const PhraseScopeKeysSchema = z.object({
  scope: PhraseCheckoutScopeSchema,
  keys: z.array(z.object({ key: z.string(), text: z.string() })),
});
export type PhraseScopeKeys = z.infer<typeof PhraseScopeKeysSchema>;

/**
 * `GET …/projects/:projectId/branches` — the open branches a checkout may read
 * from. `GET …/projects/:projectId` and its `/tags`, `/preview` and `/keys` take
 * an optional `branch` query parameter (left out or empty: the main project).
 */
export const PhraseCheckoutBranchesResponseSchema = z.object({
  branches: z.array(PhraseBranchSchema),
});
export type PhraseCheckoutBranchesResponse = z.infer<typeof PhraseCheckoutBranchesResponseSchema>;

/** `POST /api/phrase/checkout`. */
export const PhraseCheckoutRequestSchema = z
  .object({
    tokenId: z.string().min(1),
    projectId: z.string().min(1).max(256),
    /** An open branch to check out from; left out or null: the main project. */
    branch: z.string().min(1).max(256).nullable().optional(),
    scope: PhraseCheckoutScopeSchema,
    /** Absolute; must be inside the allowed roots. Created when missing. */
    parentDir: z.string().min(1).max(4096),
    folderName: z.string().max(255),
    /** Target locale codes. The base locale is always written and need not be listed. */
    locales: z.array(z.string().min(1).max(35)).min(1),
  })
  .strict();
export type PhraseCheckoutRequest = z.infer<typeof PhraseCheckoutRequestSchema>;

export const PhraseCheckoutResultSchema = z.object({
  /** The new project's absolute path. */
  path: z.string(),
  /** Written files, relative to `path`. */
  files: z.array(z.string()),
  keys: z.number().int().nonnegative(),
});
export type PhraseCheckoutResult = z.infer<typeof PhraseCheckoutResultSchema>;

/** `POST /api/phrase/checkout/validate` — the folder checks of step 3, without writing. */
export const PhraseCheckoutValidateRequestSchema = z
  .object({ parentDir: z.string().min(1).max(4096), folderName: z.string().max(255) })
  .strict();
export const PhraseCheckoutValidateResponseSchema = z.object({
  /** null when fine; otherwise the sentence to show under the field. */
  error: z.string().nullable(),
});
export type PhraseCheckoutValidateResponse = z.infer<typeof PhraseCheckoutValidateResponseSchema>;

/**
 * `<root>/.lexi/phrase.json` — where a checked-out project came from. Powers
 * the Recent badge and picks the token a later push uses. Never the token.
 */
export const PhraseOriginSchema = z.object({
  region: PhraseRegionSchema,
  projectId: z.string(),
  projectName: z.string(),
  /** The branch the keys came from; null or absent for the main project. */
  branch: z.string().nullable().optional(),
  /**
   * What was checked out. Files written before scopes existed carry only
   * `tag`; read them with `phraseOriginScope`.
   */
  scope: PhraseCheckoutScopeSchema,
  baseLocale: z.string(),
  locales: z.array(z.string()),
  keyIds: z.array(z.string()),
  fetchedAt: z.string(),
  /** The local token id, not the token. */
  tokenRef: z.string(),
});
export type PhraseOrigin = z.infer<typeof PhraseOriginSchema>;

/**
 * The scope of a parsed-but-unvalidated `phrase.json`: `scope` when present,
 * else the single `tag` the first version wrote, else null.
 */
export function phraseOriginScope(raw: unknown): PhraseCheckoutScope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const scope = PhraseCheckoutScopeSchema.safeParse(record['scope']);
  if (scope.success) return scope.data;
  const tag = record['tag'];
  return typeof tag === 'string' && tag !== '' ? { kind: 'tags', tags: [tag] } : null;
}
