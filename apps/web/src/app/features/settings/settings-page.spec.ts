// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmProbe, Project, Settings, UpdateStatus } from '@lexi/shared';

import { SettingsPage } from './settings-page.js';

/**
 * S7 is the first screen where every field changes how a later request is made,
 * so what is asserted here is the part that is not geometry: that the screen
 * cannot show something the server did not store, that a failed probe says
 * which of the three things failed in words rather than in colour, and that the
 * privacy line names the host the requests actually go to (FR-6.15).
 */

const settings = (
  over: Partial<Settings['llm']> = {},
  probe: LlmProbe | null = null,
): Settings => ({
  llm: {
    adapter: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    apiKeySet: false,
    loopback: true,
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
    maskPlaceholders: true,
    fewShotExamples: false,
    ...over,
  },
  theme: 'dark',
  editorMode: 'chips',
  lastProbe: probe,
  phrase: { tokens: [] },
  launch: { showMenu: true, lastParentDir: null },
});

const probe = (over: Partial<LlmProbe> = {}): LlmProbe => ({
  ok: false,
  endpoint: 'http://localhost:11434',
  model: 'qwen2.5:14b',
  steps: [
    { step: 'reachable', ok: true, detail: 'http://localhost:11434 answered.', latencyMs: 12 },
    { step: 'models', ok: true, detail: '2 models available.', latencyMs: null },
    { step: 'completion', ok: false, detail: '500 error — model failed to load', latencyMs: null },
  ],
  models: ['qwen2.5:14b', 'phi4'],
  at: '2026-09-16T12:00:00.000Z',
  ...over,
});

let http: HttpTestingController;

/**
 * Async because the store lands its answer in a signal from a promise: without
 * awaiting stability the template would be asserted one microtask before the
 * data it is about arrives, and every field would read empty.
 */
/** What the server says outside the desktop app: no updater, so no Updates pane. */
const NO_UPDATER: UpdateStatus = {
  supported: false,
  currentVersion: '1.0.0',
  mode: 'auto',
  state: { phase: 'idle' },
};

const mount = async (dto: Settings = settings(), update: UpdateStatus = NO_UPDATER) => {
  const fixture = TestBed.createComponent(SettingsPage);
  fixture.detectChanges();
  http.expectOne('/api/settings').flush(dto);
  // The page also asks whether a project is open, for the one setting on it
  // that belongs to the project rather than to the machine.
  http.expectOne('/api/project').flush(null, { status: 404, statusText: 'Not Found' });
  http.expectOne('/api/update').flush(update);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
};

/** Minimal but real — the Validation pane needs an open project to render its controls. */
const project = (over: Partial<Project> = {}): Project => ({
  path: '/Users/x/northwind',
  name: 'northwind',
  sourceLocale: 'en-GB',
  files: [],
  locales: [],
  unitCount: 0,
  customIdShare: 0,
  health: {
    units: 0,
    unitsWithNote: 0,
    noteCoverage: 0,
    customIdUnits: 0,
    customIdShare: 0,
    errorCells: 0,
    warningCells: 0,
    staleUnits: 0,
    issues: [],
  },
  editRate: [],
  visibleLocales: [],
  filters: [],
  groups: ['messages'],
  openedAt: new Date().toISOString(),
  writeState: 'auto',
  escapePolicy: 'angular',
  severities: {},
  ...over,
});

const mountOpen = async (settingsDto: Settings = settings(), projectDto: Project = project()) => {
  const fixture = TestBed.createComponent(SettingsPage);
  fixture.detectChanges();
  http.expectOne('/api/settings').flush(settingsDto);
  http.expectOne('/api/project').flush(projectDto);
  http.expectOne('/api/update').flush(NO_UPDATER);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
};

/**
 * A macrotask, which drains every microtask behind it.
 *
 * `whenStable` answers for Angular's own work; the field is cleared from a
 * promise chain two hops deep in the store, which Angular knows nothing about.
 */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  http.verify();
});

