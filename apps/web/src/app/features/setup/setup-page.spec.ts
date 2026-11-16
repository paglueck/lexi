// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectScanResponse, ScannedFile } from '@lexi/shared';

import { PhraseApi } from '../../core/api/phrase-api.js';
import { ProjectApi } from '../../core/api/project-api.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { WizardStore } from '../../core/stores/wizard-store.js';
import { SetupPage } from './setup-page.js';

/**
 * The wizard's first-open-only half: a re-map starts from what was confirmed
 * last time, and the optional Phrase step comes only on a project's first open.
 */

const file = (relPath: string, locale: string | null, isTemplate = false): ScannedFile =>
  ({
    path: `/p/${relPath}`,
    relPath,
    fileIndex: 0,
    group: 'messages',
    locale,
    localeSource: locale === null ? 'none' : 'filename',
    conflictingTargetLanguage: null,
    sourceLanguage: 'en-GB',
    targetLanguage: locale,
    unitCount: 2,
    isTemplate,
    isRtl: false,
  }) as ScannedFile;

const scan = (saved: ProjectScanResponse['saved']): ProjectScanResponse => ({
  root: '/p',
  files: [file('messages.xlf', null, true), file('messages.de.xlf', 'de')],
  skipped: [],
  durationMs: 10,
  suggestedSourceLocale: 'en-GB',
  saved,
});

function mount(saved: ProjectScanResponse['saved']) {
  history.replaceState({}, '', '/setup?path=/p');
  const api = {
    scan: vi.fn().mockResolvedValue(scan(saved)),
    open: vi.fn().mockResolvedValue({ path: '/p', name: 'p', files: [] }),
  };
  const phrase = {
    status: vi.fn().mockResolvedValue({
      configFile: null,
      projectId: null,
      projectName: null,
      host: '',
      tokenSource: 'settings',
      files: [],
      problems: [],
    }),
    projects: vi.fn().mockResolvedValue({ projects: [] }),
  };
  const router = { navigate: vi.fn().mockResolvedValue(true) };
  const projects = { set: vi.fn(), files: signal([]) };

  TestBed.configureTestingModule({
    providers: [
      { provide: ProjectApi, useValue: api },
      { provide: PhraseApi, useValue: phrase },
      { provide: Router, useValue: router },
      { provide: ProjectStore, useValue: projects },
    ],
  });
  const fixture = TestBed.createComponent(SetupPage);
  fixture.detectChanges();
  return { fixture, api, router, phrase, wizard: TestBed.inject(WizardStore) };
}

type Fixture = ReturnType<typeof mount>['fixture'];
const el = (f: Fixture) => f.nativeElement as HTMLElement;
const settle = async (f: Fixture) => {
  await f.whenStable();
  f.detectChanges();
};
const primary = (f: Fixture) =>
  el(f).querySelector<HTMLButtonElement>('.foot button[data-variant="primary"]')!;

/** Through both steps to "Open project". */
async function confirmAll(f: Fixture): Promise<void> {
  await settle(f);
  primary(f).click(); // Confirm mappings
  await settle(f);
  primary(f).click(); // Open project
  await settle(f);
}

afterEach(() => {
  history.replaceState({}, '', '/');
});

describe('SetupPage', () => {
  it('offers the Phrase step after opening a project for the first time', async () => {
    const { fixture, api, router, wizard, phrase } = mount(null);
    await confirmAll(fixture);
    expect(api.open).toHaveBeenCalledOnce();
    expect(wizard.step()).toBe(3);
    expect(phrase.status).toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();

    const skip = [
      ...el(fixture).querySelectorAll<HTMLButtonElement>('lx-phrase-connect button'),
    ].find((b) => b.textContent?.trim() === 'Skip')!;
    skip.click();
    await settle(fixture);
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
    expect(wizard.active()).toBe(false);
  });

  it('starts a re-map from the saved mapping and skips the Phrase step', async () => {
    const { fixture, api, router, wizard } = mount({
      sourceLocale: 'de',
      mapping: [
        { relPath: 'messages.xlf', fileIndex: 0, locale: 'en-GB' },
        { relPath: 'messages.de.xlf', fileIndex: 0, locale: 'de-AT' },
      ],
    });
    await confirmAll(fixture);
    const body = api.open.mock.calls[0]?.[0] as {
      sourceLocale: string;
      mapping: Array<{ locale: string }>;
    };
    expect(body.sourceLocale).toBe('de');
    expect(body.mapping.map((m) => m.locale)).toEqual(['en-GB', 'de-AT']);
    expect(wizard.step()).not.toBe(3);
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });
});
