// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type {
  PhraseCheckoutScope,
  PhraseScopeKeys,
  PhraseScopePreview,
  PhraseToken,
} from '@lexi/shared';

import { PhraseCheckoutApi } from '../../core/api/phrase-checkout-api.js';
import { PhraseTokensApi } from '../../core/api/phrase-tokens-api.js';
import { ProjectApi } from '../../core/api/project-api.js';
import { EventsStore } from '../../core/stores/events-store.js';
import {
  PREVIEW_DEBOUNCE_MS,
  PhraseCheckoutStore,
} from '../../core/stores/phrase-checkout-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { LxStepTag } from './step-tag.js';

/**
 * S18 step 2: all keys or tags, tags as checkboxes, a filter that never
 * unpicks, and the preview's full key list on request.
 */

const TOKEN: PhraseToken = {
  id: 'nw',
  note: 'Northwind',
  region: 'EU',
  suffix: '9f3a',
  user: 'anna',
  org: 'Northwind GmbH',
  scopes: '',
  projects: [{ id: 'web', name: 'northwind-web', account: null }],
  status: 'ok',
  checkedAt: null,
};

/** 450 keys `key.000` … with text `Text {i}`. */
const KEYS = Array.from({ length: 450 }, (_, i) => ({
  key: `key.${String(i).padStart(3, '0')}`,
  text: `Text ${i}`,
}));

const TAGS = [
  { name: 'checkout-v2', keysCount: 214, updatedAt: null },
  { name: 'release', keysCount: 40, updatedAt: null },
  { name: 'legacy', keysCount: 12, updatedAt: null },
];

async function mount(branches: Array<{ name: string; updatedAt: string | null }> = []) {
  const api = {
    branches: vi.fn().mockResolvedValue({ branches }),
    project: vi.fn().mockResolvedValue({
      id: 'web',
      name: 'northwind-web',
      baseLocale: 'en',
      locales: [{ id: 'l-en', code: 'en', name: 'English', isDefault: true }],
    }),
    tags: vi.fn((_t: string, _p: string, branch: string | null = null) =>
      Promise.resolve({
        tags: branch === null ? TAGS : [{ name: 'rc', keysCount: 3, updatedAt: null }],
      }),
    ),
    preview: vi.fn(
      (_t: string, _p: string, scope: PhraseCheckoutScope): Promise<PhraseScopePreview> =>
        Promise.resolve({
          scope,
          keysCount: scope.kind === 'all' ? null : 214,
          exact: scope.kind === 'all' || scope.tags.length === 1,
          updatedAt: null,
          sample: [{ key: 'checkout.title', text: 'Checkout' }],
        }),
    ),
    keys: vi.fn((_t: string, _p: string, scope: PhraseCheckoutScope): Promise<PhraseScopeKeys> =>
      Promise.resolve({ scope, keys: KEYS }),
    ),
    validate: vi.fn(),
    checkout: vi.fn(),
    cancel: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: PhraseTokensApi,
        useValue: { list: vi.fn().mockResolvedValue({ tokens: [TOKEN] }) },
      },
      { provide: PhraseCheckoutApi, useValue: api },
      { provide: ProjectApi, useValue: { roots: vi.fn().mockResolvedValue({ roots: [] }) } },
      {
        provide: EventsStore,
        useValue: { phraseCheckout: signal(new Map()), clearPhraseCheckout: vi.fn() },
      },
      {
        provide: SettingsStore,
        useValue: {
          load: vi.fn().mockResolvedValue(null),
          reload: vi.fn(),
          settings: signal({ launch: { showMenu: true, lastParentDir: null } }),
        },
      },
    ],
  });
  const store = TestBed.inject(PhraseCheckoutStore);
  await store.load();
  await new Promise((resolve) => setTimeout(resolve));
  const fixture = TestBed.createComponent(LxStepTag);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rows = () => [...el.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
  const checked = () =>
    rows()
      .filter((r) => r.getAttribute('aria-checked') === 'true')
      .map((r) => r.querySelector('.row__name')?.textContent?.trim());
  const link = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.link')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const segment = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('lx-segmented-control button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const button = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    );
  const keyRows = () =>
    [...el.querySelectorAll('.prev__row .prev__key')].map((k) => k.textContent?.trim());
  /** Lets pending promises (and, with `ms`, the preview debounce) run, then renders. */
  const settle = async (ms = 0) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    fixture.detectChanges();
  };
  return { fixture, el, store, api, rows, checked, link, segment, button, keyRows, settle };
}

