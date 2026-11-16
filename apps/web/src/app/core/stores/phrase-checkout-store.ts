// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  PhraseBranch,
  PhraseCheckoutResult,
  PhraseCheckoutScope,
  PhraseProjectDetail,
  PhraseScopeKeys,
  PhraseScopePreview,
  PhraseTag,
  PhraseToken,
} from '@lexi/shared';
import {
  PHRASE_CHECKOUT_STEPS,
  type PhraseCheckoutStep,
  type PhraseCheckoutStepState,
} from '@lexi/shared/constants';

import { PhraseCheckoutApi } from '../api/phrase-checkout-api.js';
import { PhraseTokensApi } from '../api/phrase-tokens-api.js';
import { ProjectApi } from '../api/project-api.js';
import { messageOf } from '../api/server-message.js';
import { count } from '../format-time.js';
import { EventsStore } from './events-store.js';
import { SettingsStore } from './settings-store.js';

export type CheckoutStepNo = 1 | 2 | 3 | 4;
export type RunPhase = 'idle' | 'running' | 'done' | 'failed';
/** Step 2: every key of the project, or the keys carrying any of the picked tags. */
export type CheckoutMode = 'all' | 'tags';

/** How many keys a scope holds, as far as Lexi knows before fetching them. */
export interface ScopeCount {
  /** null when unknown (all keys, before the preview said). */
  readonly keys: number | null;
  /** False when `keys` is only an upper bound: several tags may share keys. */
  readonly exact: boolean;
}

/** Wait this long after the last scope change before asking for a preview. */
export const PREVIEW_DEBOUNCE_MS = 250;
/** How many rows of the full key list render at once; "Show more" adds as many again. */
export const KEYS_PAGE = 200;

export type ScopeKeyRow = PhraseScopeKeys['keys'][number];
/**
 * Step 2's full key list for the current scope, once the user asked for it:
 * null while the preview shows only its sample.
 */
export type AllKeysState =
  | null
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly keys: readonly ScopeKeyRow[] }
  | { readonly status: 'error'; readonly message: string };
/** A log row's state: the server's four, plus `pending` before it started. */
export type RunRowState = PhraseCheckoutStepState | 'pending';

export interface RunRow {
  readonly step: PhraseCheckoutStep;
  readonly label: string;
  readonly detail: string;
  readonly state: RunRowState;
}

/** Folder-name rules the server applies too; checked here so the field answers at once. */
export function folderNameError(name: string): string | null {
  if (name.trim() === '') return 'Enter a folder name.';
  if (/[/:]/.test(name)) return 'A folder name can’t contain / or :';
  return null;
}

/** "all keys", the one tag, or "{n} tags". '' while no tag is picked. */
export function scopeLabel(scope: PhraseCheckoutScope | null): string {
  if (scope === null) return '';
  if (scope.kind === 'all') return 'all keys';
  return scope.tags.length === 1 ? scope.tags[0]! : `${scope.tags.length} tags`;
}

/** "214", "up to 1,240", or "—" when unknown — what goes before " keys". */
export function keysText({ keys, exact }: ScopeCount): string {
  if (keys === null) return '—';
  return exact ? count(keys) : `up to ${count(keys)}`;
}

/**
 * The derived folder name: `{project}` for all keys, `{project}-{tag}`,
 * `{project}-{a}-{b}`, and `{project}-{n}-tags` from three tags on. A branch
 * comes right after the project (`{project}-{branch}-{tag}`), with the
 * characters a folder name cannot hold (`/`, `\`, `:`) turned into dashes.
 */
export function defaultFolderName(
  project: string,
  scope: PhraseCheckoutScope | null,
  branch: string | null = null,
): string {
  const head = [project, ...(branch === null ? [] : [branch.replace(/[/\\:]+/g, '-')])]
    .filter((part) => part !== '')
    .join('-');
  if (scope === null || scope.kind === 'all') return head;
  const suffix = scope.tags.length <= 2 ? scope.tags.join('-') : `${scope.tags.length}-tags`;
  return head === '' ? suffix : `${head}-${suffix}`;
}

const scopeKey = (scope: PhraseCheckoutScope): string =>
  scope.kind === 'all' ? 'all' : `tags\n${scope.tags.join('\n')}`;

/** The two steps a checkout can still be cancelled in. */
const CANCELLABLE: ReadonlySet<PhraseCheckoutStep> = new Set(['fetch-keys', 'fetch-base']);

