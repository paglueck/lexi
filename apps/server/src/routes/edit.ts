// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  StaleFileError,
  composeSegments,
  deleteUnit,
  insertUnit,
  insertionAnchor,
  newNotePriority,
  sourceUnitXml,
  type NoteSpec,
  saveDocument,
  segmentsOf,
  type LoadedDocument,
  type Segment,
  type TransUnit,
  type UnitState,
} from '@lexi/xliff';
import {
  BulkApproveRequestSchema,
  FilesReloadRequestSchema,
  NotesPutRequestSchema,
  SaveRequestSchema,
  TargetPatchRequestSchema,
  UnitCreateRequestSchema,
  rowIdOf,
  type BulkApproveResponse,
  type FilesReloadResponse,
  type NotesPutResponse,
  type ReviewDecision,
  type ReviewPatch,
  type SaveResponse,
  type TargetPatchResponse,
  type UnitCreateResponse,
  type UnitDeleteResponse,
} from '@lexi/shared';

import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { dtoContextOf, effectiveSegments, toWireDetail } from '../lib/unit-dto.js';
import {
  commitTarget,
  editableCell,
  refreshIndexCell,
  sourceOf,
  openRow as openRowIn,
} from '../lib/commit.js';
import { StepRecorder } from '../lib/history.js';
import {
  forgetMachineOrigin,
  originKey,
  targetHash,
  writeMachineOrigins,
} from '../lib/machine-origin.js';
import { saveProject } from '../lib/save.js';
import { classifyReviewOutcome, writeReviewStats } from '../lib/review-stats.js';
import { writeReviewNotes } from '../lib/review-notes.js';
import {
  UnknownPlaceholderError,
  rebuildSegments,
  vocabularyOf,
  type PlaceholderVocabulary,
} from '../lib/wire-segments.js';
import { revalidateDrafts, syncPendingIntoIndex, writeDrafts } from '../lib/drafts.js';
import { fileNotesOf, sameNotes } from '../lib/notes.js';
import type { EventBus } from '../lib/event-bus.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';
import type { IndexedRow } from '../services/unit-index.js';

/**
 * Editing and saving (M6).
 *
 * THIS IS THE ONLY PLACE IN THE SERVER THAT WRITES INTO A USER'S REPOSITORY, and
 * it lives in its own file so that stays true and visible. The save itself is
 * in `lib/save.ts`, so the CSV import can write through the same code path
 * rather than a second one. Everything else under
 * `routes/` is read-only, and `.lexi/` is the only other thing anything writes.
 *
 * The shape of the write path, and why each step is there:
 *
 *   client segments (ids + text, never a byte of the file)
 *     -> rebuildSegments, which re-attaches the original bytes by placeholder id
 *     -> verifyComposable, which scans the composed bytes back and checks they
 *        read as the placeholders that went in
 *     -> an OVERLAY entry; the document is not touched
 *     -> patchCell, so the grid, the rail and the dashboard move immediately
 *   ... and only on save:
 *     -> composeSegments -> writeTarget -> saveDocument (atomic, stale-checked)
 *
 * The save path is also the safety net: it refuses a target whose
 * placeholders do not match the source. That inversion is deliberate — it means
 * the editor only has to be pleasant, not perfect.
 *
 * One exception to "nothing touches the file until save": deleting a whole key
 * (`DELETE /api/units/:rowId`) writes at once — see the route for why.
 */
