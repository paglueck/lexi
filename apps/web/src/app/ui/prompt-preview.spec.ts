// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptPreviewResponse, TranslateUnitResponse, UnitTarget } from '@lexi/shared';

import { DraftStore } from '../core/stores/draft-store.js';
import { TranslateStore } from '../core/stores/translate-store.js';
import { LxPromptPreview } from './prompt-preview.js';

/**
 * S5's one job is to be EVIDENCE: what it shows has to be the text the request
 * carries (FR-5.7). So what is asserted here is not how the modal looks but
 * that it never composes anything of its own — it renders the server's blocks
 * verbatim, in the order they arrived, and the run it fires asks for the same
 * placeholder style it is displaying.
 *
 * The rest — colour, geometry, the 900 px width — is the designer's review at
 * `/dev/kitchen-sink`, not a test's.
 */

const block = (
  id: string,
  over: Partial<PromptPreviewResponse['blocks'][number]> = {},
): PromptPreviewResponse['blocks'][number] => ({
  id,
  kind: 'role',
  role: 'system',
  title: id,
  caption: '',
  content: `content of ${id}`,
  tokens: 10,
  source: null,
  empty: false,
  ...over,
});

const preview = (over: Partial<PromptPreviewResponse> = {}): PromptPreviewResponse => ({
  rowId: 'messagesinvoices',
  unitId: 'invoices',
  locale: 'de',
  sourceLocale: 'en-GB',
  placeholderStyle: 'masked',
  blocks: [
    block('role'),
    block('invariants', { kind: 'invariants' }),
    block('styleguide.global', { kind: 'styleguide', content: '', empty: true, tokens: 0 }),
    block('styleguide.de', { kind: 'styleguide', source: 'de.md', content: '## de\nSiezen.' }),
    block('terminology', { kind: 'terminology', content: '', empty: true, tokens: 0 }),
    block('user', {
      kind: 'user',
      role: 'user',
      title: 'User message · masked tokens',
      content: 'Unit id: invoices\n\nSource (en-GB):\nYou have [[0]] invoices',
      tokens: 40,
    }),
  ],
  totals: { tokens: 70, system: 30, user: 40, contextWindow: 8192, estimated: true },
  schema: '{"translation": string}',
  placeholders: [{ token: '[[0]]', label: '{{ count }}', id: 'INTERPOLATION' }],
  terminology: { matched: [], total: 0 },
  model: 'qwen2.5:14b',
  params: {
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 512,
    contextWindow: 8192,
    requestTimeoutSeconds: 120,
    seed: 7,
    concurrency: 2,
    reasoningEffort: 'none',
    unitsPerRequest: 1,
  },
  blocked: '',
  ...over,
});

const target: UnitTarget = {
  locale: 'de',
  isRtl: false,
  state: 'draftMachine',
  missing: false,
  noFile: false,
  newFile: null,
  segments: [{ k: 't', v: 'Sie haben [[0]] Rechnungen' }],
  findings: [],
  missingPlaceholders: [],
  charCount: 26,
  previous: null,
  origin: null,
  reviewReasons: [],
};

const ROW = 'messagesinvoices';

let closed: unknown;
let http: HttpTestingController;

beforeEach(() => {
  closed = undefined;
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: DIALOG_DATA, useValue: { rowId: ROW, locale: 'de' } },
      {
        provide: DialogRef,
        useValue: { close: (value: unknown) => (closed = value) } as Partial<DialogRef>,
      },
    ],
  });
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  http.verify();
});

/**
 * Mount, answer the preview request, and settle.
 *
 * Async because the component reads its preview through a promise: `flush`
 * delivers the response synchronously, but the `await` inside `load()` resolves
 * a microtask later, so a `detectChanges` without `whenStable` renders the
 * still-empty "Composing…" state and every assertion below it is about nothing.
 */
