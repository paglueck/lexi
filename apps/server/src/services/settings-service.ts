// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite } from '@lexi/xliff';
import {
  DEFAULT_LLM_PARAMS,
  DEFAULT_LLM_SETTINGS,
  EDITOR_MODES,
  LLM_ADAPTERS,
  LLM_PARAM_LIMITS,
  LLM_REASONING_EFFORTS,
  PHRASE_REGIONS,
  PHRASE_TOKEN_STATUSES,
  THEME_MODES,
  isLoopbackUrl,
  type EditorMode,
  type LlmAdapter,
  type LlmParams,
  type LlmProbe,
  type LlmSettings,
  type PhraseProjectSummary,
  type PhraseRegionCode,
  type PhraseToken,
  type PhraseTokenStatus,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { LlmEndpoint } from './llm-client.js';

/**
 * Machine settings — `~/.lexi/settings.json`.
 *
 * Not `.lexi/settings.local.json` in the project, which was the original
 * sketch. Two things decided against it, and both are
 * immediate rather than theoretical: `/settings` is the one working route with
 * no project guard, so a store that needed an open project could not answer the
 * first question a new user has; and the endpoint is a fact about this machine,
 * so a per-project copy would have to be re-typed for every repository. The
 * `.gitignore` entry stays where it is — it costs nothing and covers anyone who
 * writes such a file by hand.
 *
 * The directory comes from `cfg.stateDir` for the same reason `recents.json`
 * does: a test that writes into the developer's real home is a test nobody
 * wants to run twice.
 *
 * The file holds an API key and the Phrase tokens, so it is chmod'd to 0600 after every write. That
 * is best effort — a failure to tighten the mode must not lose the setting —
 * but on the platforms that have modes it is the difference between a secret
 * and a world-readable file.
 */

const FILE = 'settings.json';

/** On disk. Committed by nobody, but still versioned so a change is detectable. */
interface SettingsFile {
  version: 1;
  llm: {
    adapter: LlmAdapter;
    baseUrl: string;
    model: string;
    /** The only field in the system that never travels to the browser. */
    apiKey: string;
    params: LlmParams;
    maskPlaceholders: boolean;
    fewShotExamples: boolean;
  };
  theme: ThemeMode;
  editorMode: EditorMode;
  /**
   * Absent in a file written before Phrase support; `sanitize` fills it. A file
   * from the single-token days has `accessToken` instead, which `sanitize`
   * turns into the first entry of `tokens`.
   */
  phrase: {
    tokens: StoredPhraseToken[];
  };
  /** S17. Absent before the launch menu existed. */
  launch: {
    showMenu: boolean;
    lastParentDir: string | null;
  };
}

/** A saved Phrase token as it is on disk: the DTO's fields plus the secret. */
interface StoredPhraseToken {
  id: string;
  note: string;
  region: PhraseRegionCode;
  /** Never sent to the browser; `toDto` sends its last four characters. */
  secret: string;
  user: string;
  org: string;
  scopes: string;
  projects: PhraseProjectSummary[];
  status: PhraseTokenStatus;
  checkedAt: string | null;
}

/** What a successful check against Phrase learned about a token. */
export interface PhraseTokenFacts {
  readonly user: string;
  readonly org: string;
  readonly scopes: string;
  readonly projects: readonly PhraseProjectSummary[];
}

/** A token's secret and where it lives, for the server's own Phrase calls. */
export interface PhraseTokenSecret {
  readonly id: string;
  readonly token: string;
  readonly region: PhraseRegionCode;
}

/** The id the single token of an older settings file gets, stable across boots. */
const MIGRATED_TOKEN_ID = 'default';

function defaults(): SettingsFile {
  return {
    version: 1,
    llm: {
      adapter: 'openai',
      baseUrl: '',
      model: '',
      apiKey: '',
      params: { ...DEFAULT_LLM_PARAMS },
      maskPlaceholders: DEFAULT_LLM_SETTINGS.maskPlaceholders,
      fewShotExamples: DEFAULT_LLM_SETTINGS.fewShotExamples,
    },
    theme: 'system',
    editorMode: 'chips',
    phrase: { tokens: [] },
    launch: { showMenu: true, lastParentDir: null },
  };
}

export class SettingsService {
  #file: SettingsFile = defaults();
  #lastProbe: LlmProbe | null = null;
  #path: string | null = null;

  /**
   * Read the stored settings, or start from the defaults.
   *
   * Every field is validated against its vocabulary rather than trusted, for
   * the same reason `restoreGridView` validates `project.json`: this is a file
   * on disk that a user may have edited, and an out-of-range `concurrency` or
   * an unknown adapter would otherwise become a request nobody can explain.
   */
  async load(cfg: ServerConfig): Promise<void> {
    this.#path = join(cfg.stateDir, FILE);
    const raw = await readFile(this.#path, 'utf8').catch(() => null);
    if (raw === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt settings file must not stop the server booting. Losing the
      // endpoint is recoverable in one screen; refusing to start is not.
      return;
    }
    this.#file = sanitize(parsed);
  }

  /** The endpoint, API key included. Server-side only, by construction. */
  get endpoint(): LlmEndpoint {
    const { adapter, baseUrl, model, apiKey } = this.#file.llm;
    return { adapter, baseUrl, model, apiKey };
  }

  get params(): LlmParams {
    return { ...this.#file.llm.params };
  }

  get maskPlaceholders(): boolean {
    return this.#file.llm.maskPlaceholders;
  }

  /* -- Phrase tokens (S19) -------------------------------------------------- */

  /** Every saved token, secrets left out. */
  tokens(): PhraseToken[] {
    return this.#file.phrase.tokens.map(tokenDto);
  }

  token(id: string): PhraseToken | null {
    const found = this.#find(id);
    return found === undefined ? null : tokenDto(found);
  }

  /** The secret of one saved token. Server-side only. */
  tokenSecret(id: string): PhraseTokenSecret | null {
    const found = this.#find(id);
    return found === undefined ? null : { id: found.id, token: found.secret, region: found.region };
  }

  /**
   * The token a call without a better hint uses: the first one Phrase last
   * accepted, else simply the first — an unchecked token may well work, and
   * trying it says more than refusing to.
   */
  defaultToken(): PhraseTokenSecret | null {
    const tokens = this.#file.phrase.tokens;
    const pick = tokens.find((t) => t.status === 'ok') ?? tokens[0];
    return pick === undefined ? null : { id: pick.id, token: pick.secret, region: pick.region };
  }

  /** `ref` when it still names a saved token, else `defaultToken()`. */
  resolveToken(ref: string | null | undefined): PhraseTokenSecret | null {
    if (ref) {
      const named = this.tokenSecret(ref);
      if (named !== null) return named;
    }
    return this.defaultToken();
  }

  /** Save a token that was just verified. */
  async addToken(input: {
    note: string;
    secret: string;
    region: PhraseRegionCode;
    facts: PhraseTokenFacts;
  }): Promise<PhraseToken> {
    const taken = new Set(this.#file.phrase.tokens.map((t) => t.id));
    let id = '';
    do id = `tok_${randomBytes(6).toString('hex')}`;
    while (taken.has(id));
    const stored: StoredPhraseToken = {
      id,
      note: input.note.trim(),
      region: input.region,
      secret: input.secret.trim(),
      ...checkedOk(input.facts),
    };
    this.#file.phrase.tokens.push(stored);
    await this.#persist();
    return tokenDto(stored);
  }

  /**
   * Change the note or the data center. A new data center makes the last
   * check meaningless — the token is unknown to the other one — so the status
   * goes back to `unchecked` until the next check.
   */
  async updateToken(
    id: string,
    patch: { note?: string | undefined; region?: PhraseRegionCode | undefined },
  ): Promise<PhraseToken | null> {
    const found = this.#find(id);
    if (found === undefined) return null;
    if (patch.note !== undefined) found.note = patch.note.trim();
    if (patch.region !== undefined && patch.region !== found.region) {
      found.region = patch.region;
      found.status = 'unchecked';
    }
    await this.#persist();
    return tokenDto(found);
  }

  /** Replace the secret with one that was just verified. */
  async replaceSecret(id: string, secret: string, facts: PhraseTokenFacts): Promise<PhraseToken | null> {
    const found = this.#find(id);
    if (found === undefined) return null;
    found.secret = secret.trim();
    Object.assign(found, checkedOk(facts));
    await this.#persist();
    return tokenDto(found);
  }

  /**
   * Record a check. A rejected token keeps the projects it could read last
   * time: "Projects last seen with this token" is what S19 shows then.
   */
  async recordTokenCheck(id: string, facts: PhraseTokenFacts | null): Promise<PhraseToken | null> {
    const found = this.#find(id);
    if (found === undefined) return null;
    if (facts === null) {
      found.status = 'bad';
      found.checkedAt = new Date().toISOString();
    } else {
      Object.assign(found, checkedOk(facts));
    }
    await this.#persist();
    return tokenDto(found);
  }

  async removeToken(id: string): Promise<boolean> {
    const before = this.#file.phrase.tokens.length;
    this.#file.phrase.tokens = this.#file.phrase.tokens.filter((t) => t.id !== id);
    if (this.#file.phrase.tokens.length === before) return false;
    await this.#persist();
    return true;
  }

  #find(id: string): StoredPhraseToken | undefined {
    return this.#file.phrase.tokens.find((t) => t.id === id);
  }

  /* -- launch (S17) ---------------------------------------------------------- */

  get showLaunchMenu(): boolean {
    return this.#file.launch.showMenu;
  }

  /** Remembered so the next checkout offers the same parent folder. */
  async setLastParentDir(dir: string): Promise<void> {
    this.#file.launch.lastParentDir = dir;
    await this.#persist();
  }

  get lastProbe(): LlmProbe | null {
    return this.#lastProbe;
  }

  /** Remembered per process, never written to disk — see `SettingsSchema`. */
  recordProbe(probe: LlmProbe): void {
    this.#lastProbe = probe;
  }

  /**
   * Apply a patch and persist.
   *
   * Changing the endpoint drops the last probe result: "reachable" measured
   * against the URL the user just replaced is not a stale fact, it is a wrong
   * one, and S1's environment panel would repeat it.
   */
  async patch(patch: SettingsPatch): Promise<void> {
    const llm = this.#file.llm;

    if (patch.adapter !== undefined && patch.adapter !== llm.adapter) {
      llm.adapter = patch.adapter;
      this.#lastProbe = null;
    }
    if (patch.baseUrl !== undefined && patch.baseUrl.trim() !== llm.baseUrl) {
      llm.baseUrl = patch.baseUrl.trim();
      this.#lastProbe = null;
    }
    if (patch.model !== undefined && patch.model.trim() !== llm.model) {
      llm.model = patch.model.trim();
      this.#lastProbe = null;
    }
    // `''` clears it: there is no other way to say "remove the key I stored".
    // For Copilot the key is the credential itself, so a new one voids the probe.
    if (patch.apiKey !== undefined && patch.apiKey !== llm.apiKey) {
      llm.apiKey = patch.apiKey;
      if (llm.adapter === 'copilot') this.#lastProbe = null;
    }
    // Only the keys the patch actually carries: spreading a zod `.partial()`
    // copies its absent keys as `undefined` and would clear the rest.
    if (patch.params !== undefined) {
      for (const [key, value] of Object.entries(patch.params)) {
        if (value !== undefined) (llm.params as Record<string, unknown>)[key] = value;
      }
    }
    if (patch.maskPlaceholders !== undefined) llm.maskPlaceholders = patch.maskPlaceholders;
    if (patch.fewShotExamples !== undefined) llm.fewShotExamples = patch.fewShotExamples;
    if (patch.theme !== undefined) this.#file.theme = patch.theme;
    if (patch.editorMode !== undefined) this.#file.editorMode = patch.editorMode;
    if (patch.showLaunchMenu !== undefined) this.#file.launch.showMenu = patch.showLaunchMenu;

    await this.#persist();
  }

  toDto(): Settings {
    return {
      llm: this.#publicLlm(),
      theme: this.#file.theme,
      editorMode: this.#file.editorMode,
      lastProbe: this.#lastProbe,
      phrase: { tokens: this.tokens() },
      launch: { ...this.#file.launch },
    };
  }

  #publicLlm(): LlmSettings {
    const llm = this.#file.llm;
    return {
      adapter: llm.adapter,
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiKeySet: llm.apiKey !== '',
      loopback: isLoopbackUrl(llm.baseUrl),
      params: { ...llm.params },
      maskPlaceholders: llm.maskPlaceholders,
      fewShotExamples: llm.fewShotExamples,
    };
  }

  async #persist(): Promise<void> {
    if (this.#path === null) return;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await atomicWrite(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`);
      await chmod(this.#path, 0o600).catch(() => undefined);
    } catch {
      // A read-only home must not turn "I changed the temperature" into a 500.
      // The setting still applies for this process; the next boot loses it.
    }
  }
}

/* -- reading somebody else's file ------------------------------------------ */

function sanitize(parsed: unknown): SettingsFile {
  const out = defaults();
  const root = asRecord(parsed);
  if (root === null) return out;

  const llm = asRecord(root['llm']);
  if (llm !== null) {
    if (oneOf(llm['adapter'], LLM_ADAPTERS)) out.llm.adapter = llm['adapter'];
    if (typeof llm['baseUrl'] === 'string') out.llm.baseUrl = llm['baseUrl'].trim();
    if (typeof llm['model'] === 'string') out.llm.model = llm['model'].trim();
    if (typeof llm['apiKey'] === 'string') out.llm.apiKey = llm['apiKey'];
    if (typeof llm['maskPlaceholders'] === 'boolean') {
      out.llm.maskPlaceholders = llm['maskPlaceholders'];
    }
    if (typeof llm['fewShotExamples'] === 'boolean') {
      out.llm.fewShotExamples = llm['fewShotExamples'];
    }
    out.llm.params = sanitizeParams(asRecord(llm['params']));
  }
  if (oneOf(root['theme'], THEME_MODES)) out.theme = root['theme'];
  if (oneOf(root['editorMode'], EDITOR_MODES)) out.editorMode = root['editorMode'];
  const phrase = asRecord(root['phrase']);
  if (Array.isArray(phrase?.['tokens'])) {
    const seen = new Set<string>();
    for (const raw of phrase['tokens']) {
      const token = sanitizeToken(asRecord(raw));
      if (token === null || seen.has(token.id)) continue;
      seen.add(token.id);
      out.phrase.tokens.push(token);
    }
  }
  // The single token of a file written before S19. Not written back until the
  // next save, so its id must come out the same on every boot: a checkout made
  // in between refers to it by that id.
  const legacy = typeof phrase?.['accessToken'] === 'string' ? phrase['accessToken'].trim() : '';
  if (legacy !== '' && out.phrase.tokens.length === 0) {
    out.phrase.tokens.push({
      id: MIGRATED_TOKEN_ID,
      note: 'Default token',
      region: 'EU',
      secret: legacy,
      user: '',
      org: '',
      scopes: '',
      projects: [],
      status: 'unchecked',
      checkedAt: null,
    });
  }
  // Read back like everything else, or a toggled launch menu would come back
  // on at the next boot — see the note in `sanitizeParams`.
  const launch = asRecord(root['launch']);
  if (typeof launch?.['showMenu'] === 'boolean') out.launch.showMenu = launch['showMenu'];
  if (typeof launch?.['lastParentDir'] === 'string' && launch['lastParentDir'] !== '') {
    out.launch.lastParentDir = launch['lastParentDir'];
  }
  return out;
}

function sanitizeToken(raw: Record<string, unknown> | null): StoredPhraseToken | null {
  if (raw === null) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const secret = typeof raw['secret'] === 'string' ? raw['secret'].trim() : '';
  if (id === '' || secret === '') return null;
  const text = (key: string): string => (typeof raw[key] === 'string' ? raw[key] : '');
  const projects = Array.isArray(raw['projects'])
    ? raw['projects'].flatMap((p): PhraseProjectSummary[] => {
        const r = asRecord(p);
        if (r === null || typeof r['id'] !== 'string') return [];
        return [
          {
            id: r['id'],
            name: typeof r['name'] === 'string' ? r['name'] : '',
            account: typeof r['account'] === 'string' ? r['account'] : null,
          },
        ];
      })
    : [];
  return {
    id,
    note: text('note'),
    region: oneOf(raw['region'], PHRASE_REGIONS) ? raw['region'] : 'EU',
    secret,
    user: text('user'),
    org: text('org'),
    scopes: text('scopes'),
    projects,
    status: oneOf(raw['status'], PHRASE_TOKEN_STATUSES) ? raw['status'] : 'unchecked',
    checkedAt: text('checkedAt') || null,
  };
}

/** Everything but the secret; only its last four characters travel. */
function tokenDto(t: StoredPhraseToken): PhraseToken {
  return {
    id: t.id,
    note: t.note,
    region: t.region,
    suffix: t.secret.slice(-4),
    user: t.user,
    org: t.org,
    scopes: t.scopes,
    projects: t.projects.map((p) => ({ ...p })),
    status: t.status,
    checkedAt: t.checkedAt,
  };
}

const checkedOk = (
  facts: PhraseTokenFacts,
): Pick<StoredPhraseToken, 'user' | 'org' | 'scopes' | 'projects' | 'status' | 'checkedAt'> => ({
  user: facts.user,
  org: facts.org,
  scopes: facts.scopes,
  projects: facts.projects.map((p) => ({ ...p })),
  status: 'ok',
  checkedAt: new Date().toISOString(),
});

function sanitizeParams(params: Record<string, unknown> | null): LlmParams {
  const out: LlmParams = { ...DEFAULT_LLM_PARAMS };
  if (params === null) return out;

  out.temperature = clamped(params['temperature'], LLM_PARAM_LIMITS.temperature, out.temperature);
  out.topP = clamped(params['topP'], LLM_PARAM_LIMITS.topP, out.topP);
  out.maxTokens = Math.round(
    clamped(params['maxTokens'], LLM_PARAM_LIMITS.maxTokens, out.maxTokens),
  );
  // Every stored number needs a line here. A field that is written by PATCH but
  // not read back reverts to its default on the next boot, silently — which is
  // what `contextWindow` did between the milestone that added it and the one
  // that noticed.
  out.contextWindow = Math.round(
    clamped(params['contextWindow'], LLM_PARAM_LIMITS.contextWindow, out.contextWindow),
  );
  out.requestTimeoutSeconds = Math.round(
    clamped(
      params['requestTimeoutSeconds'],
      LLM_PARAM_LIMITS.requestTimeoutSeconds,
      out.requestTimeoutSeconds,
    ),
  );
  out.concurrency = Math.round(
    clamped(params['concurrency'], LLM_PARAM_LIMITS.concurrency, out.concurrency),
  );
  out.unitsPerRequest = Math.round(
    clamped(params['unitsPerRequest'], LLM_PARAM_LIMITS.unitsPerRequest, out.unitsPerRequest),
  );
  // Null is a real value here — "no seed" — so only a non-number that is not
  // null falls back to the default.
  if (params['seed'] === null) out.seed = null;
  else if (typeof params['seed'] === 'number' && Number.isFinite(params['seed'])) {
    out.seed = Math.round(params['seed']);
  }
  // Not a number, so it is read by vocabulary rather than clamped — but it is
  // read, which is the point of the note above. A settings file written before
  // this field existed has no key here and keeps the default, which is how an
  // endpoint that was timing out starts working without anyone editing a file.
  if (oneOf(params['reasoningEffort'], LLM_REASONING_EFFORTS)) {
    out.reasoningEffort = params['reasoningEffort'];
  }
  return out;
}

const clamped = (
  value: unknown,
  limits: { readonly min: number; readonly max: number },
  fallback: number,
): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(limits.max, Math.max(limits.min, value))
    : fallback;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