/**
 * S18 — the Phrase checkout dialog's state (README "State").
 *
 * Reset rules, from the prototype:
 * - picking a token selects its first project, then that project's first tag
 *   (or all keys when it has no tags); the folder name goes back to
 *   automatic, every locale is ticked again and the tag filter is cleared;
 * - picking a project does the same, minus the token;
 * - changing the scope (mode or tags) regenerates the folder name only while
 *   the user has not typed one (`folderName === null` means "derived");
 * - the tag filter only narrows the list; it never changes the selection.
 *
 * Root-provided so "Start another checkout" and a trip to Settings › Phrase
 * keep the picks; `reset()` starts over.
 */
@Injectable({ providedIn: 'root' })
export class PhraseCheckoutStore {
  readonly #tokensApi = inject(PhraseTokensApi);
  readonly #api = inject(PhraseCheckoutApi);
  readonly #projectApi = inject(ProjectApi);
  readonly #events = inject(EventsStore);
  readonly #settings = inject(SettingsStore);

  /* ---- raw state ---- */
  readonly #tokens = signal<readonly PhraseToken[] | null>(null);
  readonly #tokensError = signal<string | null>(null);
  readonly #step = signal<CheckoutStepNo>(1);
  readonly #tokenId = signal<string | null>(null);
  readonly #projectId = signal<string | null>(null);
  /** The open branch the keys are read from; null is the main project. */
  readonly #branch = signal<string | null>(null);
  readonly #mode = signal<CheckoutMode>('tags');
  readonly #selected = signal<ReadonlySet<string>>(new Set());
  /** Whether the picked project got its default scope yet (first tag, or all keys). */
  #defaulted = false;
  readonly #tagFilter = signal('');
  readonly #home = signal<string | null>(null);
  readonly #parentDir = signal<string | null>(null);
  readonly #folderName = signal<string | null>(null);
  readonly #excluded = signal<ReadonlySet<string>>(new Set());
  readonly #serverFolderError = signal<string | null>(null);

  /**
   * Per `${tokenId}\n${projectId}` (plus `\n@{branch}` on a branch), so going
   * back and forth costs no request.
   */
  readonly #details = signal<ReadonlyMap<string, PhraseProjectDetail>>(new Map());
  readonly #tagsByProject = signal<ReadonlyMap<string, readonly PhraseTag[]>>(new Map());
  /** The open branches per `${tokenId}\n${projectId}`; a listing that failed is not kept. */
  readonly #branchesByProject = signal<ReadonlyMap<string, readonly PhraseBranch[]>>(new Map());
  readonly #loadError = signal<string | null>(null);
  /** Per `${tokenId}\n${projectId}\n${scopeKey}`; answered previews only. */
  readonly #previews = signal<ReadonlyMap<string, PhraseScopePreview>>(new Map());
  /** The preview key scheduled or in flight; null when none is. */
  readonly #previewPending = signal<string | null>(null);
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Full key lists, keyed like the previews; answered lists only. */
  readonly #allKeys = signal<ReadonlyMap<string, readonly ScopeKeyRow[]>>(new Map());
  readonly #allKeysErrors = signal<ReadonlyMap<string, string>>(new Map());
  /** Lists being fetched, so a second "Show all" for the same scope asks nothing. */
  readonly #allKeysInFlight = new Set<string>();
  /** The preview key whose full list the user opened; any other scope shows the sample. */
  readonly #allKeysOpen = signal<string | null>(null);
  readonly #keyFilter = signal('');
  readonly #shownCount = signal(KEYS_PAGE);

  readonly #phase = signal<RunPhase>('idle');
  readonly #result = signal<PhraseCheckoutResult | null>(null);
  readonly #runError = signal<string | null>(null);
  readonly #cancelling = signal(false);