const mount = async (body: PromptPreviewResponse = preview()) => {
  const fixture = TestBed.createComponent(LxPromptPreview);
  fixture.detectChanges();
  http.expectOne('/api/prompt/preview').flush(body);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
};

const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('LxPromptPreview', () => {
  it('renders the server blocks in the order they arrived, and composes nothing', async () => {
    const el = (await mount()).nativeElement as HTMLElement;
    const captions = [...el.querySelectorAll('.block .lx-caption')].map((c) => text(c));

    // The system half, in prompt order, terminology excluded because it has its
    // own table below.
    expect(captions).toEqual([
      'role',
      'invariants',
      'styleguide.global',
      'styleguide.de',
      'Terminology',
    ]);
  });

  it('shows each block verbatim — a preview that reflowed the text is not evidence', async () => {
    const el = (await mount()).nativeElement as HTMLElement;
    const bodies = [...el.querySelectorAll('.block pre')].map((p) => p.textContent);
    expect(bodies).toContain('## de\nSiezen.');
  });

  it('keeps an empty style guide visible and says why it is empty', async () => {
    const fixture = await mount(
      preview({
        blocks: preview().blocks.map((b) =>
          b.id === 'styleguide.global'
            ? { ...b, caption: 'No global style guide yet.', empty: true }
            : b,
        ),
      }),
    );
    const el = fixture.nativeElement as HTMLElement;

    const empty = el.querySelector('.block[data-empty="true"]');
    expect(empty).not.toBeNull();
    expect(text(empty)).toContain('No global style guide yet.');
  });

  it('switches to the user message, which is where the masked source lives', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;

    const user = [...el.querySelectorAll('lx-segmented-control button')].find(
      (b) => text(b) === 'User',
    ) as HTMLButtonElement;
    user.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.block pre'))).toContain('You have [[0]] invoices');
    expect(text(el)).toContain('restored after generation');
  });

  it('reports the token estimate as an estimate, against the configured window', async () => {
    const el = (await mount()).nativeElement as HTMLElement;
    const meter = text(el.querySelector('.meter'));
    expect(meter).toContain('Estimated 70 tokens');
    expect(meter).toContain('context window 8,192');
  });

  it('warns when the prompt would not fit, because the model will not say so', async () => {
    const el = (
      await mount(
        preview({
          totals: { tokens: 9000, system: 8000, user: 1000, contextWindow: 8192, estimated: true },
        }),
      )
    ).nativeElement as HTMLElement;
    expect(text(el.querySelector('.warnline'))).toContain('more than the context window');
  });

  /**
   * The masked/raw switch is a product decision, not a debug toggle
   * (requirements Appendix A): it has to re-ask the SERVER, because the two prompts differ in
   * more than the source line — the invariants block changes too.
   */
  it('re-composes on the server when the placeholder style changes', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;

    const raw = [...el.querySelectorAll('lx-segmented-control button')].find((b) =>
      text(b).includes('raw'),
    ) as HTMLButtonElement;
    raw.click();
    fixture.detectChanges();

    const request = http.expectOne('/api/prompt/preview');
    expect(request.request.body).toMatchObject({
      rowId: ROW,
      locale: 'de',
      placeholderStyle: 'raw',
    });
    request.flush(preview({ placeholderStyle: 'raw' }));
    await fixture.whenStable();
    fixture.detectChanges();

    // The badge lives on the user block, which is where the difference between
    // the two prompts is visible at all.
    (
      [...el.querySelectorAll('lx-segmented-control button')].find(
        (b) => text(b) === 'User',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(text(el)).toContain('higher breakage risk');
  });

  it('runs with the style it is showing, and closes only on an accepted draft', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;

    const run = [...el.querySelectorAll('button')].find((b) =>
      text(b).startsWith('Run for this unit'),
    ) as HTMLButtonElement;
    run.click();

    const request = http.expectOne('/api/translate/unit');
    expect(request.request.body).toMatchObject({ rowId: ROW, locale: 'de' });
    request.flush({
      ok: true,
      rowId: ROW,
      locale: 'de',
      target,
      unsavedCount: 1,
      run: {
        at: new Date().toISOString(),
        model: 'qwen2.5:14b',
        placeholderStyle: 'masked',
        latencyMs: 900,
        promptTokens: 210,
        completionTokens: 12,
        parse: 'json',
        confidence: 'high',
        notesForReviewer: null,
        raw: '{}',
      },
      rejection: null,
      findings: [],
    } satisfies TranslateUnitResponse);
    await fixture.whenStable();

    expect(closed).toBe(true);
    // An accepted draft is an ordinary pending edit from here on.
    expect(TestBed.inject(DraftStore).draftFor(ROW, 'de')?.target.state).toBe('draftMachine');
    // The refresh the draft store fires for the grid row.
    http.match((r) => r.url === '/api/units/rows').forEach((r) => r.flush({ rows: [] }));
  });

  it('stays open on a rejected draft, because the reason is the whole point', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;

    (
      [...el.querySelectorAll('button')].find((b) =>
        text(b).startsWith('Run for this unit'),
      ) as HTMLButtonElement
    ).click();

    http.expectOne('/api/translate/unit').flush({
      ok: false,
      rowId: ROW,
      locale: 'de',
      target: null,
      unsavedCount: 0,
      run: {
        at: new Date().toISOString(),
        model: 'qwen2.5:14b',
        placeholderStyle: 'masked',
        latencyMs: 700,
        promptTokens: null,
        completionTokens: null,
        parse: 'json',
        confidence: null,
        notesForReviewer: null,
        raw: '{"translation":"Sie haben Rechnungen"}',
      },
      rejection: {
        reason: 'placeholder-missing',
        detail: 'The output is missing 1 placeholder: INTERPOLATION.',
        missing: ['INTERPOLATION'],
        extra: [],
      },
      findings: [],
    } satisfies TranslateUnitResponse);
    await fixture.whenStable();

    expect(closed).toBeUndefined();
    expect(TestBed.inject(DraftStore).draftFor(ROW, 'de')).toBeUndefined();
    expect(TestBed.inject(TranslateStore).runFor(ROW, 'de')?.result.ok).toBe(false);
  });

  it('will not offer to run against an endpoint that is not configured', async () => {
    const el = (
      await mount(
        preview({ blocked: 'No endpoint is configured. Set one in Settings before running.' }),
      )
    ).nativeElement as HTMLElement;

    const run = [...el.querySelectorAll('button')].find((b) =>
      text(b).startsWith('Run for this unit'),
    ) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(text(el)).toContain('No endpoint is configured');
  });
});

describe('TranslateStore', () => {
  /**
   * FR-6.10. The server answers 409 rather than replacing a human translation,
   * and the store has to turn that into a QUESTION rather than an error — the
   * difference between "something went wrong" and "here is what would be lost".
   */
  it('turns the overwrite refusal into a question it can answer', async () => {
    const store = TestBed.inject(TranslateStore);
    const running = store.translate(ROW, 'de');

    http
      .expectOne('/api/translate/unit')
      .flush(
        {
          error: {
            code: 'conflict',
            message: 'was written by a person',
            details: { existing: 'Jetzt bezahlen' },
          },
        },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await running).toBeNull();

    expect(store.error()).toBeNull();
    expect(store.confirm()).toMatchObject({ rowId: ROW, locale: 'de', existing: 'Jetzt bezahlen' });

    const confirmed = store.confirmOverwrite();
    const second = http.expectOne('/api/translate/unit');
    expect(second.request.body).toMatchObject({ overwrite: true });
    second.flush(
      { error: { code: 'internal', message: 'never mind' } },
      { status: 500, statusText: 'x' },
    );
    await confirmed;
    expect(store.confirm()).toBeNull();
  });
});
