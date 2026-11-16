// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, UnitDetail, UnitTarget } from '@lexi/shared';

import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';
import { LxCellEditor } from './cell-editor.js';
import { LxUnitDetail } from './unit-detail.js';

/**
 * The panel's three states for a target that has no translation yet (FR-1.9),
 * which is the ordinary state of every string added since the translation files
 * were last copied:
 *
 *  - the unit is in the file → edit it;
 *  - the unit is not in the file, but the file exists → still edit it, and say
 *    that saving will add the string there;
 *  - the locale has no file in this group at all → no editor, and an offer to
 *    start one.
 *
 * Until the fix, all three said "this string is not present in the pl file, so
 * it cannot be edited yet", and the last two were dead ends.
 *
 * This spec also exists for a second reason: a
 * component no spec imports is never compiled by `ng test`, so its template is
 * type-checked at build time and nowhere else.
 */

const target = (over: Partial<UnitTarget> = {}): UnitTarget => ({
  locale: 'pl',
  isRtl: false,
  state: 'untranslated',
  missing: false,
  noFile: false,
  newFile: null,
  segments: [],
  findings: [],
  missingPlaceholders: [],
  charCount: 0,
  previous: null,
  origin: null,
  reviewReasons: [],
  ...over,
});

const detail = (targets: UnitTarget[]): UnitDetail => ({
  rowId: 'messagesinvoices',
  unitId: 'invoices',
  group: 'messages',
  customId: true,
  isIcu: false,
  sourceLocale: 'en-GB',
  source: [{ k: 't', v: 'You have invoices' }],
  notes: [],
  locations: [],
  targets,
  files: { de: 'messages.de.xlf' },
  notesFile: 'messages.xlf',
  notesFileIsTemplate: true,
  notesPending: false,
});

const project = (over: Partial<Project> = {}): Project =>
  ({
    path: '/x',
    name: 'x',
    sourceLocale: 'en-GB',
    files: [
      {
        path: '/x/messages.de.xlf',
        relPath: 'messages.de.xlf',
        fileIndex: 0,
        group: 'messages',
        locale: 'de',
        localeSource: 'filename',
        conflictingTargetLanguage: null,
        sourceLanguage: 'en-GB',
        targetLanguage: 'de',
        unitCount: 3,
        isTemplate: false,
        isRtl: false,
      },
    ],
    locales: [],
    unitCount: 3,
    customIdShare: 100,
    health: {
      units: 3,
      unitsWithNote: 0,
      noteCoverage: 0,
      customIdUnits: 3,
      customIdShare: 100,
      errorCells: 0,
      warningCells: 0,
      staleUnits: 0,
      issues: [],
    },
    editRate: [],
    visibleLocales: ['pl'],
    filters: [],
    groups: ['messages'],
    openedAt: new Date().toISOString(),
    writeState: 'auto',
    escapePolicy: 'angular',
    severities: {},
    ...over,
  }) as Project;

let http: HttpTestingController;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  http = TestBed.inject(HttpTestingController);
  TestBed.inject(ProjectStore).set(project());
  TestBed.inject(GridStore).setEditLocale('pl');
});

afterEach(() => {
  // The panel's own stores fetch settings on construction; answering is not the
  // point of these assertions, so any outstanding request is simply drained.
  for (const open of http.match(() => true)) open.flush({}, { status: 200, statusText: 'OK' });
});

const ROW = 'messages\u001finvoices';

/** What `GET /api/settings` answers, so the panel knows a model is configured. */
const settings = {
  llm: {
    adapter: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'qwen',
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
  },
  theme: 'system',
  editorMode: 'chips',
  lastProbe: null,
};

/**
 * Mount the panel with one row selected.
 *
 * The detail resource is keyed on the SELECTION, and the selection is an index
 * into the query's id list — so the query has to be answered first, exactly as
 * it is in the app. Short-circuiting it would test a component that cannot
 * happen.
 *
 * `whenStable` is deliberately not used: the grid's stores keep resources open
 * (the row windows are driven by a viewport this fixture does not have), so the
 * fixture never settles and the failure reads as a timeout rather than as an
 * assertion. Draining the microtask queue is what these assertions actually
 * need — the resources publish their values there.
 */
const mount = async (
  targets: UnitTarget[],
  component: Type<unknown> = LxUnitDetail,
  over: Partial<UnitDetail> = {},
) => {
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();

  for (const request of http.match('/api/settings')) request.flush(settings);
  http
    .expectOne((r) => r.url === '/api/units/query')
    .flush({ total: 1, ids: [ROW], scopeTotal: 1, facets: {}, groupCounts: {} });

  TestBed.inject(UnitsStore).select(0);
  await settle(fixture);

  http
    .expectOne((r) => r.url.startsWith('/api/units/messages'))
    .flush({ ...detail(targets), ...over });
  await settle(fixture);
  return fixture;
};

/** Let the resources publish, then render. Twice, because one feeds the other. */
async function settle(fixture: { detectChanges(): void }): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await Promise.resolve();
  }
  fixture.detectChanges();
}