  /* ---- public read side ---- */
  readonly tokens = computed(() => this.#tokens() ?? []);
  readonly tokensLoaded = computed(() => this.#tokens() !== null);
  readonly tokensError = this.#tokensError.asReadonly();
  readonly step = this.#step.asReadonly();
  readonly tagFilter = this.#tagFilter.asReadonly();
  readonly loadError = this.#loadError.asReadonly();
  readonly phase = this.#phase.asReadonly();
  readonly result = this.#result.asReadonly();
  readonly runError = this.#runError.asReadonly();
  readonly parentFromLastUse = computed(
    () => (this.#settings.settings()?.launch.lastParentDir ?? null) !== null,
  );

  readonly token = computed<PhraseToken | null>(
    () => this.tokens().find((t) => t.id === this.#tokenId()) ?? null,
  );
  readonly projects = computed(() => this.token()?.projects ?? []);
  readonly project = computed(
    () => this.projects().find((p) => p.id === this.#projectId()) ?? null,
  );
  readonly detail = computed<PhraseProjectDetail | null>(() => {
    const key = this.#key(this.#tokenId(), this.#projectId());
    return key === null ? null : (this.#details().get(key) ?? null);
  });
  readonly tags = computed<readonly PhraseTag[] | null>(() => {
    const key = this.#key(this.#tokenId(), this.#projectId());
    return key === null ? null : (this.#tagsByProject().get(key) ?? null);
  });
  readonly filteredTags = computed(() => {
    const needle = this.#tagFilter().trim().toLowerCase();
    const tags = this.tags() ?? [];
    return needle === '' ? tags : tags.filter((t) => t.name.toLowerCase().includes(needle));
  });
  /** The picked project's open branches; empty while unknown or when it has none. */
  readonly branches = computed<readonly PhraseBranch[]>(() => {
    const key = this.#key(this.#tokenId(), this.#projectId(), null);
    return key === null ? [] : (this.#branchesByProject().get(key) ?? []);
  });
  /** The branch the keys are read from; null for the main project. */
  readonly branch = this.#branch.asReadonly();
  readonly mode = this.#mode.asReadonly();
  /** The picked tags, in Phrase's order. */
  readonly selectedTags = computed<readonly string[]>(() => {
    const selected = this.#selected();
    return (this.tags() ?? []).map((t) => t.name).filter((name) => selected.has(name));
  });
  isTagOn(name: string): boolean {
    return this.#selected().has(name);
  }
  /** What a checkout would take; null while "By tag" has no tag picked. */
  readonly scope = computed<PhraseCheckoutScope | null>(
    () => {
      if (this.#mode() === 'all') return { kind: 'all' };
      const tags = this.selectedTags();
      return tags.length === 0 ? null : { kind: 'tags', tags: [...tags] };
    },
    { equal: (a, b) => (a === null ? b === null : b !== null && scopeKey(a) === scopeKey(b)) },
  );
  readonly scopeLabel = computed(() => scopeLabel(this.scope()));

  readonly #previewKey = computed(() => {
    const key = this.#key(this.#tokenId(), this.#projectId());
    const scope = this.scope();
    return key === null || scope === null ? null : `${key}\n${scopeKey(scope)}`;
  });
  /** The current scope's preview, once Phrase answered. */
  readonly preview = computed<PhraseScopePreview | null>(() => {
    const key = this.#previewKey();
    return key === null ? null : (this.#previews().get(key) ?? null);
  });
  /** The full key list of the current scope, when the user opened it. */
  readonly allKeys = computed<AllKeysState>(() => {
    const key = this.#previewKey();
    if (key === null || this.#allKeysOpen() !== key) return null;
    const keys = this.#allKeys().get(key);
    if (keys !== undefined) return { status: 'loaded', keys };
    const message = this.#allKeysErrors().get(key);
    return message === undefined ? { status: 'loading' } : { status: 'error', message };
  });
  readonly keyFilter = this.#keyFilter.asReadonly();
  /** The loaded list narrowed by the key filter (key name or base text, any case). */
  readonly filteredKeys = computed<readonly ScopeKeyRow[]>(() => {
    const all = this.allKeys();
    if (all?.status !== 'loaded') return [];
    const q = this.#keyFilter().trim().toLowerCase();
    if (q === '') return all.keys;
    return all.keys.filter(
      (row) => row.key.toLowerCase().includes(q) || row.text.toLowerCase().includes(q),
    );
  });
  readonly shownKeys = computed(() => this.filteredKeys().slice(0, this.#shownCount()));
  /** What "Show more" adds: up to a page of the filtered keys not shown yet. */
  readonly moreKeys = computed(() =>
    Math.min(KEYS_PAGE, Math.max(0, this.filteredKeys().length - this.#shownCount())),
  );

  readonly previewLoading = computed(
    () =>
      this.preview() === null &&
      this.#previewKey() !== null &&
      this.#previewPending() === this.#previewKey(),
  );

  /**
   * The scope's key count: the preview's once it answered, else what the tag
   * list says (one tag exact, several summed as an upper bound).
   */
  readonly scopeCount = computed<ScopeCount>(() => {
    const key = this.#previewKey();
    const all = key === null ? undefined : this.#allKeys().get(key);
    if (all !== undefined) return { keys: all.length, exact: true };
    const preview = this.preview();
    if (preview !== null) return { keys: preview.keysCount, exact: preview.exact };
    const scope = this.scope();
    if (scope === null || scope.kind === 'all') return { keys: null, exact: true };
    const byName = new Map((this.tags() ?? []).map((t) => [t.name, t.keysCount]));
    const keys = scope.tags.reduce((sum, name) => sum + (byName.get(name) ?? 0), 0);
    return { keys, exact: scope.tags.length === 1 };
  });
  /** "214", "up to 1,240" or "—". */
  readonly keysText = computed(() => keysText(this.scopeCount()));
  /** Latest change among the picked tags; null for all keys or when unknown. */
  readonly scopeUpdatedAt = computed<string | null>(() => {
    const preview = this.preview();
    if (preview !== null) return preview.updatedAt;
    const scope = this.scope();
    if (scope === null || scope.kind === 'all') return null;
    const picked = new Set(scope.tags);
    const times = (this.tags() ?? [])
      .filter((t) => picked.has(t.name) && t.updatedAt !== null)
      .map((t) => t.updatedAt!);
    return times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b));
  });

  /** A project's cached detail (main project), for the step-1 rows. */
  detailFor(projectId: string): PhraseProjectDetail | null {
    const key = this.#key(this.#tokenId(), projectId, null);
    return key === null ? null : (this.#details().get(key) ?? null);
  }
  tagsFor(projectId: string): readonly PhraseTag[] | null {
    const key = this.#key(this.#tokenId(), projectId, null);
    return key === null ? null : (this.#tagsByProject().get(key) ?? null);
  }

  readonly baseLocale = computed(() => this.detail()?.baseLocale ?? '');
  /** The project's locales minus the base, in Phrase's order. */
  readonly targetLocales = computed(() => {
    const detail = this.detail();
    if (detail === null) return [];
    return detail.locales.filter((l) => !l.isDefault && l.code !== detail.baseLocale);
  });
  readonly selectedLocales = computed(() =>
    this.targetLocales()
      .map((l) => l.code)
      .filter((code) => !this.#excluded().has(code)),
  );
  isLocaleOn(code: string): boolean {
    return !this.#excluded().has(code);
  }

  readonly parentDir = computed(() => {
    const explicit = this.#parentDir();
    if (explicit !== null) return explicit;
    const last = this.#settings.settings()?.launch.lastParentDir ?? null;
    if (last !== null) return last;
    const home = this.#home();
    return home === null ? null : `${home}/translations/phrase`;
  });
  /** What the field shows: the user's text, or `defaultFolderName`. */
  readonly folderName = computed(() => {
    const typed = this.#folderName();
    if (typed !== null) return typed;
    return defaultFolderName(this.project()?.name ?? '', this.scope(), this.#branch());
  });
  readonly folderEdited = computed(() => this.#folderName() !== null);
  readonly folderError = computed(
    () => folderNameError(this.folderName()) ?? this.#serverFolderError(),
  );
  readonly targetPath = computed(() => {
    const parent = this.parentDir();
    return parent === null ? '' : `${parent.replace(/\/+$/, '')}/${this.folderName().trim()}`;
  });
  readonly localesError = computed(() =>
    this.detail() !== null && this.selectedLocales().length === 0
      ? 'Pick at least one target locale.'
      : null,
  );

  /** Continue, per step. */
  readonly canContinue = computed(() => {
    switch (this.#step()) {
      case 1:
        return this.token() !== null && this.token()?.status !== 'bad' && this.project() !== null;
      case 2:
        return this.scope() !== null;
      case 3:
        return (
          this.detail() !== null &&
          this.parentDir() !== null &&
          this.folderError() === null &&
          this.selectedLocales().length > 0
        );
      default:
        return false;
    }
  });

  readonly locked = computed(() => this.#phase() === 'running' || this.#phase() === 'done');

  /** "{n} keys · {base} + {n} locales → {n} XLIFF files". */
  readonly footerSummary = computed(() => {
    const detail = this.detail();
    if (this.scope() === null || detail === null) return '';
    const n = this.selectedLocales().length;
    return `${this.keysText()} keys · ${detail.baseLocale} + ${n} locale${n === 1 ? '' : 's'} → ${n + 1} XLIFF files`;
  });

  /** The rail's four rows. */
  readonly railSummaries = computed<readonly string[]>(() => {
    const token = this.token();
    const project = this.project();
    const phase = this.#phase();
    return [
      token === null ? '' : [noteOf(token), project?.name].filter(Boolean).join(' · '),
      this.scope() === null
        ? ''
        : [this.#branch(), this.scopeLabel(), `${this.keysText()} keys`]
            .filter((part) => part !== null)
            .join(' · '),
      this.folderName() === ''
        ? ''
        : `${this.folderName()} · ${this.selectedLocales().length + 1} files`,
      phase === 'done'
        ? 'Done'
        : phase === 'running'
          ? 'Running…'
          : phase === 'failed'
            ? 'Failed'
            : 'Not started',
    ];
  });

  /** Step 4's six log rows: defaults from the picks, replaced by what the server says. */
  readonly runRows = computed<readonly RunRow[]>(() => {
    const frames = this.#events.phraseCheckout();
    const scope = this.scope();
    const { keys, exact } = this.scopeCount();
    const keysText = this.keysText();
    const base = this.baseLocale();
    const targets = this.selectedLocales();
    const branch = this.#branch();
    const fetchLabel =
      (scope === null || scope.kind === 'all'
        ? 'Fetch all keys'
        : scope.tags.length === 1
          ? `Fetch keys tagged ${scope.tags[0]}`
          : `Fetch keys of ${scope.tags.length} tags`) +
      (branch === null ? '' : ` on branch ${branch}`);
    const defaults: Record<PhraseCheckoutStep, [string, string]> = {
      'fetch-keys': [
        fetchLabel,
        keys !== null && exact
          ? `${keysText} keys · ${Math.ceil(keys / 100)} requests`
          : `${keysText} keys · 100 per request`,
      ],
      'fetch-base': [`Fetch ${base} base text`, `${keysText} translations`],
      'write-base': ['Write messages.xlf', `source-language="${base}" · ${keysText} units`],
      'write-targets': [`Create ${targets.length} target files`, targets.join(', ')],
      'write-origin': ['Write .lexi/phrase.json', 'Phrase project, scope, key ids, fetch time'],
      'add-recent': ['Add to recent projects', 'Shown in the launch menu'],
    };
    const done = this.#phase() === 'done';
    return PHRASE_CHECKOUT_STEPS.map((step) => {
      const frame = frames.get(step);
      const [label, fallback] = defaults[step];
      const state: RunRowState = done ? 'done' : (frame?.state ?? 'pending');
      const detail =
        frame !== undefined && frame.detail !== ''
          ? frame.detail
          : state === 'waiting'
            ? 'Waiting for Phrase rate limit…'
            : fallback;
      return { step, label, detail, state };
    });
  });

  /** Cancel is offered while the keys or the base text are still being fetched. */
  readonly canCancel = computed(() => {
    if (this.#phase() !== 'running' || this.#cancelling()) return false;
    const frames = this.#events.phraseCheckout();
    return ![...frames.keys()].some((step) => !CANCELLABLE.has(step));
  });

  /* ---- loading ---- */

  /** Tokens, and the home folder for the default parent. Keeps picks that still exist. */
  async load(): Promise<void> {
    void this.#settings.load();
    if (this.#home() === null) {
      this.#projectApi
        .roots()
        .then(({ roots }) => this.#home.set(roots[0]?.path ?? null))
        .catch(() => undefined);
    }
    try {
      const { tokens } = await this.#tokensApi.list();
      this.#tokens.set(tokens);
      this.#tokensError.set(null);
    } catch (error) {
      this.#tokens.set([]);
      this.#tokensError.set(messageOf(error, 'The saved Phrase tokens could not be read.'));
      return;
    }
    const current = this.token();
    if (current === null || current.status === 'bad') {
      const first = this.tokens().find((t) => t.status !== 'bad');
      if (first !== undefined) this.selectToken(first.id);
      else {
        this.#tokenId.set(null);
        this.#projectId.set(null);
      }
    } else if (this.project() === null) {
      this.selectToken(current.id);
    } else {
      void this.#loadProject();
    }
  }

  /* ---- step 1 ---- */

  selectToken(id: string): void {
    const token = this.tokens().find((t) => t.id === id);
    if (token === undefined || token.status === 'bad' || this.locked()) return;
    this.#tokenId.set(id);
    this.#pickProject(token.projects[0]?.id ?? null);
  }

  selectProject(id: string): void {
    if (this.locked() || !this.projects().some((p) => p.id === id)) return;
    this.#pickProject(id);
  }

  #pickProject(id: string | null): void {
    this.#projectId.set(id);
    this.#branch.set(null);
    this.#resetPicks();
    void this.#loadProject();
  }

  /** The picks that depend on where the keys come from: back to their defaults. */
  #resetPicks(): void {
    this.#mode.set('tags');
    this.#selected.set(new Set());
    this.#defaulted = false;
    this.#folderName.set(null);
    this.#excluded.set(new Set());
    this.#tagFilter.set('');
    this.#serverFolderError.set(null);
    this.showFewerKeys();
  }

  /* ---- step 2 ---- */

  /**
   * Reads the keys from an open branch, or from the main project (null). The
   * branch has its own tags and locales, so the picks start over as they do
   * for a new project.
   */
  selectBranch(name: string | null): void {
    if (this.locked() || this.#branch() === name) return;
    if (name !== null && !this.branches().some((b) => b.name === name)) return;
    this.#branch.set(name);
    this.#resetPicks();
    void this.#loadProject();
  }

  setTagFilter(value: string): void {
    this.#tagFilter.set(value);
  }

  setMode(mode: CheckoutMode): void {
    if (this.locked() || this.#mode() === mode) return;
    this.#mode.set(mode);
    this.#scopeChanged();
  }

  toggleTag(name: string): void {
    if (this.locked() || !(this.tags() ?? []).some((t) => t.name === name)) return;
    this.#selected.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    this.#scopeChanged();
  }

  /** Adds every tag the filter shows; hidden picks stay picked. */
  selectAllShown(): void {
    if (this.locked()) return;
    this.#selected.update((set) => {
      const next = new Set(set);
      for (const tag of this.filteredTags()) next.add(tag.name);
      return next;
    });
    this.#scopeChanged();
  }

  clearTags(): void {
    if (this.locked() || this.#selected().size === 0) return;
    this.#selected.set(new Set());
    this.#scopeChanged();
  }

  #scopeChanged(): void {
    this.#serverFolderError.set(null);
    this.showFewerKeys();
    this.#schedulePreview();
  }

  /** "Show all keys": the current scope's full list, fetched once per scope. */
  showAllKeys(): void {
    const tokenId = this.#tokenId();
    const projectId = this.#projectId();
    const scope = this.scope();
    const key = this.#previewKey();
    if (tokenId === null || projectId === null || scope === null || key === null) return;
    this.#allKeysOpen.set(key);
    this.#keyFilter.set('');
    this.#shownCount.set(KEYS_PAGE);
    if (this.#allKeys().has(key) || this.#allKeysInFlight.has(key)) return;
    this.#allKeysErrors.update((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
    void this.#loadAllKeys(key, tokenId, projectId, scope, this.#branch());
  }

  /** The next page of the (filtered) full list. */
  showMoreKeys(): void {
    if (this.moreKeys() > 0) this.#shownCount.update((n) => n + KEYS_PAGE);
  }

  /** Back to the preview's sample. The fetched list stays cached. */
  showFewerKeys(): void {
    this.#allKeysOpen.set(null);
    this.#keyFilter.set('');
    this.#shownCount.set(KEYS_PAGE);
  }

  /** Narrows the full list; paging starts over on the narrowed list. */
  setKeyFilter(value: string): void {
    this.#keyFilter.set(value);
    this.#shownCount.set(KEYS_PAGE);
  }

  /* ---- step 3 ---- */

  setParentDir(path: string): void {
    this.#parentDir.set(path);
    this.#serverFolderError.set(null);
  }

  setFolderName(value: string): void {
    this.#folderName.set(value);
    this.#serverFolderError.set(null);
  }

  toggleLocale(code: string): void {
    this.#excluded.update((set) => {
      const next = new Set(set);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  selectAllLocales(): void {
    this.#excluded.set(new Set());
  }

  selectNoLocales(): void {
    this.#excluded.set(new Set(this.targetLocales().map((l) => l.code)));
  }

  /** The server's existence check. Returns whether the folder is usable. */
  async validateFolder(): Promise<boolean> {
    const parent = this.parentDir();
    const name = this.folderName();
    if (parent === null || folderNameError(name) !== null) return false;
    try {
      const { error } = await this.#api.validate(parent, name);
      // A newer edit wins over a late answer about an older name.
      if (this.parentDir() === parent && this.folderName() === name) {
        this.#serverFolderError.set(error);
      }
      return error === null;
    } catch (error) {
      this.#serverFolderError.set(messageOf(error, 'Lexi could not check this folder.'));
      return false;
    }
  }

  /* ---- navigation ---- */

  async next(): Promise<void> {
    const step = this.#step();
    if (!this.canContinue() || step === 4) return;
    if (step === 3 && !(await this.validateFolder())) return;
    this.#step.set((step + 1) as CheckoutStepNo);
  }

  back(): void {
    const step = this.#step();
    if (step === 1 || this.locked()) return;
    if (this.#phase() === 'failed') this.#resetRun();
    this.#step.set((step - 1) as CheckoutStepNo);
  }

  /** Rail rows: only completed steps, and never while a checkout runs or is done. */
  goTo(step: CheckoutStepNo): void {
    if (this.locked() || step >= this.#step()) return;
    if (this.#phase() === 'failed') this.#resetRun();
    this.#step.set(step);
  }

  /* ---- step 4 ---- */

  async start(): Promise<void> {
    const token = this.token();
    const project = this.project();
    const scope = this.scope();
    const parentDir = this.parentDir();
    if (token === null || project === null || scope === null || parentDir === null) return;
    if (this.#phase() === 'running' || this.selectedLocales().length === 0) return;

    this.#events.clearPhraseCheckout();
    this.#phase.set('running');
    this.#runError.set(null);
    this.#result.set(null);
    this.#cancelling.set(false);
    try {
      const result = await this.#api.checkout({
        tokenId: token.id,
        projectId: project.id,
        ...(this.#branch() === null ? {} : { branch: this.#branch() }),
        scope,
        parentDir,
        folderName: this.folderName().trim(),
        locales: [...this.selectedLocales()],
      });
      this.#result.set(result);
      this.#phase.set('done');
      // The server remembered this parent; the next default follows it.
      this.#parentDir.set(null);
      void this.#settings.reload();
    } catch (error) {
      const message = messageOf(error, 'The checkout failed.');
      // A cancel answers the pending request with 409 "Checkout cancelled.":
      // back to idle, not a failure.
      if (this.#cancelling() || message === 'Checkout cancelled.') {
        this.#resetRun();
        return;
      }
      this.#runError.set(message);
      this.#phase.set('failed');
    } finally {
      this.#cancelling.set(false);
    }
  }

  async cancel(): Promise<void> {
    if (!this.canCancel()) return;
    this.#cancelling.set(true);
    await this.#api.cancel().catch(() => this.#cancelling.set(false));
  }

  /**
   * The failed row: whichever the server marked, else the first that did not
   * finish, carrying the error.
   */
  readonly failedRow = computed<PhraseCheckoutStep | null>(() => {
    if (this.#phase() !== 'failed') return null;
    const rows = this.runRows();
    return (
      rows.find((r) => r.state === 'failed')?.step ??
      rows.find((r) => r.state !== 'done')?.step ??
      null
    );
  });

  /** "Start another checkout": back to step 1 with the same picks. */
  restart(): void {
    this.#resetRun();
    this.#serverFolderError.set(null);
    this.#step.set(1);
    void this.load();
  }

  /** A fresh dialog: nothing running, step 1. Picks survive while their token does. */
  reset(): void {
    if (this.#phase() === 'running') return;
    this.#resetRun();
    this.#step.set(1);
  }

  #resetRun(): void {
    this.#phase.set('idle');
    this.#result.set(null);
    this.#runError.set(null);
    this.#events.clearPhraseCheckout();
  }

  /* ---- fetching ---- */

  /** The cache key of a project's reads: on `branch` (the current one unless given). */
  #key(
    tokenId: string | null,
    projectId: string | null,
    branch: string | null = this.#branch(),
  ): string | null {
    if (tokenId === null || projectId === null) return null;
    return `${tokenId}\n${projectId}${branch === null ? '' : `\n@${branch}`}`;
  }

  async #loadProject(): Promise<void> {
    const tokenId = this.#tokenId();
    const projectId = this.#projectId();
    const key = this.#key(tokenId, projectId);
    if (key === null || tokenId === null || projectId === null) return;
    const branch = this.#branch();
    this.#loadError.set(null);
    void this.#loadBranches(tokenId, projectId);
    try {
      const [detail, tags] = await Promise.all([
        this.#details().get(key) ?? this.#api.project(tokenId, projectId, branch),
        this.#tagsByProject().get(key) ??
          this.#api.tags(tokenId, projectId, branch).then((r) => r.tags),
      ]);
      this.#details.update((m) => new Map(m).set(key, detail));
      this.#tagsByProject.update((m) => new Map(m).set(key, tags));
    } catch (error) {
      if (this.#key(this.#tokenId(), this.#projectId()) === key) {
        this.#loadError.set(messageOf(error, 'Lexi could not read this project from Phrase.'));
      }
      return;
    }
    // Still the project (and branch) the user is looking at: its first tag, or all keys.
    if (this.#key(this.#tokenId(), this.#projectId()) !== key) return;
    if (!this.#defaulted) {
      this.#defaulted = true;
      const first = this.tags()?.[0]?.name;
      if (first === undefined) this.#mode.set('all');
      else this.#selected.set(new Set([first]));
    }
    // A project just loaded: no keystrokes to wait for.
    this.#schedulePreview(0);
  }

  /**
   * The project's open branches, once. A failure leaves the picker out: the
   * checkout then reads the main project, as it always did.
   */
  async #loadBranches(tokenId: string, projectId: string): Promise<void> {
    const key = this.#key(tokenId, projectId, null);
    if (key === null || this.#branchesByProject().has(key)) return;
    try {
      const { branches } = await this.#api.branches(tokenId, projectId);
      this.#branchesByProject.update((m) => new Map(m).set(key, branches));
    } catch {
      // No branches known: nothing to pick.
    }
  }

  /**
   * Asks for the current scope's preview once the picks settle. An answer for
   * a scope that is no longer current is cached but not shown.
   */
  #schedulePreview(delay = PREVIEW_DEBOUNCE_MS): void {
    if (this.#previewTimer !== null) clearTimeout(this.#previewTimer);
    this.#previewTimer = null;
    const key = this.#previewKey();
    if (key === null || this.#previews().has(key)) {
      this.#previewPending.set(null);
      return;
    }
    this.#previewPending.set(key);
    if (delay === 0) {
      void this.#loadPreview(key);
      return;
    }
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = null;
      void this.#loadPreview(key);
    }, delay);
  }

  /**
   * An answer is cached under the scope it was asked for; it shows only while
   * that scope is still the current, opened one (see `allKeys`).
   */
  async #loadAllKeys(
    key: string,
    tokenId: string,
    projectId: string,
    scope: PhraseCheckoutScope,
    branch: string | null,
  ): Promise<void> {
    this.#allKeysInFlight.add(key);
    try {
      const { keys } = await this.#api.keys(tokenId, projectId, scope, branch);
      this.#allKeys.update((m) => new Map(m).set(key, keys));
    } catch (error) {
      const message = messageOf(error, 'Lexi could not read the keys from Phrase.');
      this.#allKeysErrors.update((m) => new Map(m).set(key, message));
    } finally {
      this.#allKeysInFlight.delete(key);
    }
  }

  async #loadPreview(key: string): Promise<void> {
    const tokenId = this.#tokenId();
    const projectId = this.#projectId();
    const scope = this.scope();
    if (tokenId === null || projectId === null || scope === null) return;
    if (this.#previewKey() !== key) return;
    try {
      const preview = await this.#api.preview(tokenId, projectId, scope, this.#branch());
      this.#previews.update((m) => new Map(m).set(key, preview));
    } catch {
      // The preview is a courtesy; the tag table already says what matters.
    } finally {
      if (this.#previewPending() === key) this.#previewPending.set(null);
    }
  }
}

/** S18/S19: a token without a note still needs a name. */
export function noteOf(token: Pick<PhraseToken, 'note'>): string {
  return token.note.trim() === '' ? 'Untitled token' : token.note;
}
