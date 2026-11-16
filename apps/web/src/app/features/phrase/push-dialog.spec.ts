// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DialogRef } from '@angular/cdk/dialog';
import { describe, expect, it, vi } from 'vitest';
import type { PhraseBranchesResponse, PhrasePushResponse, PhraseStatus } from '@lexi/shared';

import { PhraseApi } from '../../core/api/phrase-api.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { EventsStore } from '../../core/stores/events-store.js';
import { configVerifies, LxPhrasePushDialog, summarise, targetLabel } from './push-dialog.js';

/**
 * "Push to Phrase": what it shows before, what it does with unsaved work, and
 * how it reports a push where one file failed.
 */

const STATUS: PhraseStatus = {
  configFile: '.phrase.yml',
  projectId: 'p1',
  projectName: 'Web',
  host: 'https://api.phrase.com/v2',
  tokenSource: 'settings',
  files: [
    {
      relPath: 'messages.de.xlf',
      localeId: 'de',
      projectId: 'p1',
      params: {},
      target: { id: 'dev-de', name: 'Developer-German', code: 'de' },
    },
    {
      relPath: 'messages.fr.xlf',
      localeId: 'loc-fr',
      projectId: 'p1',
      params: {},
      target: { id: 'loc-fr', name: 'fr', code: 'fr' },
    },
  ],
  problems: [],
  unpinned: 1,
  branch: null,
};

const RESULT: PhrasePushResponse = {
  ok: false,
  cancelled: false,
  branch: null,
  createdLocales: [],
  results: [
    {
      relPath: 'messages.de.xlf',
      localeId: 'de',
      ok: true,
      summary: { translation_keys_created: 1, translations_updated: 2 },
      error: null,
    },
    {
      relPath: 'messages.fr.xlf',
      localeId: 'fr',
      ok: false,
      summary: {},
      error: 'Could not parse the file',
    },
  ],
};

const NO_BRANCHES: PhraseBranchesResponse = { branches: [], configured: null };
const BRANCHES: PhraseBranchesResponse = {
  branches: [
    { name: 'feature-x', updatedAt: null },
    { name: 'release-2', updatedAt: null },
  ],
  configured: 'release-2',
};

function mount(
  unsaved = 0,
  saveOk = true,
  branches: PhraseBranchesResponse | Error = NO_BRANCHES,
  status: PhraseStatus = STATUS,
) {
  const api = {
    status: vi.fn().mockResolvedValue(status),
    pinLocales: vi.fn().mockResolvedValue({ pinned: 1, problems: [] }),
    branches:
      branches instanceof Error
        ? vi.fn().mockRejectedValue(branches)
        : vi.fn().mockResolvedValue(branches),
    push: vi.fn().mockResolvedValue(RESULT),
    cancelPush: vi.fn().mockResolvedValue(undefined),
  };
  const drafts = {
    count: signal(unsaved),
    error: signal<string | null>(null),
    saveAll: vi.fn().mockImplementation(async () => {
      if (saveOk) drafts.count.set(0);
      return saveOk;
    }),
  };
  const events = { phrasePush: signal(new Map()), clearPhrasePush: vi.fn() };
  const ref = { close: vi.fn(), disableClose: undefined as boolean | undefined };

  TestBed.configureTestingModule({
    providers: [
      { provide: PhraseApi, useValue: api },
      { provide: DraftStore, useValue: drafts },
      { provide: EventsStore, useValue: events },
      { provide: DialogRef, useValue: ref },
    ],
  });
  const fixture = TestBed.createComponent(LxPhrasePushDialog);
  fixture.detectChanges();
  return { fixture, api, drafts, ref };
}

const el = (f: ReturnType<typeof mount>['fixture']) => f.nativeElement as HTMLElement;
const primary = (f: ReturnType<typeof mount>['fixture']) =>
  el(f).querySelector<HTMLButtonElement>('button[data-variant="primary"]')!;

const picker = (f: ReturnType<typeof mount>['fixture']) =>
  el(f).querySelector<HTMLSelectElement>('select[aria-label="Phrase branch"]');

const verifyBox = (f: ReturnType<typeof mount>['fixture']) =>
  el(f).querySelector<HTMLInputElement>('label.check input[type="checkbox"]');

/** Two rounds: the branch list is asked for only once the status is in. */
const settle = async (f: ReturnType<typeof mount>['fixture']) => {
  for (let round = 0; round < 2; round++) {
    await f.whenStable();
    f.detectChanges();
  }
};

