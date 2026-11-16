// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  MarkdownPreviewResponse,
  MdBlock,
  MdSpan,
  MdTableAlign,
  StyleGuide,
  StyleGuideListResponse,
} from '@lexi/shared';

import { StyleguidesStore } from '../../core/stores/styleguides-store.js';
import { StyleguidesPage } from './styleguides-page.js';

/**
 * S6 renders two things nothing else in the app produces: a rendered Markdown
 * block tree that never touches `[innerHTML]`, and a live token pill kept in
 * sync with the editor's buffer. What is asserted here is that those stay
 * true — geometry and colour are the kitchen sink's job, not a test's. The
 * glossary that used to be S6's third pane is the Term Base screen now.
 */

const guide = (key: string, over: Partial<StyleGuide> = {}): StyleGuide => ({
  key,
  name: key === 'global' ? 'global.md' : `${key}.md`,
  locale: key === 'global' ? null : key,
  tokens: 12,
  bytes: 48,
  text: '# Guide\n\nSome text.',
  exists: true,
  ...over,
});

const listing = (over: Partial<StyleGuideListResponse> = {}): StyleGuideListResponse => ({
  guides: [
    { key: 'global', name: 'global.md', locale: null, tokens: 12, bytes: 48 },
    { key: 'de', name: 'de.md', locale: 'de', tokens: 30, bytes: 120 },
  ],
  missing: ['fr'],
  dir: '.lexi/styleguides',
  linked: false,
  available: true,
  ...over,
});

const preview = (blocks: readonly MdBlock[] = []): MarkdownPreviewResponse => ({
  blocks: [...blocks],
  tokens: 0,
});

const heading = (text: string, level = 1): MdBlock => ({
  kind: 'heading',
  level,
  ordered: false,
  lang: '',
  lines: [[{ text, style: 'plain', href: null }]],
  cells: [],
  align: [],
});

const list = (items: readonly string[], ordered = false): MdBlock => ({
  kind: 'list',
  level: 0,
  ordered,
  lang: '',
  lines: items.map((item) => [{ text: item, style: 'plain', href: null }]),
  cells: [],
  align: [],
});

const codeBlock = (text: string): MdBlock => ({
  kind: 'code',
  level: 0,
  ordered: false,
  lang: '',
  lines: [[{ text, style: 'plain', href: null }]],
  cells: [],
  align: [],
});

const cell = (text: string): MdSpan[] => [{ text, style: 'plain', href: null }];

const table = (
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  align: readonly MdTableAlign[] = [],
): MdBlock => ({
  kind: 'table',
  level: 0,
  ordered: false,
  lang: '',
  lines: [],
  cells: [header.map(cell), ...rows.map((row) => row.map(cell))],
  align: align.length > 0 ? [...align] : header.map(() => 'none'),
});

const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/**
 * A macrotask, which drains every microtask behind it — including a promise
 * chain that is more than one hop deep, which `fixture.whenStable()` cannot be
 * relied on for here: `store.load()` runs unawaited from the constructor, so
 * nothing marks it as a pending task between its two sequential requests (the
 * listing, then the active guide), and `whenStable()` can resolve in the gap
 * between them. Same idiom `settings-page.spec.ts` uses for the same reason.
 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let http: HttpTestingController;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  http.verify();
});

/**
 * Flushes the requests the page fires on construction: the guide
 * listing, the active guide (`global` unless overridden), and
 * every live preview render the httpResource fires along the way — there can
 * be more than one, since the store's `#debounced` signal already holds a
 * value the moment the resource is created.
 */
const mount = async (
  opts: {
    listing?: StyleGuideListResponse;
    active?: StyleGuide;
    preview?: MarkdownPreviewResponse;
  } = {},
) => {
  const fixture = TestBed.createComponent(StyleguidesPage);
  fixture.detectChanges();

  http.expectOne('/api/styleguides').flush(opts.listing ?? listing());
  await settled();
  fixture.detectChanges();

  http.expectOne('/api/styleguides/global').flush(opts.active ?? guide('global'));
  await settled();
  fixture.detectChanges();

  for (const req of http.match('/api/markdown/preview')) {
    req.flush(opts.preview ?? preview());
  }
  await settled();
  fixture.detectChanges();

  return fixture;
};

