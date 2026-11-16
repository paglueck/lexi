// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  hasTargetContent,
  placeholderIds,
  verifyComposable,
  type ElementRef,
  type LoadedDocument,
  type Segment,
} from '@lexi/xliff';
import {
  splitRowId,
  type TargetPatchResponse,
  type UnitState,
  type UnitTarget,
} from '@lexi/shared';

import { badRequest, notFound } from './http-error.js';
import {
  buildTarget,
  countFindings,
  dtoContextOf,
  sourceSegmentsOf,
  stateForEdit,
} from './unit-dto.js';
import { resolveTargetCell, type TargetCell } from './target-cell.js';
import { originKey } from './machine-origin.js';
import type { PendingEdit, ProjectService } from '../services/project-service.js';
import { fileCellState, type IndexedRow } from '../services/unit-index.js';

/**
 * Putting a new target into the overlay — the one path, whoever wrote the text.
 *
 * Extracted from `routes/edit.ts` when M9's machine drafts arrived, because a
 * draft from the model has to land in exactly the same place, past exactly the
 * same gate, as a draft from a person. A second commit path would be a second
 * set of rules about what may reach a file, and the first divergence between
 * them would be silent.
 *
 * The documents stay pristine: a commit fills the OVERLAY and patches the
 * index's derived half. Files change only in `POST /api/save` — including the
 * `<trans-unit>` a commit into a locale that lacks the unit will need (FR-1.9),
 * which is recorded on the edit as `create` and spliced in at save time.
 */

export function openRow(projects: ProjectService, rowId: string): IndexedRow {
  if (!projects.current || !projects.index) throw notFound('no project is open');
  const row = projects.index.byRowId.get(rowId);
  if (!row) throw notFound(`no unit ${splitRowId(rowId).unitId} in this project`);
  return row;
}

/**
 * Where this row's target for `locale` lives, or would live.
 *
 * Throws when the locale has no file in this group at all — the one case that
 * cannot be resolved by editing, because it is a decision about the project's
 * shape rather than about a string (FR-1.9, `POST /api/locales/file`).
 */
export function editableCell(
  projects: ProjectService,
  row: IndexedRow,
  locale: string,
): TargetCell {
  const project = projects.current;
  const index = projects.index;
  if (!project || !index) throw notFound('no project is open');
  return resolveTargetCell(project, index, row, locale);
}

/**
 * The `<source>` a target is written against.
 *
 * For a unit already in the file that is the unit's OWN source — which is what
 * makes an orphan editable, since Angular writes the source text into every
 * translation file. For a unit that is not there yet it is the source file's,
 * because that is the text being copied across.
 */
export function sourceOf(cell: TargetCell): {
  doc: LoadedDocument;
  source: ElementRef;
  target?: ElementRef;
} {
  return cell.kind === 'existing'
    ? {
        doc: cell.doc,
        source: cell.unit.source,
        ...(cell.unit.target && !cell.unit.target.selfClosing ? { target: cell.unit.target } : {}),
      }
    : { doc: cell.sourceDoc, source: cell.sourceUnit.source };
}

/**
 * Commit a rebuilt target into the overlay and refresh the index cell.
 *
 * A PATCH is a COMMIT, not a keystroke: the client holds the buffer while the
 * user types and sends it on `Cmd+Enter` or blur.
 */
export function commitTarget(
  projects: ProjectService,
  row: IndexedRow,
  locale: string,
  segments: Segment[],
  state?: UnitState,
  resolved?: TargetCell,
): TargetPatchResponse {
  const cell = resolved ?? editableCell(projects, row, locale);
  const sourceSegments = sourceSegmentsOf(row);

  // The last gate before these bytes are ever eligible to be written: compose
  // them and read them back through the real scanner. Every token can be
  // present and unique while the bytes are still invalid XML — a `<g>` whose
  // boundaries were reordered produces exactly that.
  const problem = verifyComposable(
    segments,
    placeholderIds(segments),
    projects.current?.escapePolicy ?? 'angular',
  );
  if (problem !== undefined) throw badRequest(problem);

  const edit: PendingEdit = {
    rowId: row.rowId,
    locale,
    path: cell.doc.path,
    unitId: cell.kind === 'existing' ? cell.unit.id : row.unitId,
    segments,
    state: state ?? stateForEdit(segments),
    at: new Date().toISOString(),
    ...(cell.kind === 'create' ? { create: true } : {}),
  };
  projects.setPending(edit);
  const target = refreshIndexCell(projects, row, locale, sourceSegments);
  if (target === undefined) throw notFound(`this unit has no ${locale} column`);

  return { target, unsavedCount: projects.unsavedCount };
}

/**
 * Bring the index cell back in line with the overlay, and return the target as
 * it now reads: the pending edit where there is one, else the file.
 *
 * Shared by a commit, a discard and an undo, which are the three ways a cell's
 * overlay entry appears or goes away. Undefined when the row has no such column
 * and nothing pending in it either.
 */
export function refreshIndexCell(
  projects: ProjectService,
  row: IndexedRow,
  locale: string,
  sourceSegments = sourceSegmentsOf(row),
): UnitTarget | undefined {
  const pending = projects.pendingFor(row.rowId, locale);
  const cell = row.cells.get(locale);
  if (pending === undefined && cell === undefined) return undefined;

  const ctx = dtoContextOf(projects);
  if (pending === undefined && cell !== undefined) {
    // First, because `buildTarget` reads the cell's state: a commit overwrote it
    // with the pending edit's, and only the file (and its marker) can say what
    // it is without one — `draftMachine` included.
    projects.index?.patchCell(row.rowId, locale, {
      state:
        cell.unit && cell.doc
          ? fileCellState(
              cell.doc,
              cell.unit,
              ctx.originOf(row.rowId, locale),
              projects.finalMarkers.get(originKey(row.rowId, locale)),
            )
          : 'untranslated',
      errorCount: cell.errorCount,
      warningCount: cell.warningCount,
      errorRules: cell.errorRules,
      warningRules: cell.warningRules,
      ignoredRules: cell.ignoredRules,
      targetLower: cell.targetLower,
    });
  }
  const target = buildTarget(row, locale, ctx, sourceSegments);
  if (pending !== undefined) {
    projects.index?.patchCell(row.rowId, locale, {
      state: pending.state,
      ...countFindings(target.findings, ctx.ignoredOf(row, locale)),
      targetLower: target.segments
        .map((s) => (s.k === 't' ? s.v : ''))
        .join('')
        .toLowerCase(),
    });
  } else if (cell !== undefined) {
    projects.index?.patchCell(row.rowId, locale, {
      state: target.state,
      // Back to the file's own reading, which never counts an empty target
      // (see the index build): "untranslated" is not a validation error.
      ...countFindings(
        cell.unit && hasTargetContent(cell.unit) ? target.findings : [],
        ctx.ignoredOf(row, locale),
      ),
      targetLower: (cell.unit?.targetPlain ?? '').toLowerCase(),
    });
  }
  return target;
}