describe('summarise', () => {
  it('names what changed and leaves out the zeros', () => {
    expect(summarise(RESULT.results[0]!)).toBe('1 key created · 2 translations updated');
    expect(summarise(RESULT.results[1]!)).toBe('no changes');
  });
});

describe('targetLabel', () => {
  it('names the Phrase locale a file goes to, and only that when pinned by id', () => {
    expect(targetLabel(STATUS.files[0]!)).toBe('de → Developer-German (de)');
    expect(targetLabel(STATUS.files[1]!)).toBe('fr');
    expect(targetLabel({ ...STATUS.files[0]!, target: null })).toBe('de');
  });
});

describe('LxPhrasePushDialog', () => {
  it('lists the files the config resolves to before anything is pushed', async () => {
    const { fixture, api } = mount();
    await settle(fixture);
    expect(
      [...el(fixture).querySelectorAll('.file__path')].map((n) => n.textContent?.trim()),
    ).toEqual(['messages.de.xlf', 'messages.fr.xlf']);
    expect(primary(fixture).textContent?.trim()).toBe('Push');
    expect(api.push).not.toHaveBeenCalled();
  });

  it('saves unsaved changes first when asked to push them', async () => {
    const { fixture, api, drafts } = mount(3);
    await settle(fixture);
    expect(el(fixture).textContent).toContain('3 unsaved changes are not in');
    expect(primary(fixture).textContent?.trim()).toBe('Save & push');

    primary(fixture).click();
    await settle(fixture);
    expect(drafts.saveAll).toHaveBeenCalledOnce();
    expect(api.push).toHaveBeenCalledOnce();
  });

  it('does not push when the save fails', async () => {
    const { fixture, api } = mount(1, false);
    await settle(fixture);
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'nothing was pushed',
    );
  });

  it('reports each file, and says how many failed', async () => {
    const { fixture } = mount();
    await settle(fixture);
    primary(fixture).click();
    await settle(fixture);
    const rows = [...el(fixture).querySelectorAll('.file')];
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'failed']);
    expect(rows[0]?.textContent).toContain('1 key created');
    expect(rows[1]?.textContent).toContain('Could not parse the file');
    expect(el(fixture).textContent).toContain('1 of 2 files failed');
  });

  it('cannot be dismissed while the push runs, only cancelled', async () => {
    const { fixture, api, ref } = mount();
    let answer!: (r: PhrasePushResponse) => void;
    api.push.mockReturnValue(new Promise<PhrasePushResponse>((r) => (answer = r)));
    await settle(fixture);
    expect(ref.disableClose).toBe(false);
    expect(el(fixture).querySelector('button[aria-label="Close"]')).not.toBeNull();

    primary(fixture).click();
    await settle(fixture);
    expect(ref.disableClose).toBe(true);
    expect(el(fixture).querySelector('button[aria-label="Close"]')).toBeNull();
    const cancel = [...el(fixture).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel push',
    )!;
    cancel.click();
    await settle(fixture);
    expect(api.cancelPush).toHaveBeenCalledOnce();
    expect(ref.close).not.toHaveBeenCalled();
    expect(cancel.textContent?.trim()).toBe('Cancelling…');

    answer({
      ...RESULT,
      cancelled: true,
      results: [
        RESULT.results[0]!,
        { ...RESULT.results[1]!, error: 'Not pushed: the push was cancelled.' },
      ],
    });
    await settle(fixture);
    expect(ref.disableClose).toBe(false);
    expect(el(fixture).textContent).toContain('Push cancelled. 1 of 2 files pushed.');
    expect(el(fixture).textContent).toContain('Not pushed: the push was cancelled.');
  });

  it('marks the uploads as verified when that is checked', async () => {
    const { fixture, api } = mount();
    await settle(fixture);
    const box = verifyBox(fixture)!;
    expect(box.checked).toBe(false);
    box.click();
    fixture.detectChanges();
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith(null, true);
    expect(verifyBox(fixture)!.disabled).toBe(true);
  });

  it('starts with verified checked when the config verifies every source', async () => {
    const verifying = (on: unknown) => ({
      ...STATUS.files[0]!,
      params: { verify_mentioned_translations: on },
    });
    expect(
      configVerifies({ ...STATUS, files: [verifying(true), verifying(true)] } as PhraseStatus),
    ).toBe(true);
    expect(
      configVerifies({ ...STATUS, files: [verifying(true), verifying(false)] } as PhraseStatus),
    ).toBe(false);
    expect(configVerifies(STATUS)).toBe(false);

    const { fixture, api } = mount(0, true, NO_BRANCHES, {
      ...STATUS,
      files: STATUS.files.map((f) => ({ ...f, params: { verify_mentioned_translations: true } })),
    });
    await settle(fixture);
    expect(verifyBox(fixture)!.checked).toBe(true);
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith(null, true);
  });

  it('offers no branch picker when the project has no branches, and pushes to main', async () => {
    const { fixture, api } = mount();
    await settle(fixture);
    expect(picker(fixture)).toBeNull();
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith(null, false);
  });

  it('starts on the configured branch and pushes to the one picked', async () => {
    const { fixture, api } = mount(0, true, BRANCHES);
    await settle(fixture);
    const select = picker(fixture)!;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'feature-x', 'release-2']);
    expect(select.value).toBe('release-2');

    select.value = 'feature-x';
    select.dispatchEvent(new Event('change'));
    // The status is read again for the pick; the button waits for it.
    await settle(fixture);
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith('feature-x', false);
  });

  it('pushes to the main project when that is picked over the configured branch', async () => {
    const { fixture, api } = mount(0, true, BRANCHES);
    await settle(fixture);
    const select = picker(fixture)!;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    // The status is read again for the pick; the button waits for it.
    await settle(fixture);
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith(null, false);
  });

  it('warns when the configured branch is not open in Phrase', async () => {
    const { fixture } = mount(0, true, { ...BRANCHES, configured: 'gone' });
    await settle(fixture);
    expect(picker(fixture)!.value).toBe('');
    expect(el(fixture).textContent).toContain('pushes to the branch "gone"');
  });

  it('leaves the branch to the config when the branches cannot be listed', async () => {
    const { fixture, api } = mount(0, true, new Error('offline'));
    await settle(fixture);
    expect(picker(fixture)).toBeNull();
    expect(el(fixture).textContent).toContain('Could not list the Phrase branches');
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith(undefined, false);
  });

  it('will not push while a file has no single Phrase locale', async () => {
    const unresolved: PhraseStatus = {
      ...STATUS,
      files: [{ ...STATUS.files[0]!, target: null }, STATUS.files[1]!],
      problems: ['messages.de.xlf: "de" matches 2 Phrase locales'],
    };
    const { fixture, api } = mount(0, true, NO_BRANCHES, unresolved);
    await settle(fixture);
    expect(primary(fixture).disabled).toBe(true);
    primary(fixture).click();
    await settle(fixture);
    expect(api.push).not.toHaveBeenCalled();
  });

  it('pins the locale ids and reads the status again', async () => {
    const { fixture, api } = mount();
    await settle(fixture);
    const pin = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Pin locale ids'),
    )!;
    api.status.mockResolvedValue({ ...STATUS, unpinned: 0 });
    pin.click();
    await settle(fixture);
    expect(api.pinLocales).toHaveBeenCalledOnce();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(el(fixture).textContent).not.toContain('Pin locale ids');
  });

  it('shows a locale Phrase created as an alert', async () => {
    const { fixture, api } = mount();
    api.push.mockResolvedValue({
      ...RESULT,
      createdLocales: [
        'Phrase now has a locale de (id x) that the push created. Delete it in Phrase.',
      ],
    });
    await settle(fixture);
    primary(fixture).click();
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'that the push created',
    );
  });

  it('checks the locales on the branch picked, and allows the push only where they resolve', async () => {
    const ambiguousOnMain: PhraseStatus = {
      ...STATUS,
      branch: null,
      files: [{ ...STATUS.files[0]!, target: null }, STATUS.files[1]!],
      problems: ['messages.de.xlf: "de" matches 2 Phrase locales'],
    };
    const cleanOnBranch: PhraseStatus = { ...STATUS, branch: 'feature-x' };
    const { fixture, api } = mount(0, true, { ...BRANCHES, configured: null }, ambiguousOnMain);
    await settle(fixture);
    expect(api.status).toHaveBeenLastCalledWith(null);
    expect(primary(fixture).disabled).toBe(true);

    api.status.mockResolvedValue(cleanOnBranch);
    const select = picker(fixture)!;
    select.value = 'feature-x';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(api.status).toHaveBeenLastCalledWith('feature-x');
    expect(primary(fixture).disabled).toBe(false);

    primary(fixture).click();
    await settle(fixture);
    expect(api.push).toHaveBeenCalledWith('feature-x', false);
  });
});