describe('SettingsPage', () => {
  it('shows what is stored, and asks for a key it can never display', async () => {
    const el = (await mount(settings({ apiKeySet: true }))).nativeElement as HTMLElement;

    expect((el.querySelector('input[type="url"]') as HTMLInputElement).value).toBe(
      'http://localhost:11434/v1',
    );
    const key = el.querySelector('input[type="password"]') as HTMLInputElement;
    // `apiKeySet` is all the server sends, and it is all the field needs.
    expect(key.value).toBe('');
    expect(key.getAttribute('placeholder')).toContain('stored');
    expect(text(el)).not.toContain('apiKey');
  });

  it('sends a typed key once and keeps no copy of it in the page', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const key = el.querySelector('input[type="password"]') as HTMLInputElement;

    key.value = 'sk-local-dummy';
    key.dispatchEvent(new Event('input'));
    key.dispatchEvent(new Event('change'));

    const request = http.expectOne('/api/settings');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ apiKey: 'sk-local-dummy' });
    request.flush(settings({ apiKeySet: true }));
    await settled();
    fixture.detectChanges();

    // The page dropped it the moment the server took it: committing the same
    // field again sends nothing, because there is nothing left in it to send.
    // (Asserted this way rather than by reading the input's value, which the
    // test itself wrote and Angular has no reason to overwrite.)
    key.dispatchEvent(new Event('change'));
    http.expectNone('/api/settings');
  });

  it('reports which of the three things failed, in words', async () => {
    const el = (await mount(settings({}, probe()))).nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.step')];

    expect(rows).toHaveLength(3);
    expect(text(rows[0] ?? null)).toContain('Endpoint');
    expect(text(rows[1] ?? null)).toContain('Model list');
    expect(text(rows[2] ?? null)).toContain('Completion');
    expect(text(rows[2] ?? null)).toContain('model failed to load');
    // The failure is carried by the row's text and its mark, not only by colour.
    expect(rows[2]?.getAttribute('data-ok')).toBe('false');
    expect(text(el.querySelector('.callout__head'))).toContain('Not usable yet');
  });

  it('does not paint a working endpoint red because it has no model list', async () => {
    const noList = probe({
      ok: true,
      steps: [
        { step: 'reachable', ok: true, detail: 'answered', latencyMs: 8 },
        { step: 'models', ok: false, detail: '404 from /models', latencyMs: null },
        {
          step: 'completion',
          ok: true,
          detail: 'Trivial completion in 310 ms — ok',
          latencyMs: 310,
        },
      ],
      models: [],
    });
    const el = (await mount(settings({}, noList))).nativeElement as HTMLElement;

    expect(el.querySelector('.callout')?.getAttribute('data-tone')).toBe('ok');
    expect(text(el.querySelector('.callout__head'))).toContain('Reachable');
  });

  it('names the host the requests go to, and says so when it is not this machine', async () => {
    const local = (await mount()).nativeElement as HTMLElement;
    expect(text(local.querySelector('.privacy'))).toContain('http://localhost:11434/v1');
    expect(local.querySelector('.privacy__warn')).toBeNull();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);

    const remote = (
      await mount(settings({ baseUrl: 'https://gpu.example.com/v1', loopback: false }))
    ).nativeElement as HTMLElement;
    expect(text(remote.querySelector('.privacy__warn'))).toContain('leave it');
  });

  it('hides the parameters Copilot ignores, and keeps the ones it uses', async () => {
    const labels = (el: HTMLElement): string[] =>
      [...el.querySelectorAll('lx-field')].map((f) => f.getAttribute('label') ?? '');

    const local = (await mount()).nativeElement as HTMLElement;
    expect(labels(local)).toEqual(
      expect.arrayContaining(['Base URL', 'Temperature', 'top_p', 'Max tokens', 'Seed']),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);

    const copilot = (
      await mount(
        settings({ adapter: 'copilot', baseUrl: '', model: 'gpt-5-mini', loopback: false }),
      )
    ).nativeElement as HTMLElement;
    const shown = labels(copilot);
    for (const hidden of ['Base URL', 'Temperature', 'top_p', 'Max tokens', 'Seed']) {
      expect(shown).not.toContain(hidden);
    }
    expect(shown).toEqual(
      expect.arrayContaining([
        'Model',
        'Context window',
        'Response timeout (s)',
        'Concurrent requests',
        'Units per request',
      ]),
    );
    expect(text(copilot)).toContain('premium requests');
  });

  it('repeats the server’s sentence when a setting is refused', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const url = el.querySelector('input[type="url"]') as HTMLInputElement;

    url.value = 'localhost:11434';
    url.dispatchEvent(new Event('input'));
    url.dispatchEvent(new Event('change'));

    http
      .expectOne('/api/settings')
      .flush(
        { error: { code: 'bad_request', message: '"localhost:11434" is missing its scheme.' } },
        { status: 400, statusText: 'Bad Request' },
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text(el.querySelector('.callout--bad'))).toContain('missing its scheme');
  });

  it('explains a section it has not built rather than showing an empty pane', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.nav')] as HTMLButtonElement[];

    // Model, Phrase, Validation rules, XLIFF output, Editor, Appearance, Shortcuts, About.
    expect(rows).toHaveLength(8);
    rows[3]?.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.title'))).toBe('XLIFF output');
    expect(text(el.querySelector('.pending'))).toContain('Output formatting follows the file');
  });

  it('says a rule severity needs a project, when none is open', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.nav')] as HTMLButtonElement[];

    rows[2]?.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.title'))).toBe('Validation rules');
    expect(el.querySelector('lx-segmented-control')).toBeNull();
    expect(text(el)).toContain('needs a project open');
  });

  it("lets a rule's severity be changed, patching the project (FR-8.2)", async () => {
    const fixture = await mountOpen();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.nav')] as HTMLButtonElement[];

    rows[2]?.click();
    fixture.detectChanges();

    const row = el.querySelector('[data-rule="target.empty"]')!;
    // The default, from the engine's own DEFAULT_SEVERITIES — nothing has been
    // configured for this project yet.
    expect(row.querySelector('.seg--active')?.textContent?.trim()).toBe('Error');

    const offButton = [...row.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Off',
    )!;
    offButton.click();

    const request = http.expectOne('/api/project');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ severities: { 'target.empty': 'off' } });
    request.flush(project({ severities: { 'target.empty': 'off' } }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(row.querySelector('.seg--active')?.textContent?.trim()).toBe('Off');
  });

  it('switches the target editor between chips and plain text, patching settings', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.nav')] as HTMLButtonElement[];

    rows[4]?.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.title'))).toBe('Editor');
    const textCard = el.querySelector('lx-radio-card[data-mode="text"]')!;
    textCard.dispatchEvent(new Event('click'));

    const request = http.expectOne('/api/settings');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ editorMode: 'text' });
    request.flush({ ...settings(), editorMode: 'text' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('lx-radio-card[data-mode="text"][aria-checked="true"]')).not.toBeNull();
  });

  it('lists the fixed shortcuts, grouped by where they apply', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.nav')] as HTMLButtonElement[];

    rows[6]?.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.title'))).toBe('Shortcuts');
    const groups = [...el.querySelectorAll('.shortcut-group')].map((g) =>
      g.querySelector('.lx-caption')?.textContent?.trim(),
    );
    expect(groups).toEqual(['Global', 'Launch menu', 'Grid', 'Review', 'Segment editor']);
    expect(text(el)).toContain('⌘,');
    expect(text(el)).toContain('⌘⇧P');
    expect(text(el)).toContain('⌘O');
    expect(text(el)).toContain('Go to Settings');
  });

  it('names the license and links the source and the files that travel with every copy', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.nav')] as HTMLButtonElement[];

    rows[7]?.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.title'))).toBe('About & license');
    expect(text(el)).toContain('GNU General Public License v3 or later');
    const links = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      'https://github.com/paglueck/lexi',
      'LICENSE.txt',
      'NOTICE.txt',
      'THIRD_PARTY_NOTICES.md',
      'third-party-licenses.txt',
    ]);
  });

  it('has no Updates pane outside the desktop app', async () => {
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    expect([...el.querySelectorAll('.nav')].map(text)).not.toContain('Updates');
  });

  it('checks for updates in place and shows what the check found', async () => {
    const desktop: UpdateStatus = { ...NO_UPDATER, supported: true, mode: 'dmg' };
    const fixture = await mount(settings(), desktop);
    const el = fixture.nativeElement as HTMLElement;
    const row = [...el.querySelectorAll('.nav')].find((r) => text(r) === 'Updates') as
      HTMLButtonElement | undefined;
    row!.click();
    fixture.detectChanges();

    expect(text(el.querySelector('.title'))).toBe('Updates');
    expect(text(el)).toContain('You are using Lexi 1.0.0');
    expect(text(el)).toContain('disk image');

    const check = [...el.querySelectorAll('button')].find((b) => text(b) === 'Check for updates')!;
    check.click();
    const request = http.expectOne('/api/update/check');
    expect(request.request.method).toBe('POST');
    request.flush({
      ...desktop,
      state: { phase: 'available', version: '1.1.0', releaseNotes: '- <b>Bold</b> claim' },
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text(el)).toContain('Lexi 1.1.0 is available');
    // The notes are text: markup from the update server is shown, never rendered.
    expect(el.querySelector('.notes')?.textContent).toBe('- <b>Bold</b> claim');
    expect(el.querySelector('.notes b')).toBeNull();
    expect([...el.querySelectorAll('button')].map(text)).toContain('Update to 1.1.0');
  });
});
