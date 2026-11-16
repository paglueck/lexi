// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ServerConfig } from '../config.js';
import { readLexiJson, writeLexiJson } from './lexi-dir.js';
import { buildTarget, countFindings, dtoContextOf, sourceSegmentsOf } from './unit-dto.js';
import {
  toEditSegments,
  rebuildSegments,
  vocabularyOf,
  UnknownPlaceholderError,
} from './wire-segments.js';
import { resolveTargetCell } from './target-cell.js';
import { sourceOf } from './commit.js';
import type { ProjectService } from '../services/project-service.js';
import type { EditSegmentDto, UnitState } from '@lexi/shared';
import type { NoteSpec } from '@lexi/xliff';
import { fileNotesOf, sameNotes } from './notes.js';

/**
 * `.lexi/drafts.json` — the dirty buffer, on disk.
 *
 * NFR-4 says a crash loses nothing, and the whole point of the overlay is that
 * the user's files stay untouched until they say so; those two together mean the
 * uncommitted edits have to live somewhere durable that is not the XLIFF.
 *
 * Stored in the WIRE segment form — ids and text, no `raw`. The bytes are
 * re-attached on load exactly the way a PATCH re-attaches them, which is what
 * makes the file portable and reviewable, and means there is only one
 * re-attachment path to get right.
 */

const FILE = 'drafts.json';

interface DraftEntry {
  readonly rowId: string;
  readonly locale: string;
  readonly unitId: string;
  readonly segments: readonly EditSegmentDto[];
  readonly state: UnitState;
  readonly at: string;
}

/** A row's unsaved note edit (FR-4.2): the list it should read, and the one it was based on. */
interface NotesEntry {
  readonly rowId: string;
  readonly unitId: string;
  readonly original: readonly NoteSpec[];
  readonly notes: readonly NoteSpec[];
  readonly at: string;
}

interface DraftsFile {
  readonly version: 1;
  readonly drafts: readonly DraftEntry[];
  /** Optional, so a drafts.json from before note editing still reads. */
  readonly notes?: readonly NotesEntry[];
}

export async function writeDrafts(cfg: ServerConfig, projects: ProjectService): Promise<void> {
  const project = projects.current;
  if (!project) return;

  const drafts: DraftEntry[] = [...projects.pending.values()].map((edit) => ({
    rowId: edit.rowId,
    locale: edit.locale,
    unitId: edit.unitId,
    segments: toEditSegments(edit.segments),
    state: edit.state,
    at: edit.at,
  }));

  const notes: NotesEntry[] = [...projects.pendingNotes.values()].map((edit) => ({
    rowId: edit.rowId,
    unitId: edit.unitId,
    original: edit.original,
    notes: edit.notes,
    at: edit.at,
  }));

  const file: DraftsFile = { version: 1, drafts, ...(notes.length > 0 ? { notes } : {}) };
  await writeLexiJson(cfg, project.path, FILE, file).catch(() => {
    // A buffer that could not be persisted must not take the edit down with it.
    // The edit is already in memory and the user can still save.
  });
}

export interface DraftRestore {
  readonly restored: number;
  /** Drafts dropped because the unit or its placeholders no longer exist. */
  readonly dropped: number;
}

/**
 * Re-apply the buffer after a restart.
 *
 * A draft whose placeholder ids no longer resolve is DROPPED, not repaired. It
 * was written against a source that has since changed, and splicing it anyway
 * would put a translation next to text it was never written for — silently. The
 * count is returned so the caller can say so rather than lose it quietly.
 */
export async function restoreDrafts(projects: ProjectService): Promise<DraftRestore> {
  const project = projects.current;
  const index = projects.index;
  if (!project || !index) return { restored: 0, dropped: 0 };

  const file = await readLexiJson<DraftsFile>(project.path, FILE);
  // `as unknown` because `Array.isArray` narrows a readonly array to `any[]`,
  // which would untype every entry below. The file is ours but may be stale.
  if (file === null || !Array.isArray(file.drafts as unknown)) return { restored: 0, dropped: 0 };

  let restored = 0;
  let dropped = 0;

  for (const entry of file.drafts) {
    const row = index.byRowId.get(entry.rowId);
    if (!row) {
      dropped += 1;
      continue;
    }
    // Re-resolved rather than read back from the file: whether the unit still
    // has to be created is a fact about the project as it is NOW. Somebody may
    // have added it in the meantime, in which case this is an ordinary edit.
    let cell;
    try {
      cell = resolveTargetCell(project, index, row, entry.locale);
    } catch {
      dropped += 1;
      continue;
    }
    const from = sourceOf(cell);
    const vocabulary = vocabularyOf(from.doc.raw, from.source.innerSpan, from.target?.innerSpan);
    try {
      projects.setPending({
        rowId: entry.rowId,
        locale: entry.locale,
        path: cell.doc.path,
        unitId: cell.kind === 'existing' ? cell.unit.id : row.unitId,
        segments: rebuildSegments(entry.segments, vocabulary),
        state: entry.state,
        at: entry.at,
        ...(cell.kind === 'create' ? { create: true } : {}),
      });
      restored += 1;
    } catch (error) {
      if (error instanceof UnknownPlaceholderError) dropped += 1;
      else throw error;
    }
  }

  const notes = Array.isArray(file.notes as unknown) ? (file.notes ?? []) : [];
  for (const entry of notes) {
    if (reattachNotes(projects, entry)) restored += 1;
    else dropped += 1;
  }
  return { restored, dropped };
}

