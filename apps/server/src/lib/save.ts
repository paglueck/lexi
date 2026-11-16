// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  assertNotStale,
  composeSegments,
  insertUnit,
  saveDocument,
  shouldWriteState,
  unitSkeleton,
  writeNotes,
  writeTarget,
  xliffStateFor,
  type Edit,
  type LoadedDocument,
  type TransUnit,
  type WriteStateMode,
  type XlfFile,
} from '@lexi/xliff';
import type { SaveResponse } from '@lexi/shared';

import { notFound } from './http-error.js';
import { resolveTargetCell } from './target-cell.js';
import { writeDrafts } from './drafts.js';
import { sameNotes, specOf } from './notes.js';
import type { EventBus } from './event-bus.js';
import type { ServerConfig } from '../config.js';
import type { PendingEdit, PendingNotes, ProjectService } from '../services/project-service.js';

/** One (row, locale) cell, the unit a cell-scoped save is asked for in. */
export interface SaveCell {
  readonly rowId: string;
  readonly locale: string;
}

/**
 * Which pending work a save writes. Neither field means all of it, which is
 * what `POST /api/save` without `paths` does; both narrow together.
 */
export interface SaveOptions {
  /** Only these documents. Empty or absent means every document with pending work. */
  readonly paths?: readonly string[] | undefined;
  /**
   * Only these cells' pending target edits — the CSV import's write.
   *
   * The import has to put the reviewed cells on disk without taking the
   * translator's OTHER unsaved work with them, so everything outside the list
   * stays in the overlay: other cells' edits, in this file or any other, and
   * every pending note edit, even one in a file this save rewrites.
   */
  readonly cells?: readonly SaveCell[] | undefined;
}

/**
 * Save (FR-1.6, NFR-4, NFR-8) — the body of `POST /api/save`, and of the CSV
 * import's cell-scoped write.
 *
 * One `Edit[]` per document, applied in a single splice, so the units in a file
 * are written together and their spans cannot interfere — `applyEdits` asserts
 * on overlap, and unit spans are disjoint by construction.
 *
 * Serialized against other saves: `saveDocument` checks the file on disk and
 * then writes, and those two steps are not atomic against a concurrent writer.
 */
