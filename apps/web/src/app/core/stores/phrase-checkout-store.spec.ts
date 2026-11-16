// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type {
  PhraseCheckoutScope,
  PhraseProjectDetail,
  PhraseScopeKeys,
  PhraseScopePreview,
  PhraseToken,
} from '@lexi/shared';
import type { PhraseCheckoutStep } from '@lexi/shared/constants';

import { PhraseCheckoutApi } from '../api/phrase-checkout-api.js';
import { PhraseTokensApi } from '../api/phrase-tokens-api.js';
import { ProjectApi } from '../api/project-api.js';
import { EventsStore, type PhraseCheckoutFrame } from './events-store.js';
import {
  KEYS_PAGE,
  PREVIEW_DEBOUNCE_MS,
  PhraseCheckoutStore,
  defaultFolderName,
  folderNameError,
  keysText,
  scopeLabel,
} from './phrase-checkout-store.js';
import { SettingsStore } from './settings-store.js';

/** S18's reset rules, its validation, and how the run follows the SSE rows. */

const token = (over: Partial<PhraseToken> = {}): PhraseToken => ({
  id: 'nw',
  note: 'Northwind',
  region: 'EU',
  suffix: '9f3a',
  user: 'anna',
  org: 'Northwind GmbH',
  scopes: '',
  projects: [
    { id: 'web', name: 'northwind-web', account: null },
    { id: 'admin', name: 'northwind-admin', account: null },
    { id: 'bare', name: 'northwind-bare', account: null },
  ],
  status: 'ok',
  checkedAt: null,
  ...over,
});

const detail = (id: string): PhraseProjectDetail => ({
  id,
  name: id,
  baseLocale: 'en',
  locales: [
    { id: 'l-en', code: 'en', name: 'English', isDefault: true },
    { id: 'l-de', code: 'de', name: 'German', isDefault: false },
    { id: 'l-ar', code: 'ar', name: 'Arabic', isDefault: false },
  ],
});

const TAGS: Record<string, string[]> = {
  web: ['checkout-v2', 'release', 'legacy', 'release-notes'],
  admin: ['roles'],
};
const KEYS: Record<string, number> = { 'checkout-v2': 214, release: 40, legacy: 12 };
/** What a branch of `web` has tagged: its own list, not the main project's. */
const BRANCH_TAGS: Record<string, string[]> = { 'release-2': ['rc', 'docs'], 'feature/x': [] };

const flush = () => new Promise((resolve) => setTimeout(resolve));

/** `n` keys of a scope: `{prefix}.000` … with text `Text {i}`. */
const keyRows = (prefix: string, n: number): PhraseScopeKeys['keys'] =>
  Array.from({ length: n }, (_, i) => ({
    key: `${prefix}.${String(i).padStart(3, '0')}`,
    text: `Text ${i}`,
  }));