const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('LxUnitDetail — a target with no translation yet', () => {
  it('edits a unit the file does not have, and says where saving will put it', async () => {
    const el = (await mount([target({ missing: true, noFile: false })]))
      .nativeElement as HTMLElement;

    expect(el.querySelector('lx-segment-editor')).not.toBeNull();
    expect(text(el)).toContain('Saving adds this string to');
    expect(text(el)).not.toContain('cannot be edited');
  });

  it('offers to start a locale that has no file, instead of a dead end', async () => {
    const el = (await mount([target({ missing: true, noFile: true, newFile: 'messages.pl.xlf' })]))
      .nativeElement as HTMLElement;

    expect(el.querySelector('lx-segment-editor')).toBeNull();
    expect(text(el)).toContain('No pl file for this group yet');

    const button = [...el.querySelectorAll('button')].find((b) => text(b).startsWith('Create'));
    expect(button).toBeDefined();
    // Named after the convention the project already uses, so the user can see
    // what is about to appear in their repository.
    expect(text(button!)).toContain('messages.pl.xlf');
  });

  it('asks the server to create the file, and re-reads the unit afterwards', async () => {
    const fixture = await mount([target({ missing: true, noFile: true })]);
    const el = fixture.nativeElement as HTMLElement;

    (
      [...el.querySelectorAll('button')].find((b) =>
        text(b).startsWith('Create'),
      ) as HTMLButtonElement
    ).click();

    const request = http.expectOne('/api/locales/file');
    expect(request.request.body).toEqual({ group: 'messages', locale: 'pl' });
    request.flush({ created: 'messages.pl.xlf', project: project() });
    await settle(fixture);

    // The unit is read again: the target that had nowhere to go now has a file.
    expect(http.match((r) => r.url.startsWith('/api/units/')).length).toBeGreaterThan(0);
  });

  it('still edits a unit that is in the file, unchanged', async () => {
    const el = (
      await mount([target({ segments: [{ k: 't', v: 'Masz faktury' }], state: 'reviewed' })])
    ).nativeElement as HTMLElement;

    expect(el.querySelector('lx-segment-editor')).not.toBeNull();
    expect(text(el)).not.toContain('Saving adds this string to');
    expect(text(el)).not.toContain('No pl file');
  });
});

describe('LxUnitDetail — deleting a translation for a locale', () => {
  const translated = () =>
    target({ segments: [{ k: 't', v: 'Masz faktury' }], state: 'reviewed', charCount: 12 });

  const clearButton = (el: HTMLElement): HTMLButtonElement | undefined =>
    [...el.querySelectorAll('button.clear')][0] as HTMLButtonElement | undefined;

  it('offers no delete where there is nothing to delete', async () => {
    const el = (await mount([target({ missing: true })])).nativeElement as HTMLElement;
    expect(clearButton(el)).toBeUndefined();
  });

  it('arms on the first click and only then writes the empty target', async () => {
    const fixture = await mount([translated()]);
    const el = fixture.nativeElement as HTMLElement;

    clearButton(el)!.click();
    await settle(fixture);

    // Armed, not sent: a stray click must not reach the file.
    http.expectNone((r) => r.url.includes('/targets/'));
    expect(text(clearButton(el)!)).toContain('Confirm');

    clearButton(el)!.click();
    await settle(fixture);

    // The row id carries a unit separator, so it reaches the wire encoded.
    const request = http.expectOne(
      (r) => r.url === `/api/units/${encodeURIComponent(ROW)}/targets/pl`,
    );
    // Empty segments ARE the delete — the server maps them back to
    // `untranslated`, so no delete endpoint has to exist.
    expect(request.request.body).toMatchObject({ segments: [] });
    request.flush(target({ state: 'untranslated' }));
    await settle(fixture);

    expect(text(clearButton(el) ?? null)).not.toContain('Confirm');
  });
});

/** The panel and the grid's inline editor, side by side as they are in the app. */
@Component({
  imports: [LxUnitDetail, LxCellEditor],
  template: `
    <lx-unit-detail />
    @if (session.inline()) {
      <lx-cell-editor />
    }
  `,
})
class PanelAndCell {
  readonly session = TestBed.inject(EditSessionStore);
}