export async function saveProject(
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
  opts: SaveOptions,
): Promise<SaveResponse> {
  const project = projects.current;
  if (!project) throw notFound('no project is open');

  const wanted = new Set(opts.paths ?? []);
  const byPath = projects.pendingByPath();
  // Note edits (FR-4.2) go to the source file, target edits to locale files —
  // so they rarely share a path, but the loop is per FILE either way, and a
  // file touched only by notes must still be written.
  const notesByPath = new Map<string, PendingNotes[]>();
  if (opts.cells === undefined) {
    for (const edit of projects.pendingNotes.values()) {
      const list = notesByPath.get(edit.path);
      if (list === undefined) notesByPath.set(edit.path, [edit]);
      else list.push(edit);
    }
    for (const path of notesByPath.keys()) if (!byPath.has(path)) byPath.set(path, []);
  } else {
    // Narrowed BEFORE the loop, so a file is written only when one of the
    // named cells is in it, and only those cells are composed into it and
    // cleared from the overlay afterwards.
    const named = new Map<string, Set<string>>();
    for (const { rowId, locale } of opts.cells) {
      const locales = named.get(rowId);
      if (locales === undefined) named.set(rowId, new Set([locale]));
      else locales.add(locale);
    }
    for (const [path, edits] of byPath) {
      const kept = edits.filter((e) => named.get(e.rowId)?.has(e.locale) === true);
      if (kept.length > 0) byPath.set(path, kept);
      else byPath.delete(path);
    }
  }

  return projects.serializeSave(async () => {
    const written: string[] = [];
    const skipped: string[] = [];
    /** Each document's edits, composed before any of them is written. */
    const work: { path: string; doc: LoadedDocument; edits: PendingEdit[]; docEdits: Edit[] }[] =
      [];

    for (const [path, edits] of byPath) {
      if (wanted.size > 0 && !wanted.has(path)) continue;
      const doc = project.documents.get(path);
      if (doc === undefined) continue;

      const docEdits: Edit[] = [];
      /**
       * Insertions, collected by the offset they go at rather than emitted
       * one by one (FR-1.9).
       *
       * Two units created against the same anchor — which is the normal case
       * for two adjacent untranslated strings, since neither is in the file
       * yet to anchor the other — would otherwise be two zero-width edits at
       * one offset, and `applyEdits` refuses those: their relative order would
       * silently decide the output. Joining them here keeps that refusal
       * meaningful AND puts the units in source order.
       */
      const insertions = new Map<number, string[]>();

      for (const pending of edits) {
        const inner = composeSegments(pending.segments, project.escapePolicy);

        if (pending.create === true) {
          const created = createdUnitEdit(projects, project, doc, pending, inner);
          if (created === undefined) continue;
          const list = insertions.get(created.at);
          if (list === undefined) insertions.set(created.at, [created.text]);
          else list.push(created.text);
          continue;
        }

        const unit = findUnit(doc, pending.unitId);
        if (unit === undefined) continue;
        const file = fileOf(doc, unit);

        // `auto` writes `state` only into files that already use it. With this
        // project confirmed NOT to use ng-extract-i18n-merge, that resolves to
        // "never introduce one" — the cheapest NFR-8 protection in the design,
        // and the first thing a save path is likely to undo.
        const writes = file !== undefined && shouldWriteState(project.writeState, file);
        const state = writes ? xliffStateFor(pending.state) : undefined;
        docEdits.push(
          ...writeTarget(doc, unit, inner, {
            ...(state === undefined ? {} : { state }),
            ...targetLanguageOf(file),
          }),
        );
      }

      for (const edit of notesByPath.get(path) ?? []) {
        const unit = findUnit(doc, edit.unitId);
        // The file moved under the edit since it was made: a reload would have
        // dropped it, so this is only a race — skip rather than overwrite.
        if (unit === undefined || !sameNotes(unit.notes.map(specOf), edit.original)) continue;
        docEdits.push(...writeNotes(doc, unit, edit.notes, project.escapePolicy));
      }

      for (const [at, parts] of insertions) {
        docEdits.push({
          span: { start: at, end: at },
          replacement: parts.join(''),
          reason: `insert ${parts.length} new unit${parts.length === 1 ? '' : 's'}`,
        });
      }

      work.push({ path, doc, edits, docEdits });
    }

    // Every file is checked against disk before the first is written, so a
    // file changed under the save refuses the whole save rather than leaving
    // the files before it written and the ones after it not. Only a real I/O
    // failure can still stop a save halfway; see `PartialSaveError`.
    for (const { doc, docEdits } of work) {
      if (docEdits.length > 0) await assertNotStale(doc);
    }

    try {
      for (const { path, doc, edits, docEdits } of work) {
        const result = await saveDocument(doc, docEdits);
        if (result.written) {
          written.push(path);
          await projects.reloadDocument(path);
        } else {
          skipped.push(path);
        }
        for (const pending of edits) projects.clearPending(pending.rowId, pending.locale);
        for (const edit of notesByPath.get(path) ?? []) projects.clearPendingNotes(edit.rowId);
      }
    } catch (error) {
      if (written.length === 0) throw error;
      // Some files are on disk already: the session has to agree with them
      // before anyone hears about the failure, or the index would go on
      // pointing into documents that no longer exist.
      await settle();
      throw new PartialSaveError(written, error);
    }

    const at = await settle();
    return {
      written,
      skipped,
      at,
      unsavedCount: projects.unsavedCount,
    };

    async function settle(): Promise<string> {
      // Spans moved under every row in a written file, so the row model has to be
      // rebuilt rather than patched. Only on save — which is a human-paced event,
      // unlike a keystroke.
      //
      // Edits still pending afterwards (everything a cell-scoped save left alone)
      // need nothing more. The overlay carries no spans: a pending edit is a unit
      // id plus the bytes it will write, found again by id at the next save, and
      // `rebuildIndex` re-patches the index from the overlay itself. They are
      // deliberately NOT re-cut through the reload's `revalidateDrafts`: that
      // round-trips text through wire segments, which drops the file's own
      // escaping, so a copy-source `&#160;` would come back as a literal NBSP.
      if (written.length > 0) projects.rebuildIndex();
      // Undo covers unsaved work only, and the snapshots' bytes predate the write.
      // That holds for a cell-scoped save too: the edits it left pending survive,
      // but a step that would put back pre-save bytes for a cell now on disk
      // would undo a write the history knows nothing about.
      projects.clearHistory();
      await writeDrafts(cfg, projects);

      const at = new Date().toISOString();
      bus.publish({ type: 'save-complete', written, at });
      return at;
    }
  });
}