async function mount(
  tokens: PhraseToken[] = [
    token(),
    token({
      id: 'ct',
      note: 'Contoso',
      projects: [{ id: 'admin', name: 'contoso', account: null }],
    }),
  ],
) {
  const frames = signal<ReadonlyMap<PhraseCheckoutStep, PhraseCheckoutFrame>>(new Map());
  const events = {
    phraseCheckout: frames,
    clearPhraseCheckout: vi.fn(() => frames.set(new Map())),
  };
  const api = {
    project: vi.fn((_t: string, p: string, _b: string | null = null) =>
      Promise.resolve(detail(p)),
    ),
    branches: vi.fn((_t: string, p: string) =>
      Promise.resolve({
        branches:
          p === 'web'
            ? [
                { name: 'feature/x', updatedAt: null },
                { name: 'release-2', updatedAt: null },
              ]
            : [],
      }),
    ),
    tags: vi.fn((_t: string, p: string, branch: string | null = null) =>
      Promise.resolve({
        tags: (branch === null ? (TAGS[p] ?? []) : (BRANCH_TAGS[branch] ?? [])).map((name) => ({
          name,
          keysCount: KEYS[name] ?? 214,
          updatedAt: null,
        })),
      }),
    ),
    preview: vi.fn(
      (_t: string, _p: string, scope: PhraseCheckoutScope): Promise<PhraseScopePreview> =>
        Promise.resolve({
          scope,
          keysCount: scope.kind === 'all' ? 5000 : 214,
          exact: scope.kind === 'all' || scope.tags.length === 1,
          updatedAt: null,
          sample: [],
        }),
    ),
    keys: vi.fn((_t: string, _p: string, scope: PhraseCheckoutScope): Promise<PhraseScopeKeys> =>
      Promise.resolve({
        scope,
        keys: keyRows(scope.kind === 'all' ? 'all' : scope.tags.join('+'), 450),
      }),
    ),
    validate: vi.fn().mockResolvedValue({ error: null }),
    checkout: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const settings = {
    load: vi.fn().mockResolvedValue(null),
    reload: vi.fn().mockResolvedValue(undefined),
    settings: signal({ launch: { showMenu: true, lastParentDir: null } }),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PhraseTokensApi, useValue: { list: vi.fn().mockResolvedValue({ tokens }) } },
      { provide: PhraseCheckoutApi, useValue: api },
      {
        provide: ProjectApi,
        useValue: {
          roots: vi.fn().mockResolvedValue({ roots: [{ path: '/Users/x', label: 'x' }] }),
        },
      },
      { provide: EventsStore, useValue: events },
      { provide: SettingsStore, useValue: settings },
    ],
  });
  const store = TestBed.inject(PhraseCheckoutStore);
  await store.load();
  await flush();
  return { store, api, frames, settings };
}

const frame = (
  step: PhraseCheckoutStep,
  state: PhraseCheckoutFrame['state'],
  detail = '',
): [PhraseCheckoutStep, PhraseCheckoutFrame] => [
  step,
  { type: 'phrase-checkout-progress', step, state, detail },
];

