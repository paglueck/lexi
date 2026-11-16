// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type {
  HistoryStatus,
  HistoryStepResponse,
  TargetPatchResponse,
  UnitTarget,
} from '@lexi/shared';

import { historyChord } from '../history-actions.js';
import { DraftStore } from './draft-store.js';
import { SaveStore } from './save-store.js';

/**
 * The client half of undo: the draft mirror, the unsaved count and the
 * toolbar's labels have to follow what the server's history just did.
 */

const target = (text: string): UnitTarget =>
  ({ locale: 'de', segments: [{ k: 't', v: text }], state: 'reviewed' }) as unknown as UnitTarget;

const status = (over: Partial<HistoryStatus> = {}): HistoryStatus => ({
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  ...over,
});

const settle = () => new Promise((resolve) => setTimeout(resolve));

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const http = TestBed.inject(HttpTestingController);
  const drafts = TestBed.inject(DraftStore);
  TestBed.tick();
  // Startup reads; answered so `verify` only sees what the test asked.
  for (const req of http.match(() => true)) req.flush(null);
  return { http, drafts, save: TestBed.inject(SaveStore) };
}

/** Answer everything except the call under test — row refreshes, detail reloads. */
function flushOthers(http: HttpTestingController, keep: string): void {
  for (const req of http.match((r) => r.url !== keep)) req.flush({ rows: [] });
}

async function commit(
  http: HttpTestingController,
  drafts: DraftStore,
  text: string,
  history: HistoryStatus,
) {
  const done = drafts.commit('messages\0pay', 'de', [{ k: 't', v: text }]);
  const res: TargetPatchResponse = { target: target(text), unsavedCount: 1, history };
  http.expectOne((r) => r.method === 'PATCH').flush(res);
  await done;
}

describe('DraftStore history', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify({ ignoreCancelled: true }));

  it('takes the toolbar state from the edit that recorded the step', async () => {
    const { http, drafts } = setup();
    await commit(http, drafts, 'Eins', status({ canUndo: true, undoLabel: 'Edit' }));
    flushOthers(http, '');

    expect(drafts.canUndo()).toBe(true);
    expect(drafts.undoLabel()).toBe('Edit');
  });

  it('drops a draft an undo took back to the file, and keeps one it restored', async () => {
    const { http, drafts, save } = setup();
    await commit(http, drafts, 'Zwei', status({ canUndo: true, undoLabel: 'Edit' }));
    flushOthers(http, '');

    const first = drafts.undo();
    const back: HistoryStepResponse = {
      label: 'Edit',
      cells: [{ rowId: 'messages\0pay', locale: 'de', target: target('Eins'), pending: true }],
      noteRows: [],
      unsavedCount: 1,
      history: status({ canUndo: true, canRedo: true, undoLabel: 'Edit', redoLabel: 'Edit' }),
    };
    http.expectOne('/api/history/undo').flush(back);
    expect(await first).toBe('Edit');
    flushOthers(http, '');
    expect(drafts.draftFor('messages\0pay', 'de')?.target.segments).toEqual([
      { k: 't', v: 'Eins' },
    ]);
    expect(drafts.canRedo()).toBe(true);

    const second = drafts.undo();
    http.expectOne('/api/history/undo').flush({
      ...back,
      cells: [{ ...back.cells[0], target: target('Jetzt bezahlen'), pending: false }],
      unsavedCount: 0,
      history: status({ canRedo: true, redoLabel: 'Edit' }),
    });
    await second;
    flushOthers(http, '');
    expect(drafts.draftFor('messages\0pay', 'de')).toBeUndefined();
    expect(save.unsavedCount()).toBe(0);
    expect(drafts.canUndo()).toBe(false);
  });

  it('reports a refused undo as null, with the reason', async () => {
    const { http, drafts } = setup();
    const res = drafts.undo();
    http
      .expectOne('/api/history/undo')
      .flush(
        { error: { message: 'There is nothing to undo.' } },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await res).toBeNull();
    expect(drafts.error()).toBe('There is nothing to undo.');
    await settle();
    http.expectOne('/api/history').flush(status());
  });

  it('reverts several cells in one request, so one undo brings them back', async () => {
    const { http, drafts } = setup();
    const res = drafts.revertMany([
      { rowId: 'a', locale: 'de' },
      { rowId: 'b', locale: 'fr' },
    ]);
    const req = http.expectOne('/api/drafts/discard');
    expect(req.request.body).toEqual({
      cells: [
        { rowId: 'a', locale: 'de' },
        { rowId: 'b', locale: 'fr' },
      ],
    });
    req.flush({
      cells: [
        { rowId: 'a', locale: 'de', target: target('A'), pending: false },
        { rowId: 'b', locale: 'fr', target: target('B'), pending: false },
      ],
      noteRows: [],
      unsavedCount: 0,
      history: status({ canUndo: true, undoLabel: 'Revert' }),
    });
    expect(await res).toBe(2);
    flushOthers(http, '');
    expect(drafts.undoLabel()).toBe('Revert');
  });

  it('forgets the history when a save lands', async () => {
    const { http, drafts, save } = setup();
    await commit(http, drafts, 'Eins', status({ canUndo: true, undoLabel: 'Edit' }));
    flushOthers(http, '');

    save.markSaved(new Date().toISOString());
    TestBed.tick();
    expect(drafts.canUndo()).toBe(false);
  });
});

describe('historyChord', () => {
  const key = (init: KeyboardEventInit, target?: HTMLElement): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', init);
    if (target !== undefined) Object.defineProperty(event, 'target', { value: target });
    return event;
  };

  it('reads ⌘Z as undo and ⌘⇧Z or Ctrl+Y as redo', () => {
    expect(historyChord(key({ key: 'z', metaKey: true }))).toBe('undo');
    expect(historyChord(key({ key: 'z', ctrlKey: true }))).toBe('undo');
    expect(historyChord(key({ key: 'Z', metaKey: true, shiftKey: true }))).toBe('redo');
    expect(historyChord(key({ key: 'y', ctrlKey: true }))).toBe('redo');
  });

  it('ignores a bare z and other chords', () => {
    expect(historyChord(key({ key: 'z' }))).toBeNull();
    expect(historyChord(key({ key: 'k', metaKey: true }))).toBeNull();
    expect(historyChord(key({ key: 'y', metaKey: true }))).toBeNull();
  });

  it('leaves ⌘Z to a text field, where it is the field’s own text undo', () => {
    // The segment editor's text mode; jsdom has no `isContentEditable` for its rich one.
    expect(
      historyChord(key({ key: 'z', metaKey: true }, document.createElement('textarea'))),
    ).toBeNull();
    expect(
      historyChord(
        key({ key: 'z', metaKey: true, shiftKey: true }, document.createElement('input')),
      ),
    ).toBeNull();
  });
});