export function registerEdit(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
): void {
  const openRow = (rowId: string): IndexedRow => openRowIn(projects, rowId);

  /**
   * FR-7.4's edit rate — classify a commit against a machine draft BEFORE its
   * origin marker is forgotten, since afterwards there is nothing left to
   * compare against. A cell with no origin marker was never a machine draft,
   * so nothing is recorded — the metric's denominator is drafts only.
   */
  const recordReviewOutcome = async (
    rowId: string,
    locale: string,
    segments: Segment[],
    decision?: ReviewDecision,
  ): Promise<void> => {
    const project = projects.current;
    const origin = projects.machineOrigins.get(originKey(rowId, locale));
    if (!project || !origin) return;

    // A stated rejection is never "approved unchanged", however the bytes come
    // out. Without this, a model that reproduced the previous target verbatim
    // would submit that target back on a reject and hash equal to its own
    // draft — recording the rejection as a clean approval (M14). Every other
    // path, including every PATCH from the grid, keeps M12's hash comparison.
    const outcome =
      decision === 'reject'
        ? 'corrected'
        : classifyReviewOutcome(
            targetHash(composeSegments(segments, project.escapePolicy)),
            origin.hash,
          );
    projects.recordReviewOutcome(locale, outcome);
    await writeReviewStats(cfg, project.path, projects.reviewStats);
  };

  /**
   * S11's reject-reason chips (M14).
   *
   * Written in the same handler as the commit they describe, not by a second
   * call: a crash between two requests would otherwise leave a reason attached
   * to a rejection that never happened. Anything that is not a reject CLEARS
   * them — the string has been settled, and a stale complaint must not reach
   * the next draft of it. `setReviewReasons` reports whether the file actually
   * changed, so an ordinary edit (clearing nothing) costs no write.
   */
  const applyReviewReasons = async (
    rowId: string,
    locale: string,
    review: ReviewPatch | undefined,
  ): Promise<void> => {
    const project = projects.current;
    if (!project || review === undefined) return;
    const reasons = review.decision === 'reject' ? review.reasons : [];
    if (projects.setReviewReasons(rowId, locale, reasons)) {
      await writeReviewNotes(cfg, project.path, projects.reviewNotes);
    }
  };

  /**
   * The target a machine draft displaced, as the draft run recorded it.
   *
   * Read from the SERVER's snapshot rather than the request, because the whole
   * point is to put back the exact bytes that were there — a browser round trip
   * could only offer what it happens to be holding, and after a save it is not
   * holding anything at all. A snapshot whose placeholders the unit no longer
   * has is not restorable, and reads as "there was nothing here", which is what
   * the screen shows too (`previousDtoOf`).
   */
  const restoredPrevious = (
    rowId: string,
    locale: string,
    vocabulary: PlaceholderVocabulary,
  ): { segments: Segment[]; state: UnitState | undefined } => {
    const previous = projects.machineOrigins.get(originKey(rowId, locale))?.previous;
    if (!previous) return { segments: [], state: undefined };
    try {
      return { segments: rebuildSegments(previous.segments, vocabulary), state: previous.state };
    } catch (error) {
      if (error instanceof UnknownPlaceholderError) return { segments: [], state: undefined };
      throw error;
    }
  };

  app.patch('/api/units/:rowId/targets/:locale', async (req): Promise<TargetPatchResponse> => {
    const { rowId, locale } = req.params as { rowId: string; locale: string };
    const body = TargetPatchRequestSchema.parse(req.body ?? {});
    const row = openRow(rowId);
    const cell = editableCell(projects, row, locale);
    const step = new StepRecorder(projects, stepLabelOf(body.review?.decision));
    step.cell(rowId, locale);

    // For a unit the file does not have yet, the vocabulary is the SOURCE
    // file's: that is the text being copied across, and its placeholder bytes
    // are the ones the new unit will carry (FR-1.9).
    const from = sourceOf(cell);
    const vocabulary = vocabularyOf(from.doc.raw, from.source.innerSpan, from.target?.innerSpan);

    let segments: Segment[];
    let state = body.state;
    if (body.review?.decision === 'reject') {
      // Server-authoritative: the bytes AND the state come from the snapshot,
      // so a restored human translation goes back as what it was rather than
      // as `reviewed` — nobody reviewed it, the reviewer rejected something
      // else. An empty snapshot falls through to `stateForEdit`'s
      // `untranslated`, which is exactly M12's behaviour for a draft that
      // filled an empty cell.
      const restored = restoredPrevious(rowId, locale, vocabulary);
      segments = restored.segments;
      state = restored.state;
    } else {
      try {
        segments = rebuildSegments(body.segments, vocabulary);
      } catch (error) {
        if (error instanceof UnknownPlaceholderError) throw badRequest(error.message);
        throw error;
      }
    }

    // Both of these read the machine-origin marker, so both must run BEFORE it
    // is forgotten — after that there is nothing left to classify against and
    // nothing left to restore.
    await recordReviewOutcome(rowId, locale, segments, body.review?.decision);
    await applyReviewReasons(rowId, locale, body.review);
    const response = commitTarget(projects, row, locale, segments, state, cell);
    await forgetMachineOrigin(cfg, projects, rowId, locale);
    step.finish();
    await writeDrafts(cfg, projects);
    return { ...response, history: projects.historyStatus };
  });

  /**
   * Copy the source into the target (FR-3.12), for a string that is legitimately
   * the same in both languages.
   *
   * Done server-side with the source's OWN segments, so the text keeps its
   * original bytes and the copy is byte-identical rather than the result of a
   * decode/encode round trip through the browser.
   */
  app.post(
    '/api/units/:rowId/targets/:locale/copy-source',
    async (req): Promise<TargetPatchResponse> => {
      const { rowId, locale } = req.params as { rowId: string; locale: string };
      const row = openRow(rowId);
      const cell = editableCell(projects, row, locale);
      // The unit's own <source> where it has one, which is what makes an orphan
      // copyable; the source file's when the unit is not in this locale yet.
      const from = sourceOf(cell);
      const copied = segmentsOf(from.doc.raw, from.source.innerSpan);
      const step = new StepRecorder(projects, 'Copy source');
      step.cell(rowId, locale);
      await recordReviewOutcome(rowId, locale, copied);
      const response = commitTarget(projects, row, locale, copied, undefined, cell);
      await forgetMachineOrigin(cfg, projects, rowId, locale);
      step.finish();
      await writeDrafts(cfg, projects);
      return { ...response, history: projects.historyStatus };
    },
  );

  /**
   * Discard one uncommitted edit and go back to what is in the file.
   *
   * Deliberately does NOT forget a machine-origin marker (correction bundled
   * into M12): discarding a BUFFER never changes committed content, so the
   * marker is still accurate. Focus mode's Escape/revert makes this a frequent
   * path — forgetting it here would silently drop the `draftMachine` badge and
   * undercount FR-7.4's edit-rate denominator on every look-then-back-out.
   */
  app.delete(
    '/api/units/:rowId/targets/:locale/draft',
    async (req): Promise<TargetPatchResponse> => {
      const { rowId, locale } = req.params as { rowId: string; locale: string };
      const row = openRow(rowId);
      if (!row.cells.has(locale)) throw notFound(`this unit has no ${locale} column`);
      const step = new StepRecorder(projects, 'Revert');
      step.cell(rowId, locale);
      projects.clearPending(rowId, locale);
      const target = refreshIndexCell(projects, row, locale);
      if (target === undefined) throw notFound(`this unit has no ${locale} column`);
      step.finish();
      await writeDrafts(cfg, projects);
      return { target, unsavedCount: projects.unsavedCount, history: projects.historyStatus };
    },
  );

  /**
   * Delete a key — its `<trans-unit>` in the source file and in every locale
   * file — from the grid's unit-id context menu.
   *
   * THE ONE WRITE THAT IS NOT STAGED. Everything else here lands in the overlay
   * and waits for Save; a deletion has no sensible overlay form (the row would
   * have to be half there), so it goes to disk at once, behind the client's own
   * confirmation modal. It still goes through `saveDocument`, so a file changed
   * on disk since it was read is refused and reported in `skipped` rather than
   * overwritten, and it runs under `serializeSave` like any other save.
   *
   * Whatever the session was holding for the row goes with it: pending target
   * and note edits, machine-origin markers, review reasons. Every OTHER pending
   * edit survives — it is keyed by unit id, not by span, and is re-attached to
   * the rewritten files exactly as a reload would.
   */
  app.delete('/api/units/:rowId', async (req): Promise<UnitDeleteResponse> => {
    const { rowId } = req.params as { rowId: string };
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    const row = openRow(rowId);

    // One entry per document. The source locale is not normally a cell, but a
    // map keyed by path makes "the same file twice" impossible either way.
    const targets = new Map<string, { doc: LoadedDocument; unit: TransUnit }>();
    if (row.sourceDoc && row.sourceUnit) {
      targets.set(row.sourceDoc.path, { doc: row.sourceDoc, unit: row.sourceUnit });
    }
    for (const cell of row.cells.values()) {
      if (cell.doc && cell.unit) targets.set(cell.doc.path, { doc: cell.doc, unit: cell.unit });
    }

    return projects.serializeSave(async () => {
      const written: string[] = [];
      const skipped: string[] = [];

      for (const [path, { doc, unit }] of targets) {
        try {
          const result = await saveDocument(doc, deleteUnit(doc, unit));
          if (result.written) {
            written.push(path);
            await projects.reloadDocument(path);
          }
        } catch (error) {
          if (error instanceof StaleFileError) skipped.push(path);
          else throw error;
        }
      }

      let origins = false;
      let reasons = false;
      for (const locale of row.cells.keys()) {
        projects.clearPending(rowId, locale);
        origins = projects.clearMachineOrigin(rowId, locale) || origins;
        reasons = projects.setReviewReasons(rowId, locale, []) || reasons;
      }
      projects.clearPendingNotes(rowId);
      // The files moved under every snapshot (see lib/history.ts).
      projects.clearHistory();
      if (origins) await writeMachineOrigins(cfg, project.path, projects.machineOrigins);
      if (reasons) await writeReviewNotes(cfg, project.path, projects.reviewNotes);

      // The same tail as a reload: spans moved under every row in a written
      // file, so the index is rebuilt and the surviving drafts re-attached.
      if (written.length > 0) {
        projects.rebuildIndex();
        revalidateDrafts(projects);
        syncPendingIntoIndex(projects);
      }
      await writeDrafts(cfg, projects);

      bus.publish({ type: 'save-complete', written, at: new Date().toISOString() });
      return { written, skipped, unsavedCount: projects.unsavedCount };
    });
  });

  /**
   * Create a key — a new `<trans-unit>` in the group's SOURCE file — from the
   * grid's "New key…".
   *
   * Not staged, for the same reason a delete is not: a row with no source unit
   * has no sensible overlay form. Only the source file is written. The locale
   * files follow through the ordinary path — a target edit on the new row is a
   * `create` edit, and Save inserts the unit there (FR-1.9) — so this route
   * never has to know what a translation looks like.
   *
   * The unit lands where a file sorted by id expects it. A source file that
   * changed on disk since it was read is refused (`StaleFileError` → 409), never
   * overwritten; so is an id the group already has.
   */
  app.post('/api/units', async (req): Promise<UnitCreateResponse> => {
    const project = projects.current;
    const index = projects.index;
    if (!project || !index) throw notFound('no project is open');
    const body = UnitCreateRequestSchema.parse(req.body ?? {});

    const group = body.group ?? (index.groups.length === 1 ? index.groups[0] : undefined);
    if (group === undefined)
      throw badRequest('this project has several file groups; say which one the key goes into');
    if (!index.groups.includes(group)) throw notFound(`there is no file group "${group}"`);

    // The same rule the index uses to tell a source file from a locale file.
    const sourceFile = project.files.find(
      (f) =>
        f.group === group &&
        f.locale !== null &&
        (f.locale === project.sourceLocale || f.isTemplate),
    );
    const doc = sourceFile ? project.documents.get(sourceFile.path) : undefined;
    const file = sourceFile ? doc?.files[sourceFile.fileIndex] : undefined;
    if (!sourceFile || !doc || !file)
      throw badRequest(`the group "${group}" has no source file to add the key to`);

    const rowId = rowIdOf(group, body.unitId);
    if (index.byRowId.has(rowId) || file.units.some((u) => u.id === body.unitId)) {
      throw conflict(`"${body.unitId}" already exists in ${sourceFile.relPath}`);
    }

    const notes: NoteSpec[] = [];
    if (body.description?.trim())
      notes.push({ from: 'description', priority: '1', text: body.description.trim() });
    if (body.meaning?.trim())
      notes.push({ from: 'meaning', priority: '1', text: body.meaning.trim() });

    return projects.serializeSave(async () => {
      const xml = sourceUnitXml(
        doc,
        file,
        { id: body.unitId, source: body.source, notes },
        project.escapePolicy,
      );
      await saveDocument(doc, insertUnit(doc, file, xml, insertionAnchor(file, body.unitId)));
      await projects.reloadDocument(sourceFile.path);

      // A reload's tail: every span after the insertion moved.
      projects.clearHistory();
      projects.rebuildIndex();
      revalidateDrafts(projects);
      syncPendingIntoIndex(projects);
      await writeDrafts(cfg, projects);

      bus.publish({
        type: 'save-complete',
        written: [sourceFile.path],
        at: new Date().toISOString(),
      });
      return { rowId, written: sourceFile.relPath, unsavedCount: projects.unsavedCount };
    });
  });

  /**
   * Bulk approve (FR-7.3) — Focus mode's confirmed batch action.
   *
   * Commits each row's CURRENT, unmodified target, exactly what a single-unit
   * Approve does, one row at a time. Lands in the overlay only, same as every
   * other commit path here — `POST /api/save` still has to be called to persist
   * it, which keeps "commit vs. save are separate, and save is the safety net"
   * true for this path too.
   *
   * Re-checks each row's CURRENT server state rather than trusting the client's
   * possibly-stale filtered id list: a row raced out from under the request
   * (reviewed elsewhere, or no longer has this locale's column) is reported in
   * `skipped`, not silently coerced.
   */
  app.post('/api/units/bulk-approve', async (req): Promise<BulkApproveResponse> => {
    const body = BulkApproveRequestSchema.parse(req.body ?? {});
    const approved: string[] = [];
    const skipped: string[] = [];
    const step = new StepRecorder(projects, 'Approve');

    for (const rowId of body.rowIds) {
      const row = projects.index?.byRowId.get(rowId);
      const state = row?.cells.get(body.locale)?.state;
      if (row === undefined || (state !== 'draftMachine' && state !== 'needsReview')) {
        skipped.push(rowId);
        continue;
      }

      const cell = editableCell(projects, row, body.locale);
      const segments = effectiveSegments(row, body.locale, (r, l) => projects.pendingFor(r, l));
      step.cell(rowId, body.locale);
      await recordReviewOutcome(rowId, body.locale, segments);
      commitTarget(projects, row, body.locale, segments, 'reviewed', cell);
      await forgetMachineOrigin(cfg, projects, rowId, body.locale);
      approved.push(rowId);
    }

    step.finish();
    await writeDrafts(cfg, projects);
    return {
      approved,
      skipped,
      unsavedCount: projects.unsavedCount,
      history: projects.historyStatus,
    };
  });

  /**
   * Replace a unit's notes (FR-4.2) — into the overlay, like a target edit; the
   * file is written by `POST /api/save`.
   *
   * Always the SOURCE-locale file: it is where Angular writes notes and where
   * every locale, the prompt and note coverage read them. When that file is the
   * extraction template the next `ng extract-i18n` overwrites it, which the
   * panel says in so many words (FR-4.3c); this route does not refuse, because
   * a note that lives until the next extraction is still worth writing.
   *
   * The body is the WHOLE list in order. Priorities are kept per position, and
   * a new note gets what its siblings carry (Angular's `priority="1"`). A list
   * equal to the file's clears the pending edit rather than storing a no-op.
   */
  app.put('/api/units/:rowId/notes', async (req): Promise<NotesPutResponse> => {
    const { rowId } = req.params as { rowId: string };
    const project = projects.current;
    const index = projects.index;
    if (!project || !index) throw notFound('no project is open');
    const row = index.byRowId.get(rowId);
    if (!row) throw notFound('no such unit in this project');
    if (!row.sourceUnit || !row.sourceDoc) {
      throw badRequest(
        'This unit is not in the source file, so there is nowhere to write its notes.',
      );
    }
    const body = NotesPutRequestSchema.parse(req.body ?? {});

    const original = fileNotesOf(row);
    const fallback = newNotePriority(row.sourceUnit);
    const notes: NoteSpec[] = body.notes.map((n, i) => ({
      from: n.from,
      priority: original[i]?.priority ?? fallback,
      text: n.text,
    }));

    const step = new StepRecorder(projects, 'Edit notes');
    step.notes(rowId);
    if (sameNotes(notes, original)) projects.clearPendingNotes(rowId);
    else {
      projects.setPendingNotes({
        rowId,
        path: row.sourceDoc.path,
        unitId: row.sourceUnit.id,
        original,
        notes,
        at: new Date().toISOString(),
      });
    }
    index.patchNotes(rowId, notes);
    step.finish();
    await writeDrafts(cfg, projects);

    const updated = index.byRowId.get(rowId) ?? row;
    const visible = project.visibleLocales.filter((l) => index.locales.includes(l));
    return {
      detail: toWireDetail(
        updated,
        visible.length > 0 ? visible : index.locales,
        dtoContextOf(projects),
      ),
      unsavedCount: projects.unsavedCount,
      history: projects.historyStatus,
    };
  });

  /** Save (FR-1.6, NFR-4, NFR-8) — see `lib/save.ts`, which the CSV import shares. */
  app.post('/api/save', async (req): Promise<SaveResponse> => {
    const body = SaveRequestSchema.parse(req.body ?? {});
    return saveProject(cfg, projects, bus, { paths: body.paths });
  });

  /**
   * Re-read files changed on disk (FR-1.5) — the other half of M7's watcher.
   *
   * The interesting part is not the re-read, it is what happens to the dirty
   * buffer. The documents the pending edits were cut from have been replaced,
   * so every edit is re-attached to the new bytes and the ones that no longer
   * resolve are dropped. `dropped` is returned rather than logged because the
   * banner has to be able to say "2 of your unsaved edits could not be kept" —
   * silently discarding somebody's work is the one outcome this route must not
   * have.
   */
  app.post('/api/files/reload', async (req): Promise<FilesReloadResponse> => {
    const body = FilesReloadRequestSchema.parse(req.body ?? {});
    const project = projects.current;
    if (!project) throw notFound('no project is open');

    const reloaded: string[] = [];
    const failed: string[] = [];
    for (const path of body.paths.length > 0 ? body.paths : [...project.documents.keys()]) {
      if (!project.documents.has(path)) continue;
      try {
        await projects.reloadDocument(path);
        reloaded.push(path);
      } catch {
        // Deleted, or mid-write by whatever is producing it. The old document
        // stays in memory, which is the conservative answer: it is the version
        // the user's unsaved edits were written against.
        failed.push(path);
      }
    }

    let dropped = 0;
    if (reloaded.length > 0) {
      projects.clearHistory();
      projects.rebuildIndex();
      dropped = revalidateDrafts(projects).dropped;
      syncPendingIntoIndex(projects);
      await writeDrafts(cfg, projects);
    }
    return { reloaded, failed, dropped, unsavedCount: projects.unsavedCount };
  });
}

/** What "Undo …" calls a PATCH: the review decision when a reviewer made one. */
function stepLabelOf(decision: ReviewDecision | undefined): string {
  if (decision === 'approve') return 'Approve';
  if (decision === 'reject') return 'Reject';
  return 'Edit';
}
