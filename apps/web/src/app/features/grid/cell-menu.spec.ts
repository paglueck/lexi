// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { UnitCell, UnitDetail, UnitTarget } from '@lexi/shared';

import {
  cellMenuItems,
  missingLocales,
  plainText,
  selectionMenuItems,
  unitFiles,
  type CellMenuAction,
  type CellMenuContext,
} from './cell-menu.js';
import type { BulkCell } from './selection-actions.js';

/**
 * The grid's right-click menu. What it offers is a pure function of the unit's
 * state, so these pin the enable/disable rules — the part a screenshot shows
 * but does not check.
 */

const target = (over: Partial<UnitTarget> = {}): UnitTarget => ({
  locale: 'de',
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

const detail = (targets: UnitTarget[], over: Partial<UnitDetail> = {}): UnitDetail => ({
  rowId: 'messagesinvoices',
  unitId: 'invoices',
  group: 'messages',
  customId: true,
  isIcu: false,
  sourceLocale: 'en-GB',
  source: [{ k: 't', v: 'You have invoices' }],
  notes: [],
  locations: [],
  targets,
  files: { de: 'messages.de.xlf', fr: 'messages.fr.xlf' },
  notesFile: 'messages.xlf',
  notesFileIsTemplate: true,
  notesPending: false,
  ...over,
});

const ctx = (
  over: Partial<CellMenuContext> & Pick<CellMenuContext, 'detail'>,
): CellMenuContext => ({
  kind: 'target',
  locale: 'de',
  editLocale: 'de',
  dirty: new Set(),
  configured: true,
  running: false,
  ...over,
});

const item = (items: ReturnType<typeof cellMenuItems>, action: CellMenuAction) =>
  items.find((i) => i.action === action);

const TEXT = [{ k: 't' as const, v: 'Sie haben Rechnungen' }];

describe('cellMenuItems — a target cell', () => {
  it('offers the cell actions, with clear and approve off on an empty cell', () => {
    const items = cellMenuItems(ctx({ detail: detail([target()]) }));
    expect(items.map((i) => i.action)).toEqual([
      'edit',
      'translate',
      'copy-source',
      'approve',
      'revert',
      'copy-text',
      'clear',
      'remove-notes',
      'delete',
    ]);
    expect(item(items, 'translate')?.disabled).toBe(false);
    expect(item(items, 'clear')?.disabled).toBe(true);
    expect(item(items, 'copy-text')?.disabled).toBe(true);
    expect(item(items, 'approve')?.disabled).toBe(true);
    expect(item(items, 'revert')?.disabled).toBe(true);
  });

  it('offers approve only for a machine draft or a needs-review string', () => {
    for (const state of ['draftMachine', 'needsReview'] as const) {
      const items = cellMenuItems(ctx({ detail: detail([target({ state, segments: TEXT })]) }));
      expect(item(items, 'approve')?.disabled).toBe(false);
    }
    const human = cellMenuItems(
      ctx({ detail: detail([target({ state: 'final', segments: TEXT })]) }),
    );
    expect(item(human, 'approve')?.disabled).toBe(true);
    expect(item(human, 'translate')?.label).toBe('Re-translate cell');
    expect(item(human, 'clear')?.disabled).toBe(false);
  });

  it('turns revert on for a cell with an unsaved edit', () => {
    const items = cellMenuItems(ctx({ detail: detail([target()]), dirty: new Set(['de']) }));
    expect(item(items, 'revert')?.disabled).toBe(false);
  });

  it('says why translate is off without a model, or while one is running', () => {
    const off = cellMenuItems(ctx({ detail: detail([target()]), configured: false }));
    expect(item(off, 'translate')?.disabled).toBe(true);
    expect(item(off, 'translate')?.hint).toContain('Settings');
    const busy = cellMenuItems(ctx({ detail: detail([target()]), running: true }));
    expect(item(busy, 'translate')?.disabled).toBe(true);
  });

  it('disables every write for a locale with no file', () => {
    const items = cellMenuItems(ctx({ detail: detail([target({ noFile: true })]) }));
    for (const action of ['edit', 'translate', 'copy-source', 'clear'] as const) {
      expect(item(items, action)?.disabled).toBe(true);
    }
  });
});

describe('cellMenuItems — the source cell', () => {
  it('copies the source, and into the locale being edited', () => {
    const items = cellMenuItems(
      ctx({ kind: 'source', locale: null, editLocale: 'de', detail: detail([target()]) }),
    );
    expect(items.map((i) => i.label)).toEqual([
      'Copy source text',
      'Copy source → de',
      'Remove note',
      'Delete key',
    ]);
  });

  it('only copies the text when no locale is being edited', () => {
    const items = cellMenuItems(
      ctx({ kind: 'source', locale: null, editLocale: null, detail: detail([target()]) }),
    );
    expect(items.map((i) => i.action)).toEqual(['copy-source-text', 'remove-notes', 'delete']);
  });
});

describe('cellMenuItems — the unit id', () => {
  const unit = detail([
    target({ locale: 'de', state: 'final', segments: TEXT }),
    target({ locale: 'fr' }),
    target({ locale: 'pl', noFile: true }),
    target({ locale: 'it' }),
  ]);

  it('counts the missing languages — never one with no file to write to', () => {
    expect(missingLocales(unit)).toEqual(['fr', 'it']);
    const items = cellMenuItems(ctx({ kind: 'id', locale: null, detail: unit }));
    expect(item(items, 'translate-missing')).toMatchObject({
      label: 'Translate 2 missing languages',
      disabled: false,
    });
  });

  it('turns translate-missing off when nothing is missing or there is no model', () => {
    const done = detail([target({ locale: 'de', state: 'final', segments: TEXT })]);
    expect(
      item(cellMenuItems(ctx({ kind: 'id', locale: null, detail: done })), 'translate-missing')
        ?.disabled,
    ).toBe(true);
    expect(
      item(
        cellMenuItems(ctx({ kind: 'id', locale: null, detail: unit, configured: false })),
        'translate-missing',
      )?.disabled,
    ).toBe(true);
  });

  it('offers revert-all only with unsaved edits, and clear-all only with text', () => {
    const items = cellMenuItems(ctx({ kind: 'id', locale: null, detail: unit }));
    expect(item(items, 'revert-all')?.disabled).toBe(true);
    expect(item(items, 'clear-all')?.disabled).toBe(false);
    expect(item(items, 'delete')).toMatchObject({ disabled: false, danger: true });

    const dirty = cellMenuItems(
      ctx({ kind: 'id', locale: null, detail: unit, dirty: new Set(['fr']) }),
    );
    expect(item(dirty, 'revert-all')?.disabled).toBe(false);
  });
});

describe('Delete key…', () => {
  const unit = detail([target({ locale: 'de' })]);

  it('is offered on every kind of cell, last and marked dangerous', () => {
    for (const over of [
      { kind: 'target' as const, locale: 'de' },
      { kind: 'source' as const, locale: null },
      { kind: 'id' as const, locale: null },
    ]) {
      const items = cellMenuItems(ctx({ ...over, detail: unit }));
      expect(items.at(-1)).toMatchObject({ action: 'delete', disabled: false, danger: true });
    }
  });

  it('is disabled when the unit is in no file at all', () => {
    const nowhere = detail([target({ locale: 'de', missing: true })], { notesFile: null });
    const items = cellMenuItems(ctx({ kind: 'source', locale: null, detail: nowhere }));
    expect(item(items, 'delete')?.disabled).toBe(true);
  });
});

describe('Remove notes', () => {
  const NOTE = { from: 'description', priority: '1', text: 'Shown on the checkout page' };

  it('is offered on every kind of cell, before delete, and marked dangerous', () => {
    const unit = detail([target({ locale: 'de' })], { notes: [NOTE] });
    for (const over of [
      { kind: 'target' as const, locale: 'de' },
      { kind: 'source' as const, locale: null },
      { kind: 'id' as const, locale: null },
    ]) {
      const items = cellMenuItems(ctx({ ...over, detail: unit }));
      expect(items.at(-2)).toMatchObject({
        action: 'remove-notes',
        label: 'Remove note',
        disabled: false,
        danger: true,
      });
    }
  });

  it('counts several notes in its label', () => {
    const unit = detail([target()], { notes: [NOTE, { ...NOTE, from: 'meaning' }] });
    expect(item(cellMenuItems(ctx({ detail: unit })), 'remove-notes')?.label).toBe(
      'Remove 2 notes',
    );
  });

  it('is off without notes, and for an orphan that has nowhere to keep them', () => {
    const none = cellMenuItems(ctx({ detail: detail([target()]) }));
    expect(item(none, 'remove-notes')).toMatchObject({
      disabled: true,
      hint: 'This unit has no notes',
    });
    const orphan = cellMenuItems(
      ctx({ detail: detail([target()], { notes: [NOTE], notesFile: null }) }),
    );
    expect(item(orphan, 'remove-notes')?.disabled).toBe(true);
  });
});

describe('selectionMenuItems', () => {
  const cell = (over: Partial<UnitCell> = {}): UnitCell => ({
    state: 'untranslated',
    error: false,
    missing: false,
    segments: [],
    ...over,
  });
  const bulk = (rowId: string, locale: string, c?: UnitCell, dirty = false): BulkCell => ({
    rowId,
    locale,
    cell: c,
    dirty,
  });
  const cells: BulkCell[] = [
    bulk('a', 'de', cell({ state: 'draftMachine', segments: TEXT })),
    bulk('a', 'fr', cell({ state: 'needsReview', segments: TEXT }), true),
    bulk('b', 'de', cell({ state: 'reviewed', segments: TEXT })),
    bulk('b', 'fr', cell({ missing: true })),
    bulk('c', 'de', undefined),
  ];

  it('names how many cells or units each action will touch', () => {
    const items = selectionMenuItems({ cells, configured: true });
    expect(items.map((i) => [i.action, i.label, i.disabled])).toEqual([
      ['translate-cells', 'Translate 4 cells', false],
      ['approve-cells', 'Approve 2 cells', false],
      ['revert-cells', 'Revert 1 unsaved edit', false],
      ['clear-cells', 'Clear 3 translations', false],
      ['remove-notes-cells', 'Remove notes of 2 units', false],
      ['delete-cells', 'Delete 2 keys', false],
    ]);
  });

  it('turns an action off when no marked cell qualifies, and translate off without a model', () => {
    const plain = [bulk('a', 'de', cell()), bulk('b', 'de', cell())];
    const items = selectionMenuItems({ cells: plain, configured: false });
    expect(item(items, 'translate-cells')).toMatchObject({ disabled: true });
    expect(item(items, 'approve-cells')?.disabled).toBe(true);
    expect(item(items, 'revert-cells')?.disabled).toBe(true);
    expect(item(items, 'clear-cells')?.disabled).toBe(true);
    expect(item(items, 'remove-notes-cells')?.disabled).toBe(false);
    expect(item(items, 'delete-cells')?.disabled).toBe(false);
  });

  it('offers no unit action when no marked row could be read', () => {
    const items = selectionMenuItems({ cells: [bulk('c', 'de', undefined)], configured: true });
    expect(item(items, 'remove-notes-cells')?.disabled).toBe(true);
    expect(item(items, 'delete-cells')).toMatchObject({ label: 'Delete 0 keys', disabled: true });
  });

  it('marks the destructive ones dangerous', () => {
    const items = selectionMenuItems({ cells, configured: true });
    expect(items.filter((i) => i.danger).map((i) => i.action)).toEqual([
      'clear-cells',
      'remove-notes-cells',
      'delete-cells',
    ]);
  });
});

describe('unitFiles', () => {
  it('lists the source file and each locale file the unit is actually in', () => {
    const d = detail([target({ locale: 'de' }), target({ locale: 'fr', missing: true })]);
    expect(unitFiles(d)).toEqual(['messages.xlf', 'messages.de.xlf']);
  });

  it('has no source file for an orphan', () => {
    expect(unitFiles(detail([target({ locale: 'de' })], { notesFile: null }))).toEqual([
      'messages.de.xlf',
    ]);
  });
});

describe('plainText', () => {
  it('writes placeholders as their display text', () => {
    expect(
      plainText([
        { k: 't', v: 'You have ' },
        { k: 'p', id: 'INTERPOLATION', equivText: '{{ count }}' },
        { k: 't', v: ' invoices' },
      ] as never),
    ).toBe('You have {{ count }} invoices');
  });
});
