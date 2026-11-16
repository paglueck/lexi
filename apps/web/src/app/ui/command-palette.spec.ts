// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DialogRef } from '@angular/cdk/dialog';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '@lexi/shared';

import { LxCommandPalette } from './command-palette.js';

/**
 * `⌘K` is a navigation aid: what matters is that filtering, arrow movement and
 * Enter all land on the command the user actually meant, and that running one
 * closes the palette. Escape-to-close and the focus trap are CDK `Dialog`'s
 * own guarantees (`LxModalService`'s doc comment) and are not re-tested here.
 */

const settings = (): Settings => ({
  llm: {
    adapter: 'openai',
    baseUrl: '',
    model: '',
    apiKeySet: false,
    loopback: false,
    params: {
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 512,
      contextWindow: 8192,
      requestTimeoutSeconds: 120,
      seed: null,
      concurrency: 2,
      reasoningEffort: 'none',
      unitsPerRequest: 1,
    },
    maskPlaceholders: true,
    fewShotExamples: false,
  },
  theme: 'system',
  editorMode: 'chips',
  lastProbe: null,
  phrase: { tokens: [] },
  launch: { showMenu: true, lastParentDir: null },
});

let closed = false;
let http: HttpTestingController;

beforeEach(() => {
  closed = false;
  // `ThemeStore` adopts the server's theme once per browser (M8); clearing
  // this keeps that GET /api/settings request — and its flush below — the
  // same in every test regardless of run order.
  localStorage.clear();

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'dashboard', children: [] },
        { path: 'grid', children: [] },
        { path: 'styleguides', children: [] },
        { path: 'jobs', children: [] },
        { path: 'settings', children: [] },
      ]),
      { provide: DialogRef, useValue: { close: () => (closed = true) } },
    ],
  });
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  http.verify();
});

/** The label only — an option's own `<kbd>` hint (e.g. Settings' `⌘,`) is not part of it. */
const options = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[role="option"] span')].map((el) => el.textContent?.trim() ?? '');

const mount = () => {
  const fixture = TestBed.createComponent(LxCommandPalette);
  fixture.detectChanges();
  http.expectOne('/api/settings').flush(settings());
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, input: host.querySelector('input')! };
};

describe('LxCommandPalette', () => {
  it('lists every command until the user types', () => {
    const { host } = mount();
    expect(options(host)).toEqual([
      'Go to Dashboard',
      'Go to Grid',
      'Go to Review',
      'Go to Style guides',
      'Go to Term Base',
      'Go to Issues',
      'Go to Jobs',
      'Go to Settings',
      'Undo',
      'Redo',
      'Discard all unsaved changes',
      'Reload project from disk',
      'Re-scan project',
      'Edit locale mapping',
      'Push to Phrase',
      'Connect to Phrase',
      'Switch project',
      'Open a project…',
      'Check out from Phrase',
      'Clear recent projects',
      'Switch to dark theme',
      'Switch to light theme',
      'Match the system theme',
    ]);
  });

  it('filters commands by label, case-insensitively', () => {
    const { fixture, host, input } = mount();
    input.value = 'JOBS';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(options(host)).toEqual(['Go to Jobs']);
  });

  it('shows an empty state rather than nothing when nothing matches', () => {
    const { fixture, host, input } = mount();
    input.value = 'xyz-nonsense';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(options(host)).toEqual([]);
    expect(host.textContent).toContain('No matching commands.');
  });

  it('moves the highlight with arrow keys and runs it on Enter', async () => {
    const { fixture, host, input } = mount();
    const router = TestBed.inject(Router);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    fixture.detectChanges();
    expect(host.querySelector('.option--on')?.textContent?.trim()).toBe('Go to Grid');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(closed).toBe(true);
    expect(router.url).toBe('/grid');
  });

  it('runs a theme command without navigating, and patches settings', async () => {
    const { fixture, host, input } = mount();

    input.value = 'dark theme';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(closed).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // `ThemeStore.set()` patches fire-and-forget; flushed so it does not leak
    // into the next test as an unanswered request.
    http.expectOne('/api/settings').flush({ ...settings(), theme: 'dark' });
    await fixture.whenStable();
    void host;
  });

  it('picking an option with the mouse runs it too', async () => {
    const { fixture, host } = mount();
    const router = TestBed.inject(Router);
    const option = [...host.querySelectorAll('[role="option"]')].find(
      (el) => el.querySelector('span')?.textContent?.trim() === 'Go to Settings',
    )!;

    option.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(closed).toBe(true);
    expect(router.url).toBe('/settings');
  });
});