describe('LxStepTag (S18 step 2)', () => {
  it('picks tags with checkboxes and shows the count of picks', async () => {
    const { fixture, el, store, rows, checked } = await mount();
    expect(rows().map((r) => r.querySelector('.row__name')?.textContent?.trim())).toEqual([
      'checkout-v2',
      'release',
      'legacy',
    ]);
    expect(checked()).toEqual(['checkout-v2']);
    expect(el.querySelector('.prev__title')?.textContent?.trim()).toBe('checkout-v2');
    expect(el.querySelector('.prev__meta')?.textContent).toContain('214 keys');

    rows()[2]!.click();
    fixture.detectChanges();
    expect(checked()).toEqual(['checkout-v2', 'legacy']);
    expect(store.selectedTags()).toEqual(['checkout-v2', 'legacy']);
    expect(el.querySelector('.selected')?.textContent?.trim()).toBe('2 selected');
    expect(el.querySelector('.prev__title')?.textContent?.trim()).toBe('2 tags');
    expect(el.querySelector('.prev__title')?.getAttribute('title')).toBe('checkout-v2, legacy');
    expect(el.querySelector('.prev__meta')?.textContent).toContain('up to 226 keys');

    rows()[0]!.click();
    rows()[2]!.click();
    fixture.detectChanges();
    expect(checked()).toEqual([]);
    expect(el.querySelector('.prev__more')?.textContent?.trim()).toBe(
      'Pick at least one tag to see its first keys.',
    );
  });

  it('keeps the picks while filtering, and Select all shown adds only what is shown', async () => {
    const { fixture, el, store, rows, checked, link } = await mount();
    const filter = el.querySelector<HTMLInputElement>('.filter')!;
    filter.value = 'le';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows().map((r) => r.querySelector('.row__name')?.textContent?.trim())).toEqual([
      'release',
      'legacy',
    ]);
    expect(store.selectedTags()).toEqual(['checkout-v2']);

    link('Select all shown').click();
    fixture.detectChanges();
    expect(checked()).toEqual(['release', 'legacy']);
    expect(store.selectedTags()).toEqual(['checkout-v2', 'release', 'legacy']);

    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(checked()).toEqual(['checkout-v2', 'release', 'legacy']);

    link('None').click();
    fixture.detectChanges();
    expect(checked()).toEqual([]);
  });

  it('names the Show all button after the count only when it is exact', async () => {
    const { el, rows, segment, button, settle } = await mount();
    expect(button('Show all 214 keys')).toBeDefined();
    expect(el.querySelector('.prev__more')).toBeNull();

    rows()[2]!.click();
    await settle(PREVIEW_DEBOUNCE_MS + 10);
    // The (mocked) preview's upper bound for two tags.
    expect(el.querySelector('.prev__meta')?.textContent).toContain('up to 214 keys');
    expect(button('Show all keys')).toBeDefined();

    segment('All keys').click();
    await settle(PREVIEW_DEBOUNCE_MS + 10);
    expect(button('Show all keys')).toBeDefined();
  });

  it('shows every key a page at a time, with the exact count, and back to the sample', async () => {
    const { el, api, button, keyRows, link, settle } = await mount();
    let answer!: (v: PhraseScopeKeys) => void;
    api.keys.mockReturnValueOnce(new Promise((r) => (answer = r)));
    button('Show all 214 keys')!.click();
    await settle();
    expect(el.querySelectorAll('.prev__row .skeleton').length).toBeGreaterThan(0);
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('Loading keys…');
    expect(el.querySelectorAll('.filter')).toHaveLength(1);

    answer({ scope: { kind: 'tags', tags: ['checkout-v2'] }, keys: KEYS });
    await settle();
    expect(el.querySelector('.prev__meta')?.textContent?.trim()).toMatch(/^450 keys/);
    expect(keyRows()).toHaveLength(200);
    expect(keyRows()[0]).toBe('key.000');
    expect(el.querySelector('.prev__shown')?.textContent?.trim()).toBe('200 of 450');

    button('Show 200 more')!.click();
    await settle();
    expect(keyRows()).toHaveLength(400);
    button('Show 50 more')!.click();
    await settle();
    expect(keyRows()).toHaveLength(450);
    expect(
      [...el.querySelectorAll('button')].some((b) => /^Show \d+ more$/.test(b.textContent!.trim())),
    ).toBe(false);

    link('Show fewer').click();
    await settle();
    expect(keyRows()).toEqual(['checkout.title']);
    expect(button('Show all 450 keys')).toBeDefined();
    expect(el.querySelectorAll('.filter')).toHaveLength(1);
  });

  it('filters the full list by key or base text', async () => {
    const { el, button, keyRows, settle } = await mount();
    button('Show all 214 keys')!.click();
    await settle();
    const filters = el.querySelectorAll<HTMLInputElement>('.filter');
    expect(filters).toHaveLength(2);
    const keyFilter = filters[1]!;
    expect(keyFilter.getAttribute('aria-label')).toBe('Filter keys');

    keyFilter.value = 'KEY.04';
    keyFilter.dispatchEvent(new Event('input'));
    await settle();
    expect(keyRows()).toEqual(Array.from({ length: 10 }, (_, i) => `key.04${i}`));
    expect(el.querySelector('.prev__shown')?.textContent?.trim()).toBe('10 of 10');

    keyFilter.value = 'text 449';
    keyFilter.dispatchEvent(new Event('input'));
    await settle();
    expect(keyRows()).toEqual(['key.449']);

    keyFilter.value = 'zzz';
    keyFilter.dispatchEvent(new Event('input'));
    await settle();
    expect(keyRows()).toEqual([]);
    expect(el.querySelector('.prev__more')?.textContent?.trim()).toBe(
      'No key matches this filter.',
    );
  });

  it('says why the full list failed, and retries', async () => {
    const { el, api, button, keyRows, link, settle } = await mount();
    api.keys.mockRejectedValueOnce(
      Object.assign(new Error('502'), { error: { error: { message: 'Phrase is down.' } } }),
    );
    button('Show all 214 keys')!.click();
    await settle();
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Phrase is down.');
    expect(el.querySelectorAll('.filter')).toHaveLength(1);

    link('Retry').click();
    await settle();
    expect(api.keys).toHaveBeenCalledTimes(2);
    expect(keyRows()).toHaveLength(200);
  });

  it('replaces the tag table with a note in All keys', async () => {
    const { fixture, el, store, segment } = await mount();
    segment('All keys').click();
    fixture.detectChanges();
    expect(store.mode()).toBe('all');
    expect(el.querySelector('.table')).toBeNull();
    expect(el.querySelector('.filter')).toBeNull();
    expect(el.querySelector('.all__text')?.textContent?.trim()).toBe(
      'Every key of northwind-web is checked out.',
    );
    // Unknown until the preview answers, and the preview here does not know either.
    expect(el.querySelector('.all__count')?.textContent?.trim()).toBe('—');
    expect(el.querySelector('.prev__title')?.textContent?.trim()).toBe('all keys');

    segment('By tag').click();
    fixture.detectChanges();
    expect(el.querySelector('.table')).not.toBeNull();
    expect(store.selectedTags()).toEqual(['checkout-v2']);
  });
  it('offers no branch picker for a project without branches', async () => {
    const { el } = await mount();
    expect(el.querySelector('select[aria-label="Phrase branch"]')).toBeNull();
  });

  it('picks the branch first, then lists that branch’s tags', async () => {
    const { fixture, el, store, api, checked, settle } = await mount([
      { name: 'release-2', updatedAt: null },
    ]);
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Phrase branch"]')!;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Main project (no branch)',
      'release-2',
    ]);
    expect(select.value).toBe('');

    select.value = 'release-2';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(store.branch()).toBe('release-2');
    expect(api.tags).toHaveBeenLastCalledWith('nw', 'web', 'release-2');
    expect(checked()).toEqual(['rc']);
    expect(select.value).toBe('release-2');

    select.value = '';
    select.dispatchEvent(new Event('change'));
    await settle();
    fixture.detectChanges();
    expect(store.branch()).toBeNull();
    expect(checked()).toEqual(['checkout-v2']);
  });
});