/**
 * A save that wrote some files and then failed on another — an I/O error,
 * since a stale file is refused before anything is written.
 *
 * The session already matches the files that were written (index rebuilt,
 * their pending edits cleared, history cleared); `written` names them so the
 * caller can tell its user, and the CSV import can keep what landed.
 */
export class PartialSaveError extends Error {
  constructor(
    readonly written: readonly string[],
    override readonly cause: unknown,
  ) {
    super(
      `Saved ${written.length} file${written.length === 1 ? '' : 's'}, then failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'PartialSaveError';
  }
}

/**
 * The locale a file translates into, as `writeTarget` wants it.
 *
 * Read off the file's own `target-language` rather than from the project's
 * locale mapping, so a `<target xml:lang>` can never disagree with the
 * `<file target-language>` three lines above it. A file that declares no
 * target language gets nothing, and its `xml:lang` attributes are left exactly
 * as they are — there is nothing to correct them TO.
 */
function targetLanguageOf(file: XlfFile | undefined): { targetLanguage?: string } {
  const language = file?.attrs['target-language'];
  return language === undefined || language === '' ? {} : { targetLanguage: language };
}

/** The unit with this id inside an already-loaded document. */
function findUnit(doc: LoadedDocument, unitId: string): TransUnit | undefined {
  for (const file of doc.files) {
    for (const unit of file.units) if (unit.id === unitId) return unit;
  }
  return undefined;
}

function fileOf(doc: LoadedDocument, unit: TransUnit): XlfFile | undefined {
  return doc.files.find((file) => file.units.includes(unit));
}

/**
 * The text and the offset for a `<trans-unit>` that has to be created (FR-1.9).
 *
 * The unit is copied out of the SOURCE file — `<source>`, notes and
 * `<context-group>`s included — with the translation spliced into the copy, and
 * placed after the nearest earlier unit this locale already has so the file
 * keeps the source file's order rather than growing in click order.
 *
 * Returns undefined when the row or the source unit has gone since the edit was
 * committed, which is the same conservative answer the non-create path gives to
 * a unit id it can no longer find.
 */
function createdUnitEdit(
  projects: ProjectService,
  project: { writeState: WriteStateMode },
  doc: LoadedDocument,
  pending: PendingEdit,
  inner: string,
): { at: number; text: string } | undefined {
  const row = projects.index?.byRowId.get(pending.rowId);
  if (row === undefined || projects.current === null) return undefined;

  let cell;
  try {
    cell = resolveTargetCell(projects.current, projects.index!, row, pending.locale);
  } catch {
    return undefined;
  }
  // Somebody else added the unit in the meantime — a `git pull`, or another
  // save. Then this is an ordinary target write, not a creation, and skipping
  // it here lets the next save do it properly rather than inserting a duplicate.
  if (cell.kind !== 'create' || cell.doc !== doc) return undefined;

  const state = shouldWriteState(project.writeState, cell.file)
    ? xliffStateFor(pending.state)
    : undefined;

  const xml = unitSkeleton(cell.sourceDoc, cell.sourceUnit, inner, {
    ...(state === undefined ? {} : { state }),
    // The unit is copied out of the SOURCE file, whose `<target xml:lang>` says
    // the source language. Without this the created unit would declare its
    // translation to be English (reported from use).
    ...targetLanguageOf(cell.file),
  });
  const [edit] = insertUnit(doc, cell.file, xml, cell.after);
  if (edit === undefined) return undefined;
  return { at: edit.span.start, text: edit.replacement };
}