/**
 * Put a note edit back over the row it was made on — only if the file still
 * says what it said then. Notes written on top of notes that changed underneath
 * (a `git pull`, a re-extraction) would overwrite somebody's context silently;
 * dropped and counted instead, exactly like a target draft whose source moved.
 */
function reattachNotes(
  projects: ProjectService,
  entry: Pick<NotesEntry, 'rowId' | 'original' | 'notes' | 'at'>,
): boolean {
  const row = projects.index?.byRowId.get(entry.rowId);
  if (!row?.sourceUnit || !row.sourceDoc || !sameNotes(fileNotesOf(row), entry.original)) {
    projects.clearPendingNotes(entry.rowId);
    return false;
  }
  projects.setPendingNotes({
    rowId: entry.rowId,
    path: row.sourceDoc.path,
    unitId: row.sourceUnit.id,
    original: entry.original,
    notes: entry.notes,
    at: entry.at,
  });
  return true;
}

/**
 * Re-check the IN-MEMORY buffer against a row model that has just been rebuilt.
 *
 * The reload path's counterpart to `restoreDrafts` (FR-1.5). After `git pull`
 * the documents are new objects: a pending edit's unit may be gone, and its
 * placeholders may no longer exist in the source it was written against. The
 * spans it carries are meaningless either way, because the raw text it was cut
 * from has been replaced.
 *
 * So each surviving edit is re-attached to the NEW bytes — same mechanism as a
 * PATCH — and the ones that cannot be are dropped, with a count the caller can
 * put in front of the user. Silently keeping them would mean saving a
 * translation over a string that has changed underneath it.
 */
export function revalidateDrafts(projects: ProjectService): DraftRestore {
  const index = projects.index;
  if (!projects.current || !index) return { restored: 0, dropped: 0 };

  let restored = 0;
  let dropped = 0;

  for (const edit of [...projects.pending.values()]) {
    const row = index.byRowId.get(edit.rowId);
    if (!row || projects.current === null) {
      projects.clearPending(edit.rowId, edit.locale);
      dropped += 1;
      continue;
    }
    let cell;
    try {
      cell = resolveTargetCell(projects.current, index, row, edit.locale);
    } catch {
      projects.clearPending(edit.rowId, edit.locale);
      dropped += 1;
      continue;
    }
    const from = sourceOf(cell);
    const vocabulary = vocabularyOf(from.doc.raw, from.source.innerSpan, from.target?.innerSpan);
    try {
      projects.setPending({
        ...edit,
        path: cell.doc.path,
        unitId: cell.kind === 'existing' ? cell.unit.id : row.unitId,
        segments: rebuildSegments(toEditSegments(edit.segments), vocabulary),
        // A unit somebody else added since is no longer ours to create.
        ...(cell.kind === 'create' ? { create: true } : { create: false }),
      });
      restored += 1;
    } catch (error) {
      if (!(error instanceof UnknownPlaceholderError)) throw error;
      projects.clearPending(edit.rowId, edit.locale);
      dropped += 1;
    }
  }

  for (const edit of [...projects.pendingNotes.values()]) {
    if (reattachNotes(projects, edit)) restored += 1;
    else dropped += 1;
  }
  return { restored, dropped };
}

/**
 * Re-apply every pending edit to the row model's derived half.
 *
 * `setPending` fills the overlay, which is what the grid rows and the detail
 * panel read — but the INDEX cells are what the filters, the facet counts and
 * the dashboard's six counters read, and a freshly built index knows only what
 * is in the files. Without this, reopening a project with a dirty buffer showed
 * the drafts in the grid and pre-draft figures on the dashboard, from the same
 * request. `patchCell` is the same call the PATCH route makes; this is just the
 * bulk version of it, for the two moments the index is built from scratch
 * underneath an existing buffer.
 */
export function syncPendingIntoIndex(projects: ProjectService): void {
  const index = projects.index;
  if (!index) return;
  const ctx = dtoContextOf(projects);

  for (const edit of projects.pending.values()) {
    const row = index.byRowId.get(edit.rowId);
    if (!row) continue;
    const target = buildTarget(row, edit.locale, ctx, sourceSegmentsOf(row));
    index.patchCell(edit.rowId, edit.locale, {
      state: edit.state,
      ...countFindings(target.findings, ctx.ignoredOf(row, edit.locale)),
      targetLower: target.segments
        .map((seg) => (seg.k === 't' ? seg.v : ''))
        .join('')
        .toLowerCase(),
    });
  }
  for (const edit of projects.pendingNotes.values()) index.patchNotes(edit.rowId, edit.notes);
}
