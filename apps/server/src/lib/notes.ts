// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { NoteSpec, TransUnit } from '@lexi/xliff';

import type { IndexedRow } from '../services/unit-index.js';
import type { PendingNotes } from '../services/project-service.js';

/**
 * Notes, as every reader of them should see them (FR-4.2).
 *
 * Notes live on the SOURCE unit — that is where Angular writes them and where
 * the panel, the prompt, search and note coverage have always read them. A
 * pending edit (not saved yet) replaces them for all of those readers at once,
 * so the model is never drafting against a note the panel no longer shows.
 */

/** A scanned `<note>` in the editor's vocabulary. */
export const specOf = (note: TransUnit['notes'][number]): NoteSpec => ({
  from: note.attrs['from'] ?? null,
  priority: note.attrs['priority'] ?? null,
  text: note.text,
});

/**
 * What the file says. Falls back to the first locale cell for an orphan, which
 * is what the index has always done for "has a note".
 */
export function fileNotesOf(row: IndexedRow): NoteSpec[] {
  const unit = row.sourceUnit ?? [...row.cells.values()][0]?.unit;
  return (unit?.notes ?? []).map(specOf);
}

/** What every reader should see: the pending edit if there is one, else the file. */
export function effectiveNotes(
  row: IndexedRow,
  pendingFor: (rowId: string) => PendingNotes | undefined,
): readonly NoteSpec[] {
  return pendingFor(row.rowId)?.notes ?? fileNotesOf(row);
}

export const sameNotes = (a: readonly NoteSpec[], b: readonly NoteSpec[]): boolean =>
  a.length === b.length &&
  a.every(
    (n, i) => n.text === b[i]?.text && n.from === b[i]?.from && n.priority === b[i]?.priority,
  );