describe('PhraseCheckoutStore', () => {
  it('starts on the first valid token, its first project and first tag', async () => {
    const { store } = await mount();
    expect(store.token()?.id).toBe('nw');
    expect(store.project()?.id).toBe('web');
    expect(store.mode()).toBe('tags');
    expect(store.selectedTags()).toEqual(['checkout-v2']);
    expect(store.folderName()).toBe('northwind-web-checkout-v2');
    expect(store.parentDir()).toBe('/Users/x/translations/phrase');
    expect(store.selectedLocales()).toEqual(['de', 'ar']);
  });

  it('skips a rejected token, and will not select one', async () => {
    const { store } = await mount([token({ id: 'bad', status: 'bad' }), token()]);
    expect(store.token()?.id).toBe('nw');
    store.selectToken('bad');
    expect(store.token()?.id).toBe('nw');
  });

  it('resets project, tag, folder, locales and filter when the token changes', async () => {
    const { store } = await mount();
    store.setFolderName('custom');
    store.toggleLocale('de');
    store.setTagFilter('rel');
    store.selectToken('ct');
    await flush();
    expect(store.project()?.id).toBe('admin');
    expect(store.selectedTags()).toEqual(['roles']);
    expect(store.folderName()).toBe('contoso-roles');
    expect(store.selectedLocales()).toEqual(['de', 'ar']);
    expect(store.tagFilter()).toBe('');
  });

  it('resets the same things, minus the token, when the project changes', async () => {
    const { store } = await mount();
    store.setFolderName('custom');
    store.toggleLocale('ar');
    store.selectProject('admin');
    await flush();
    expect(store.token()?.id).toBe('nw');
    expect(store.selectedTags()).toEqual(['roles']);
    expect(store.folderEdited()).toBe(false);
    expect(store.selectedLocales()).toEqual(['de', 'ar']);
  });

  it('defaults to all keys when the project has no tags', async () => {
    const { store } = await mount();
    store.selectProject('bare');
    await flush();
    expect(store.mode()).toBe('all');
    expect(store.scope()).toEqual({ kind: 'all' });
    expect(store.folderName()).toBe('northwind-bare');
  });

  it('switches between all keys and tags, keeping the tag picks', async () => {
    const { store } = await mount();
    store.toggleTag('release');
    store.setMode('all');
    expect(store.scope()).toEqual({ kind: 'all' });
    expect(store.scopeLabel()).toBe('all keys');
    store.setMode('tags');
    expect(store.scope()).toEqual({ kind: 'tags', tags: ['checkout-v2', 'release'] });
  });

  it('toggles tags, keeps Phrase’s order, and gates Continue on a pick', async () => {
    const { store } = await mount();
    await store.next();
    expect(store.step()).toBe(2);
    store.toggleTag('legacy');
    store.toggleTag('release');
    expect(store.selectedTags()).toEqual(['checkout-v2', 'release', 'legacy']);
    store.toggleTag('checkout-v2');
    store.toggleTag('release');
    store.toggleTag('legacy');
    expect(store.selectedTags()).toEqual([]);
    expect(store.scope()).toBeNull();
    expect(store.canContinue()).toBe(false);
    store.setMode('all');
    expect(store.canContinue()).toBe(true);
    store.setMode('tags');
    store.toggleTag('release');
    expect(store.canContinue()).toBe(true);
  });

  it('selects only the shown tags, and the filter never changes the selection', async () => {
    const { store } = await mount();
    store.setTagFilter('release');
    expect(store.filteredTags().map((t) => t.name)).toEqual(['release', 'release-notes']);
    expect(store.selectedTags()).toEqual(['checkout-v2']);
    store.selectAllShown();
    expect(store.selectedTags()).toEqual(['checkout-v2', 'release', 'release-notes']);
    store.setTagFilter('');
    expect(store.selectedTags()).toEqual(['checkout-v2', 'release', 'release-notes']);
    store.clearTags();
    expect(store.selectedTags()).toEqual([]);
  });

  it('names the folder after the scope until the user edits it', async () => {
    const { store } = await mount();
    expect(store.folderName()).toBe('northwind-web-checkout-v2');
    store.toggleTag('release');
    expect(store.folderName()).toBe('northwind-web-checkout-v2-release');
    store.toggleTag('legacy');
    expect(store.folderName()).toBe('northwind-web-3-tags');
    store.setMode('all');
    expect(store.folderName()).toBe('northwind-web');
    store.setFolderName('mine');
    store.setMode('tags');
    store.toggleTag('legacy');
    expect(store.folderName()).toBe('mine');

    expect(defaultFolderName('p', null)).toBe('p');
    expect(defaultFolderName('p', { kind: 'all' })).toBe('p');
    expect(defaultFolderName('p', { kind: 'tags', tags: ['a'] })).toBe('p-a');
    expect(defaultFolderName('p', { kind: 'tags', tags: ['a', 'b'] })).toBe('p-a-b');
    expect(defaultFolderName('p', { kind: 'tags', tags: ['a', 'b', 'c', 'd'] })).toBe('p-4-tags');
  });

  it('counts keys: exact for one tag, an upper bound for several, unknown for all', async () => {
    expect(scopeLabel(null)).toBe('');
    expect(scopeLabel({ kind: 'all' })).toBe('all keys');
    expect(scopeLabel({ kind: 'tags', tags: ['a'] })).toBe('a');
    expect(scopeLabel({ kind: 'tags', tags: ['a', 'b'] })).toBe('2 tags');
    expect(keysText({ keys: null, exact: true })).toBe('—');
    expect(keysText({ keys: 1240, exact: true })).toBe('1,240');
    expect(keysText({ keys: 1240, exact: false })).toBe('up to 1,240');

    const { store } = await mount();
    vi.useFakeTimers();
    try {
      expect(store.keysText()).toBe('214');
      store.toggleTag('release');
      // From the tag list until the preview answers.
      expect(store.keysText()).toBe('up to 254');
      expect(store.railSummaries()[1]).toBe('2 tags · up to 254 keys');
      store.setMode('all');
      expect(store.keysText()).toBe('—');
      expect(store.previewLoading()).toBe(true);
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
      expect(store.keysText()).toBe('5,000');
      expect(store.footerSummary()).toBe('5,000 keys · en + 2 locales → 3 XLIFF files');
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces the preview and ignores an answer for an older scope', async () => {
    const { store, api } = await mount();
    expect(api.preview).toHaveBeenLastCalledWith(
      'nw',
      'web',
      { kind: 'tags', tags: ['checkout-v2'] },
      null,
    );
    api.preview.mockClear();
    vi.useFakeTimers();
    try {
      let answer!: (v: PhraseScopePreview) => void;
      api.preview.mockReturnValueOnce(new Promise((r) => (answer = r)));
      store.toggleTag('release');
      store.toggleTag('legacy');
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1);
      expect(api.preview).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.preview).toHaveBeenCalledOnce();
      expect(api.preview).toHaveBeenCalledWith(
        'nw',
        'web',
        { kind: 'tags', tags: ['checkout-v2', 'release', 'legacy'] },
        null,
      );

      // The user moves on before Phrase answers: the late answer is not shown.
      store.toggleTag('legacy');
      answer({
        scope: { kind: 'tags', tags: ['checkout-v2', 'release', 'legacy'] },
        keysCount: 266,
        exact: false,
        updatedAt: null,
        sample: [{ key: 'stale', text: 'Stale' }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.preview()).toBeNull();
      expect(store.previewLoading()).toBe(true);
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
      expect(store.preview()?.scope).toEqual({ kind: 'tags', tags: ['checkout-v2', 'release'] });
      expect(store.preview()?.sample).toEqual([]);

      // Nothing picked: no request, and no preview.
      api.preview.mockClear();
      store.clearTags();
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS);
      expect(api.preview).not.toHaveBeenCalled();
      expect(store.preview()).toBeNull();
      expect(store.previewLoading()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads the full key list on demand, once per scope, with the exact count', async () => {
    const { store, api } = await mount();
    expect(api.keys).not.toHaveBeenCalled();
    expect(store.allKeys()).toBeNull();
    expect(store.keysText()).toBe('214');

    store.showAllKeys();
    expect(store.allKeys()).toEqual({ status: 'loading' });
    // A second click while it loads asks nothing more.
    store.showAllKeys();
    await flush();
    expect(api.keys).toHaveBeenCalledOnce();
    expect(api.keys).toHaveBeenCalledWith(
      'nw',
      'web',
      { kind: 'tags', tags: ['checkout-v2'] },
      null,
    );
    const all = store.allKeys();
    expect(all?.status === 'loaded' && all.keys.length).toBe(450);
    expect(store.scopeCount()).toEqual({ keys: 450, exact: true });
    expect(store.keysText()).toBe('450');

    // Show fewer, then all again: from the cache.
    store.showFewerKeys();
    expect(store.allKeys()).toBeNull();
    store.showAllKeys();
    expect(store.allKeys()?.status).toBe('loaded');
    expect(api.keys).toHaveBeenCalledOnce();
  });

  it('collapses on a scope change and never shows an older scope’s late list', async () => {
    const { store, api } = await mount();
    let answer!: (v: PhraseScopeKeys) => void;
    api.keys.mockReturnValueOnce(new Promise((r) => (answer = r)));
    store.showAllKeys();
    store.toggleTag('release');
    expect(store.allKeys()).toBeNull();
    answer({ scope: { kind: 'tags', tags: ['checkout-v2'] }, keys: keyRows('stale', 3) });
    await flush();
    expect(store.allKeys()).toBeNull();
    expect(store.scopeCount().exact).toBe(false);

    // Back to the first scope: the late list was cached, and shows on request.
    store.toggleTag('release');
    expect(store.allKeys()).toBeNull();
    store.showAllKeys();
    const all = store.allKeys();
    expect(all?.status === 'loaded' && all.keys.map((k) => k.key)).toEqual([
      'stale.000',
      'stale.001',
      'stale.002',
    ]);
    expect(api.keys).toHaveBeenCalledOnce();

    // A new project collapses too.
    store.selectProject('admin');
    expect(store.allKeys()).toBeNull();
  });

  it('renders the list a page at a time', async () => {
    const { store } = await mount();
    store.showAllKeys();
    await flush();
    expect(store.shownKeys()).toHaveLength(KEYS_PAGE);
    expect(store.moreKeys()).toBe(KEYS_PAGE);
    store.showMoreKeys();
    expect(store.shownKeys()).toHaveLength(2 * KEYS_PAGE);
    expect(store.moreKeys()).toBe(50);
    store.showMoreKeys();
    expect(store.shownKeys()).toHaveLength(450);
    expect(store.moreKeys()).toBe(0);
    store.showMoreKeys();
    expect(store.shownKeys()).toHaveLength(450);

    // Opening again starts at one page.
    store.showFewerKeys();
    store.showAllKeys();
    expect(store.shownKeys()).toHaveLength(KEYS_PAGE);
  });

  it('filters the full list by key or base text before paging', async () => {
    const { store } = await mount();
    store.showAllKeys();
    await flush();
    store.showMoreKeys();
    // "1" in a key name or a text: 0–449 with a 1 in it.
    store.setKeyFilter(' TEXT 1');
    expect(store.filteredKeys().every((k) => k.text.startsWith('Text 1'))).toBe(true);
    expect(store.filteredKeys()).toHaveLength(111);
    expect(store.shownKeys()).toHaveLength(111);
    expect(store.moreKeys()).toBe(0);
    store.setKeyFilter('CHECKOUT-V2.04');
    expect(store.filteredKeys().map((k) => k.key)).toEqual(
      Array.from({ length: 10 }, (_, i) => `checkout-v2.04${i}`),
    );
    store.setKeyFilter('nothing like it');
    expect(store.filteredKeys()).toEqual([]);
    // The filter belongs to one opening of the list.
    store.showFewerKeys();
    store.showAllKeys();
    expect(store.keyFilter()).toBe('');
    expect(store.filteredKeys()).toHaveLength(450);
  });

  it('says why the list failed, and retries', async () => {
    const { store, api } = await mount();
    api.keys.mockRejectedValueOnce(
      Object.assign(new Error('502'), { error: { error: { message: 'Phrase is down.' } } }),
    );
    store.showAllKeys();
    await flush();
    expect(store.allKeys()).toEqual({ status: 'error', message: 'Phrase is down.' });
    store.showAllKeys();
    expect(store.allKeys()).toEqual({ status: 'loading' });
    await flush();
    expect(store.allKeys()?.status).toBe('loaded');
    expect(api.keys).toHaveBeenCalledTimes(2);
  });

  it('validates the folder name and the locale picks', async () => {
    expect(folderNameError('  ')).toBe('Enter a folder name.');
    expect(folderNameError('a/b')).toBe('A folder name can’t contain / or :');
    expect(folderNameError('a:b')).toBe('A folder name can’t contain / or :');
    expect(folderNameError('ok')).toBeNull();

    const { store } = await mount();
    await store.next();
    await store.next();
    expect(store.step()).toBe(3);
    store.selectNoLocales();
    expect(store.localesError()).toBe('Pick at least one target locale.');
    expect(store.canContinue()).toBe(false);
    store.selectAllLocales();
    store.setFolderName('');
    expect(store.canContinue()).toBe(false);
  });

  it('stays on step 3 when the server says the folder exists', async () => {
    const { store, api } = await mount();
    await store.next();
    await store.next();
    api.validate.mockResolvedValueOnce({
      error: 'This folder already exists. Choose another name.',
    });
    await store.next();
    expect(store.step()).toBe(3);
    expect(store.folderError()).toBe('This folder already exists. Choose another name.');
    store.setFolderName('other');
    expect(store.folderError()).toBeNull();
  });

  it('follows the progress rows, then lands on done with the result', async () => {
    const { store, api, frames, settings } = await mount();
    let resolve!: (v: unknown) => void;
    api.checkout.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    for (let i = 0; i < 3; i++) await store.next();
    expect(store.step()).toBe(4);

    const run = store.start();
    expect(store.phase()).toBe('running');
    expect(store.locked()).toBe(true);
    expect(api.checkout).toHaveBeenCalledWith({
      tokenId: 'nw',
      projectId: 'web',
      scope: { kind: 'tags', tags: ['checkout-v2'] },
      parentDir: '/Users/x/translations/phrase',
      folderName: 'northwind-web-checkout-v2',
      locales: ['de', 'ar'],
    });

    frames.set(new Map([frame('fetch-keys', 'waiting', 'Waiting for Phrase rate limit…')]));
    expect(store.runRows()[0]).toMatchObject({
      state: 'waiting',
      detail: 'Waiting for Phrase rate limit…',
    });
    expect(store.canCancel()).toBe(true);
    frames.set(new Map([frame('fetch-keys', 'done', '214 keys'), frame('write-base', 'running')]));
    expect(store.runRows()[0]).toMatchObject({ state: 'done', detail: '214 keys' });
    expect(store.runRows()[2]?.detail).toBe('source-language="en" · 214 units');
    expect(store.canCancel()).toBe(false);

    resolve({
      path: '/Users/x/translations/phrase/nw',
      files: ['messages.xlf', 'messages.de.xlf'],
      keys: 214,
    });
    await run;
    expect(store.phase()).toBe('done');
    expect(store.runRows().every((r) => r.state === 'done')).toBe(true);
    expect(settings.reload).toHaveBeenCalled();

    store.goTo(1);
    expect(store.step()).toBe(4);
    store.restart();
    expect(store.step()).toBe(1);
    expect(store.phase()).toBe('idle');
    expect(store.selectedTags()).toEqual(['checkout-v2']);
  });

  it('sends every picked tag, or all keys, as the scope', async () => {
    const { store, api } = await mount();
    store.toggleTag('legacy');
    store.toggleTag('release');
    for (let i = 0; i < 3; i++) await store.next();
    api.checkout.mockResolvedValueOnce({ path: '/p', files: [], keys: 250 });
    await store.start();
    expect(api.checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: { kind: 'tags', tags: ['checkout-v2', 'release', 'legacy'] },
        folderName: 'northwind-web-3-tags',
      }),
    );

    store.restart();
    await flush();
    store.setMode('all');
    for (let i = 0; i < 3; i++) await store.next();
    expect(store.runRows()[0]?.label).toBe('Fetch all keys');
    api.checkout.mockResolvedValueOnce({ path: '/p', files: [], keys: 5000 });
    await store.start();
    expect(api.checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: { kind: 'all' }, folderName: 'northwind-web' }),
    );
  });

  it('marks the failing row and offers a way back', async () => {
    const { store, api, frames } = await mount();
    for (let i = 0; i < 3; i++) await store.next();
    api.checkout.mockImplementationOnce(() => {
      frames.set(new Map([frame('fetch-keys', 'done', '214 keys')]));
      return Promise.reject(
        Object.assign(new Error('502'), { error: { error: { message: 'Phrase answered 502.' } } }),
      );
    });
    await store.start();
    expect(store.phase()).toBe('failed');
    expect(store.runError()).toBe('Phrase answered 502.');
    expect(store.failedRow()).toBe('fetch-base');
    store.back();
    expect(store.step()).toBe(3);
    expect(store.phase()).toBe('idle');
  });

  it('goes back to idle, not failed, when a cancel ends the run', async () => {
    const { store, api } = await mount();
    for (let i = 0; i < 3; i++) await store.next();
    let reject!: (e: unknown) => void;
    api.checkout.mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    const run = store.start();
    await store.cancel();
    expect(api.cancel).toHaveBeenCalledOnce();
    reject(
      Object.assign(new Error('409'), { error: { error: { message: 'Checkout cancelled.' } } }),
    );
    await run;
    expect(store.phase()).toBe('idle');
    expect(store.runError()).toBeNull();
  });
});