describe('inline editing in the grid (the overlay editor)', () => {
  const translated = () =>
    target({ segments: [{ k: 't', v: 'Masz faktury' }], state: 'reviewed', charCount: 12 });

  it('moves the ONE editor from the panel into the overlay, never showing two', async () => {
    const fixture = await mount([translated()], PanelAndCell);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('lx-segment-editor')).toHaveLength(1);
    expect(el.querySelector('lx-cell-editor')).toBeNull();

    expect(TestBed.inject(EditSessionStore).openInline()).toBe(true);
    await settle(fixture);

    // Deviation 3's safety argument: two contenteditable instances would
    // fight over an IME composition. The panel shows the target read-only.
    expect(el.querySelectorAll('lx-segment-editor')).toHaveLength(1);
    expect(el.querySelector('lx-cell-editor lx-segment-editor')).not.toBeNull();
    expect(text(el.querySelector('lx-unit-detail'))).toContain('Editing in the grid');
    expect(text(el.querySelector('lx-unit-detail'))).toContain('Masz faktury');
  });

  it('does not open over a locale that has no file to write to', async () => {
    await mount([target({ noFile: true })], PanelAndCell);
    expect(TestBed.inject(EditSessionStore).openInline('pl')).toBe(false);
    expect(TestBed.inject(EditSessionStore).inline()).toBe(false);
  });

  it('commits what was typed and moves to the next row, staying open', async () => {
    const fixture = await mount([translated()], PanelAndCell);
    const session = TestBed.inject(EditSessionStore);
    session.openInline();
    await settle(fixture);

    session.onEdit([{ k: 't', v: 'Masz rachunki' }]);
    const editor = (fixture.nativeElement as HTMLElement).querySelector(
      'lx-cell-editor lx-segment-editor',
    )!;
    // Enter inside the editor is its `commit` output.
    editor
      .querySelector('[contenteditable]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    await settle(fixture);

    const request = http.expectOne(
      (r) => r.url === `/api/units/${encodeURIComponent(ROW)}/targets/pl`,
    );
    expect(request.request.body).toMatchObject({ segments: [{ k: 't', v: 'Masz rachunki' }] });
    request.flush(target({ segments: [{ k: 't', v: 'Masz rachunki' }], state: 'reviewed' }));
    await settle(fixture);
    expect(session.inline()).toBe(true);
  });

  it('Esc throws the typing away and closes, sending nothing', async () => {
    const fixture = await mount([translated()], PanelAndCell);
    const session = TestBed.inject(EditSessionStore);
    session.openInline();
    await settle(fixture);

    session.onEdit([{ k: 't', v: 'nope' }]);
    const surface = (fixture.nativeElement as HTMLElement).querySelector(
      'lx-cell-editor [contenteditable]',
    )!;
    surface.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle(fixture);

    expect(session.inline()).toBe(false);
    expect(session.hasBuffer()).toBe(false);
    http.expectNone((r) => r.method === 'PATCH');
  });
});

describe('LxUnitDetail — editing notes (FR-4.2)', () => {
  const described = {
    notes: [{ from: 'description', priority: '1', text: 'The checkout button.' }],
  };
  const button = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(label),
    ) as HTMLButtonElement | undefined;
  const notesPut = () =>
    http.expectOne(
      (r) => r.method === 'PUT' && r.url === `/api/units/${encodeURIComponent(ROW)}/notes`,
    );

  it('adds a note through the overlay and warns that the template is regenerated', async () => {
    const fixture = await mount([target()], LxUnitDetail, described);
    const el = fixture.nativeElement as HTMLElement;

    button(el, 'Add note')!.click();
    await settle(fixture);
    expect(text(el.querySelector('.noteform'))).toContain('the next ng extract-i18n overwrites it');

    const area = el.querySelector<HTMLTextAreaElement>('.notetext')!;
    area.value = 'Shown under the total';
    area.dispatchEvent(new Event('input'));
    await settle(fixture); // Keep is disabled until there is text
    button(el, 'Keep note')!.click();
    await settle(fixture);

    const request = notesPut();
    expect(request.request.body).toEqual({
      notes: [
        { from: 'description', text: 'The checkout button.' },
        { from: 'description', text: 'Shown under the total' },
      ],
    });
    request.flush({
      detail: {
        ...detail([target()]),
        notes: [
          ...described.notes,
          { from: 'description', priority: '1', text: 'Shown under the total' },
        ],
        notesPending: true,
      },
      unsavedCount: 1,
    });
    await settle(fixture);

    expect(el.querySelector('.noteform')).toBeNull();
    expect(text(el.querySelector('.notes'))).toContain('Shown under the total');
    expect(text(el.querySelector('.notes'))).toContain('unsaved');
  });

  it('edits a note in place', async () => {
    const fixture = await mount([target()], LxUnitDetail, described);
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Edit note 1')!.click();
    await settle(fixture);

    const area = el.querySelector<HTMLTextAreaElement>('.notetext')!;
    expect(area.value).toBe('The checkout button.');
    area.value = 'The big button.';
    area.dispatchEvent(new Event('input'));
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    );
    await settle(fixture);

    expect(notesPut().request.body).toEqual({
      notes: [{ from: 'description', text: 'The big button.' }],
    });
  });

  it('deletes only on the second click', async () => {
    const fixture = await mount([target()], LxUnitDetail, described);
    const el = fixture.nativeElement as HTMLElement;

    button(el, 'Delete note 1')!.click();
    await settle(fixture);
    http.expectNone((r) => r.method === 'PUT');

    button(el, 'Confirm: delete note 1')!.click();
    await settle(fixture);
    expect(notesPut().request.body).toEqual({ notes: [] });
  });

  it('offers no editing for an orphan, which has no source unit to hold notes', async () => {
    const fixture = await mount([target()], LxUnitDetail, { ...described, notesFile: null });
    const el = fixture.nativeElement as HTMLElement;
    expect(button(el, 'Add note')).toBeUndefined();
    expect(button(el, 'Edit note 1')).toBeUndefined();
  });
});