describe('StyleguidesPage', () => {
  it('lists Global first, the written guides, and the token pill for the active one', async () => {
    const el = (await mount()).nativeElement as HTMLElement;

    const tabs = [...el.querySelectorAll('.tab')].map((t) => text(t));
    expect(tabs).toEqual(['Global', 'de']);
    expect(el.querySelector('.tab--active')?.classList).toContain('tab--global');
    // The pill tracks the LIVE local estimate of the buffer, not the server's
    // last-fetched figure — that is the whole point of it being instant.
    expect(text(el.querySelector('.pill'))).toMatch(/\d+ tokens/);
    expect(text(el.querySelector('.pill'))).toContain('fits');
  });

  it('offers a missing locale through the dashed affordance, and opens it', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;

    (el.querySelector('.add') as HTMLButtonElement).click();
    fixture.detectChanges();
    const item = [...el.querySelectorAll('.menuitem')].find((b) => text(b) === 'fr');
    expect(item).toBeDefined();

    (item as HTMLButtonElement).click();
    fixture.detectChanges();

    http
      .expectOne('/api/styleguides/fr')
      .flush(guide('fr', { locale: 'fr', exists: false, text: '' }));
    await settled();
    fixture.detectChanges();
    for (const req of http.match('/api/markdown/preview')) req.flush(preview());
    await settled();
    fixture.detectChanges();

    // A guide that has never been written offers the starter template rather
    // than an empty editor with no way out.
    expect(text(el.querySelector('.actions'))).toContain('Use starter template');
  });

  it('marks the buffer dirty on a keystroke and enables Save', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const textarea = el.querySelector('.input') as HTMLTextAreaElement;

    expect(el.querySelector('button[disabled]')?.textContent).toBeDefined();

    textarea.value = '# Guide\n\nEdited.';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const save = [...el.querySelectorAll('button')].find((b) => text(b) === 'Save');
    expect(save?.hasAttribute('disabled')).toBe(false);

    // The debounced live-preview request follows 150ms later; draining it here
    // keeps `http.verify()` honest about what the edit actually triggered.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const req of http.match('/api/markdown/preview')) req.flush(preview());
  });

  it('renders the block tree without ever touching innerHTML', async () => {
    const el = (
      await mount({
        preview: preview([
          heading('Global style guide', 1),
          list(['Sie form'], false),
          codeBlock('const x = 1;'),
        ]),
      })
    ).nativeElement as HTMLElement;

    expect(el.querySelector('.heading[data-level="1"]')?.textContent).toContain(
      'Global style guide',
    );
    expect(el.querySelector('.list li')?.textContent).toContain('Sie form');
    expect(el.querySelector('.code')?.textContent).toContain('const x = 1;');
    // The whole point of the typed block tree (FR-5.4's design note): nothing
    // in the rendered pane is bound through innerHTML.
    expect(el.querySelector('[innerHTML]')).toBeNull();
  });

  it('renders a table, header row and column alignment included', async () => {
    const el = (
      await mount({
        preview: preview([
          table(
            ['Source term', 'de', 'Do not translate'],
            [
              ['dashboard', 'Übersicht', 'no'],
              ['Workspace', 'Workspace', 'yes'],
            ],
            ['left', 'left', 'center'],
          ),
        ]),
      })
    ).nativeElement as HTMLElement;

    const headerCells = [...el.querySelectorAll('.table thead th')];
    expect(headerCells.map((c) => text(c))).toEqual(['Source term', 'de', 'Do not translate']);
    expect(headerCells[2]?.getAttribute('data-align')).toBe('center');

    const rows = [...el.querySelectorAll('.table tbody tr')];
    expect(rows).toHaveLength(2);
    expect(text(rows[0] ?? null)).toContain('dashboard');
    expect(text(rows[0] ?? null)).toContain('Übersicht');
    expect(text(rows[1] ?? null)).toContain('Workspace');
  });

  it('marks a linked folder as shared and prints its absolute path', async () => {
    const el = (
      await mount({
        listing: listing({ dir: '/Users/me/lexi-shared/styleguides', linked: true }),
      })
    ).nativeElement as HTMLElement;

    expect(text(el.querySelector('.path'))).toBe('/Users/me/lexi-shared/styleguides/global.md');
    expect(text(el.querySelector('lx-badge'))).toBe('Shared');
    expect([...el.querySelectorAll('button')].some((b) => text(b) === 'Unlink')).toBe(true);
  });

  it('does not reload over an unsaved edit when the shared folder changes', async () => {
    const fixture = await mount({ listing: listing({ linked: true }) });
    const el = fixture.nativeElement as HTMLElement;
    const store = TestBed.inject(StyleguidesStore);

    store.edit('# Mine');
    const change = store.onDiskChange();
    http.expectOne('/api/styleguides').flush(listing({ linked: true }));
    await change;
    fixture.detectChanges();

    // The guide itself was not re-fetched; the page asks instead.
    http.expectNone('/api/styleguides/global');
    expect(store.buffer()).toBe('# Mine');
    expect(text(el.querySelector('.stale'))).toContain('changed in the shared folder');

    [...el.querySelectorAll<HTMLButtonElement>('.stale button')][0]!.click();
    http.expectOne('/api/styleguides/global').flush(guide('global', { text: '# Theirs' }));
    await settled();
    fixture.detectChanges();
    expect(store.buffer()).toBe('# Theirs');
    expect(el.querySelector('.stale')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const req of http.match('/api/markdown/preview')) req.flush(preview());
  });
});