describe('PhraseCheckoutStore branches', () => {
  it('lists the open branches of the picked project, none for one without', async () => {
    const { store } = await mount();
    expect(store.branches().map((b) => b.name)).toEqual(['feature/x', 'release-2']);
    expect(store.branch()).toBeNull();
    store.selectProject('admin');
    await flush();
    expect(store.branches()).toEqual([]);
  });

  it('reads tags, details and previews from the picked branch and starts over', async () => {
    const { store, api } = await mount();
    store.setFolderName('custom');
    store.toggleLocale('de');

    store.selectBranch('release-2');
    await flush();
    expect(store.branch()).toBe('release-2');
    expect(api.project).toHaveBeenLastCalledWith('nw', 'web', 'release-2');
    expect(api.tags).toHaveBeenLastCalledWith('nw', 'web', 'release-2');
    expect(store.tags()?.map((t) => t.name)).toEqual(['rc', 'docs']);
    // Back to the defaults: the branch's first tag, automatic folder, every locale.
    expect(store.selectedTags()).toEqual(['rc']);
    expect(store.folderEdited()).toBe(false);
    expect(store.folderName()).toBe('northwind-web-release-2-rc');
    expect(store.selectedLocales()).toEqual(['de', 'ar']);
    expect(api.preview).toHaveBeenLastCalledWith(
      'nw',
      'web',
      { kind: 'tags', tags: ['rc'] },
      'release-2',
    );
    expect(store.railSummaries()[1]).toContain('release-2');
  });

  it('keeps each branch’s answers apart and asks nothing when going back', async () => {
    const { store, api } = await mount();
    store.selectBranch('release-2');
    await flush();
    store.selectBranch(null);
    await flush();
    expect(store.tags()?.map((t) => t.name)).toEqual(['checkout-v2', 'release', 'legacy', 'release-notes']);
    // Main project and the branch were each read once.
    expect(api.tags).toHaveBeenCalledTimes(2);
    expect(api.branches).toHaveBeenCalledOnce();
  });

  it('turns characters a folder cannot hold into dashes', async () => {
    const { store } = await mount();
    store.selectBranch('feature/x');
    await flush();
    expect(store.mode()).toBe('all');
    expect(store.folderName()).toBe('northwind-web-feature-x');
    expect(store.folderError()).toBeNull();
    expect(defaultFolderName('p', { kind: 'tags', tags: ['a'] }, 'a/b:c')).toBe('p-a-b-c-a');
  });

  it('ignores a branch the project does not have', async () => {
    const { store } = await mount();
    store.selectBranch('nope');
    expect(store.branch()).toBeNull();
  });

  it('forgets the branch when the project changes, and sends it with the checkout', async () => {
    const { store, api } = await mount();
    store.selectBranch('release-2');
    await flush();
    api.checkout.mockResolvedValueOnce({ path: '/p', files: [], keys: 3 });
    for (let i = 0; i < 3; i++) await store.next();
    await store.start();
    expect(api.checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({ branch: 'release-2', scope: { kind: 'tags', tags: ['rc'] } }),
    );
    expect(store.runRows()[0]?.label).toBe('Fetch keys tagged rc on branch release-2');

    store.restart();
    await flush();
    store.selectProject('admin');
    await flush();
    expect(store.branch()).toBeNull();
  });

  it('sends no branch for the main project', async () => {
    const { store, api } = await mount();
    api.checkout.mockResolvedValueOnce({ path: '/p', files: [], keys: 3 });
    for (let i = 0; i < 3; i++) await store.next();
    await store.start();
    expect(api.checkout.mock.lastCall?.[0]).not.toHaveProperty('branch');
  });

  it('still checks out the main project when the branches cannot be listed', async () => {
    const { store, api } = await mount([token()]);
    expect(store.branches().length).toBe(2);
    api.branches.mockRejectedValue(new Error('boom'));
    store.selectProject('admin');
    await flush();
    expect(store.branches()).toEqual([]);
    expect(store.selectedTags()).toEqual(['roles']);
  });
});
