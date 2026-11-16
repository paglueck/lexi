// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import {
  hasTargetContent,
  placeholderIds,
  verifyComposable,
  type Segment,
  type XlfFile,
  shouldWriteState,
} from '@lexi/xliff';
import {
  parseReviewCsv,
  parseTokenText,
  tokenText,
  type CsvImportApplyRequest,
  type CsvImportApplyResponse,
  type CsvImportCategory,
  type CsvImportPreviewRequest,
  type CsvImportPreviewResponse,
  type CsvImportRow,
  type CsvImportUndoResponse,
  type ReviewCsvFile,
  type ReviewCsvRow,
  type SegmentDto,
  type UnitState,
} from '@lexi/shared';

import { HttpError, badRequest, conflict, notFound } from '../lib/http-error.js';
import { commitTarget, editableCell, openRow, refreshIndexCell, sourceOf } from '../lib/commit.js';
import type { EventBus } from '../lib/event-bus.js';
import {
  latestExportSnapshotOf,
  readExportSnapshot,
  type ExportSnapshot,
} from '../lib/export-snapshot.js';
import { writeFinalMarkers, type FinalMarker } from '../lib/final-marker.js';
import { writeDrafts } from '../lib/drafts.js';
import {
  isImportId,
  readImportRecord,
  writeImportRecord,
  type ImportRecord,
  type ImportedCell,
} from '../lib/import-record.js';
import {
  originKey,
  targetHash,
  writeMachineOrigins,
  type MachineOrigin,
} from '../lib/machine-origin.js';
import { PartialSaveError, saveProject, type SaveCell } from '../lib/save.js';
import type { TargetCell } from '../lib/target-cell.js';
import { cellSourceSegmentsOf, effectiveSegments } from '../lib/unit-dto.js';
import {
  UnknownPlaceholderError,
  rebuildSegments,
  toWireSegments,
  vocabularyOf,
} from '../lib/wire-segments.js';
import type { ServerConfig } from '../config.js';
import type { PendingEdit, ProjectService } from './project-service.js';
import { fileCellState, type IndexedRow } from './unit-index.js';

/**
 * The CSV import's preview: every row of the returned files sorted into what
 * Apply would do with it. Read-only — nothing here writes, so the dialog can
 * ask again as often as it likes.
 *
 * Each row compares three versions of its cell: E, what the export said (the
 * snapshot); C, what Lexi shows now (a pending edit over the file, exactly as
 * the grid renders it); V, what the reviewer sent. Only the pair of them that
 * differs tells a reviewer's edit (C == E) from a cell that moved on under the
 * export (a conflict), and a row the reviewer never touched (V == E) from one
 * they did.
 */

type Category = CsvImportCategory;

/** Text equality, the one the rules are written in: placeholders compare by number. */
const textOf = (segments: readonly SegmentDto[] | null): string =>
  segments === null ? '' : tokenText(segments);

/** The segments, or null when there are none to read tokens from. */
const nonEmpty = (
  segments: readonly SegmentDto[] | null | undefined,
): readonly SegmentDto[] | null =>
  segments === null || segments === undefined || segments.length === 0 ? null : segments;

/**
 * Placeholder and `<g>` ids as a sorted multiset. Parsing V already proves
 * it uses each token of its reference exactly once; this compares with the
 * SOURCE, because the reference (E or C) may itself have lost a placeholder,
 * and a target short of one is what the XLIFF must never get from an import.
 */
function placeholderSet(segments: readonly SegmentDto[]): string {
  const ids: string[] = [];
  const walk = (list: readonly SegmentDto[]): void => {
    for (const s of list) {
      if (s.k === 'p') ids.push(`p:${s.id}`);
      else if (s.k === 'g') {
        ids.push(`g:${s.id}`);
        walk(s.children);
      }
    }
  };
  walk(segments);
  return ids.sort().join('\n');
}

/**
 * Several rows for one cell — the same export sent back by several markets,
 * each checking only its own column. Copies that leave the cell alone are
 * harmless. Rows that edit it must agree: the first of identical edits is
 * kept and the others are skipped; differing edits are all blocked, since
 * only the user can say which one is right.
 *
 * A cell is finalizable through one row at most, and not at all while any
 * row would edit it or is blocked over it: confirming the current text then
 * would overrule a reviewer who wanted something else.
 */
function settleDuplicates(rows: CsvImportRow[]): void {
  const edits = new Map<string, number[]>();
  const disputed = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (row.rowId === null) continue;
    const key = originKey(row.rowId, row.locale);
    if (row.category === 'blocked') disputed.add(key);
    if (row.category !== 'changed' && row.category !== 'conflict') continue;
    disputed.add(key);
    const list = edits.get(key);
    if (list === undefined) edits.set(key, [i]);
    else list.push(i);
  }
  const confirmed = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (!row.finalizable) continue;
    const key = originKey(row.rowId!, row.locale);
    if (disputed.has(key) || confirmed.has(key)) rows[i] = { ...row, finalizable: false };
    else confirmed.add(key);
  }
  for (const list of edits.values()) {
    if (list.length < 2) continue;
    const first = rows[list[0]!]!;
    const text = textOf(first.csv);
    const where = (r: CsvImportRow): string => `line ${r.line} of ${r.file}`;
    if (list.every((i) => textOf(rows[i]!.csv) === text)) {
      for (const i of list.slice(1)) {
        rows[i] = {
          ...rows[i]!,
          category: 'skipped',
          reason: `Same translation as ${where(first)}`,
        };
      }
      continue;
    }
    for (const i of list) {
      const row = rows[i]!;
      const other = rows[list.find((j) => textOf(rows[j]!.csv) !== textOf(row.csv))!]!;
      rows[i] = {
        ...row,
        category: 'blocked',
        reason: `Different translation for ${row.locale} on ${where(other)}`,
      };
    }
  }
}

/** Classify every row of `req.files` against the open project at `projectPath`. */
export async function previewCsvImport(
  projects: ProjectService,
  projectPath: string,
  req: CsvImportPreviewRequest,
): Promise<CsvImportPreviewResponse> {
  const index = projects.index;
  if (index === null) throw notFound('no project is open');

  // Only the project's locales are read as columns, so every row's locale is one.
  const locales = projects.targetLocales();
  const files: ReviewCsvFile[] = [];
  for (const f of req.files) {
    const parsed = parseReviewCsv(f.name, f.text, locales);
    if ('error' in parsed) throw badRequest(parsed.error);
    files.push(parsed);
  }

  const byUnitId = new Map<string, IndexedRow[]>();
  for (const row of index.rows) {
    const list = byUnitId.get(row.unitId);
    if (list === undefined) byUnitId.set(row.unitId, [row]);
    else list.push(row);
  }

  /**
   * A unit is named by its id, or as `group/unitId` when the id alone is
   * ambiguous — what the export writes then. Groups are paths and contain `/`
   * themselves (`checkout/messages`), so every split point is tried rather than
   * only the first.
   */
  const resolve = (id: string): IndexedRow[] => {
    const direct = byUnitId.get(id);
    if (direct !== undefined) return direct;
    const out: IndexedRow[] = [];
    for (let at = id.indexOf('/'); at >= 0; at = id.indexOf('/', at + 1)) {
      const group = id.slice(0, at);
      for (const row of byUnitId.get(id.slice(at + 1)) ?? []) {
        if (row.group === group) out.push(row);
      }
    }
    return out;
  };

  // Snapshots are read once per request, however many rows name them.
  const byExportId = new Map<string, Promise<ExportSnapshot | null>>();
  const snapshotById = (id: string): Promise<ExportSnapshot | null> => {
    let p = byExportId.get(id);
    if (p === undefined) byExportId.set(id, (p = readExportSnapshot(projectPath, id)));
    return p;
  };
  const jobSnapshot =
    req.jobId === null ? Promise.resolve(null) : latestExportSnapshotOf(projectPath, req.jobId);

  const used = new Map<string, { snapshot: ExportSnapshot; rows: number }>();
  const rows: CsvImportRow[] = [];

  for (const [fileIndex, file] of files.entries()) {
    for (const csvRow of file.rows) {
      rows.push(await classify(fileIndex, file, csvRow));
    }
  }
  settleDuplicates(rows);

  async function classify(
    fileIndex: number,
    file: ReviewCsvFile,
    csvRow: ReviewCsvRow,
  ): Promise<CsvImportRow> {
    const { locale, translation } = csvRow;
    const out: CsvImportRow = {
      // A line holds a cell per locale, so the line alone is not a row.
      key: `${fileIndex}:${csvRow.line}:${locale}`,
      file: file.name,
      line: csvRow.line,
      unitId: csvRow.unitId,
      rowId: null,
      locale,
      category: 'blocked',
      reason: null,
      warnings: [],
      source: null,
      exported: null,
      current: null,
      csv: null,
      csvText: translation,
      currentChangedBy: null,
      currentChangedAt: null,
      checks: { placeholders: true, sourceUnchanged: null },
      finalizable: false,
    };
    const finish = (category: Category, reason: string | null = null): CsvImportRow => ({
      ...out,
      category,
      reason,
    });

    // 1–4: rows that never reach a cell.
    if (translation.trim() === '')
      return finish('skipped', 'Empty cell. The target stays as it is.');
    const matches = resolve(csvRow.unitId);
    if (matches.length === 0) return finish('blocked', `No unit "${csvRow.unitId}" in ${locale}`);
    if (matches.length > 1) {
      return finish(
        'blocked',
        `"${csvRow.unitId}" exists in several files; prefix it with its group`,
      );
    }
    const row = matches[0]!;
    out.rowId = row.rowId;
    const cellKey = originKey(row.rowId, locale);

    const source = toWireSegments(cellSourceSegmentsOf(row, locale));
    const pending = projects.pendingFor(row.rowId, locale);
    const effective = effectiveSegments(row, locale, (r, l) => projects.pendingFor(r, l));
    // An empty cell has nothing to compare token numbers with; it reads as no
    // translation, and V is parsed against the source instead.
    const current =
      effective.length === 0 && pending === undefined ? null : toWireSegments(effective);
    out.source = source;
    out.current = current;

    // 5: E — the row's own export, else the job's latest, else C itself.
    let snapshot: ExportSnapshot | null = null;
    if (csvRow.exportId !== null) snapshot = await snapshotById(csvRow.exportId);
    snapshot ??= await jobSnapshot;
    if (snapshot !== null) {
      const tally = used.get(snapshot.id) ?? { snapshot, rows: 0 };
      tally.rows += 1;
      used.set(snapshot.id, tally);
    }
    // The export wrote `group` from the job's view of the unit; null there
    // means it did not know one, so the id alone has to do.
    const snapRow = snapshot?.rows.find(
      (r) =>
        r.unitId === row.unitId &&
        r.locale === locale &&
        (r.group === null || r.group === row.group),
    );
    // A row the export wrote with an empty Translation (rejected, failed, no
    // target) still has a baseline: the empty cell. Falling back to C there
    // would read a Lexi translation made since as the reviewer's starting
    // point and let Apply overwrite it as `changed`. Only a cell the snapshot
    // does not cover at all compares with C.
    const exported = snapRow !== undefined ? (snapRow.segments ?? []) : current;
    out.exported = exported;
    if (snapRow !== undefined) {
      const sourceUnchanged = textOf(snapRow.source) === textOf(source);
      out.checks.sourceUnchanged = sourceUnchanged;
      if (!sourceUnchanged) out.warnings.push('Source changed since export');
    }

    if (pending !== undefined) {
      out.currentChangedBy = 'unsaved edit';
      out.currentChangedAt = pending.at;
    } else if (snapshot !== null) {
      // Only a marker on a cell that still reads as the job's draft: a stale
      // one over a hand edit would name the wrong author.
      const origin = projects.machineOrigins.get(cellKey);
      if (
        origin !== undefined &&
        row.cells.get(locale)?.state === 'draftMachine' &&
        origin.at > snapshot.at
      ) {
        out.currentChangedBy = 'job draft';
        out.currentChangedAt = origin.at;
      }
    }

    // 6–7: V must be the reference's tokens, and those must be the source's.
    // An empty cell carries no tokens to number, so the reviewer's tokens are
    // read against the next text that has them.
    const parsed = parseTokenText(
      translation,
      nonEmpty(snapRow?.segments) ?? nonEmpty(current) ?? source,
    );
    if (!parsed.ok) {
      out.checks.placeholders = false;
      return finish('blocked', parsed.reason);
    }
    out.csv = parsed.segments;
    if (placeholderSet(parsed.segments) !== placeholderSet(source)) {
      out.checks.placeholders = false;
      return finish('blocked', "Placeholders and markup don't match the source");
    }

    // 8: the three-way comparison.
    const v = textOf(parsed.segments);
    const c = textOf(current);
    const e = textOf(exported);
    if (v === c || v === e) {
      // Only V == C confirms what Lexi shows; V == E with C moved on would
      // finalize a text the reviewer never saw.
      out.finalizable =
        v === c &&
        current !== null &&
        pending === undefined &&
        row.cells.get(locale)?.state !== 'final';
      return finish('unchanged');
    }
    if (c === e) return finish('changed');
    return finish('conflict');
  }

  // The baseline the dialog names: the snapshot most rows were compared with,
  // the newer one on a tie.
  let baseline: ExportSnapshot | null = null;
  let most = 0;
  for (const { snapshot, rows: count } of used.values()) {
    if (count > most || (count === most && baseline !== null && snapshot.at > baseline.at)) {
      baseline = snapshot;
      most = count;
    }
  }

  return {
    files: files.map((f) => ({
      name: f.name,
      delimiter: f.delimiter,
      rowCount: f.rows.length,
      columns: f.columns,
    })),
    baseline:
      baseline === null ? null : { exportId: baseline.id, jobId: baseline.jobId, at: baseline.at },
    rows,
  };
}

/* ---- Apply and Undo ------------------------------------------------------ */

/** One cell about to be written: where it goes, and what it held before. */
interface PlannedCell {
  readonly row: IndexedRow;
  readonly locale: string;
  readonly cell: TargetCell;
  readonly segments: Segment[];
  /** Whether this file carries `state` itself; otherwise `final` needs a marker. */
  readonly writesState: boolean;
}

/** The `<file>` a target is written into, existing unit or created one. */
function xlfFileOf(cell: TargetCell): XlfFile | undefined {
  return cell.kind === 'create'
    ? cell.file
    : cell.doc.files.find((f) => f.units.includes(cell.unit));
}

/**
 * Rebuild wire segments into this cell's bytes and run the commit's own gate on
 * them, so a problem surfaces BEFORE anything is committed. Apply and Undo
 * both write several cells, and a refusal halfway through would leave the
 * first ones in the overlay.
 */
function planCell(
  projects: ProjectService,
  row: IndexedRow,
  locale: string,
  wire: readonly SegmentDto[],
): { plan: PlannedCell } | { problem: string } {
  const project = projects.current;
  if (!project) throw notFound('no project is open');
  let cell: TargetCell;
  try {
    cell = editableCell(projects, row, locale);
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  const from = sourceOf(cell);
  const vocabulary = vocabularyOf(from.doc.raw, from.source.innerSpan, from.target?.innerSpan);
  let segments: Segment[];
  try {
    segments = rebuildSegments(wire, vocabulary);
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) return { problem: error.message };
    throw error;
  }
  const problem = verifyComposable(segments, placeholderIds(segments), project.escapePolicy);
  if (problem !== undefined) return { problem };
  const file = xlfFileOf(cell);
  return {
    plan: {
      row,
      locale,
      cell,
      segments,
      writesState: file !== undefined && shouldWriteState(project.writeState, file),
    },
  };
}

/** What a cell-scoped save of planned cells achieved. */
interface SaveOutcome {
  readonly at: string;
  /** The cells now on disk. */
  readonly saved: readonly PlannedCell[];
  /** Cells whose file a mid-save I/O failure left unwritten; rolled back. */
  readonly failed: readonly PlannedCell[];
}

/**
 * Commit the planned cells and save exactly those cells.
 *
 * No undo step is recorded. A successful save clears the session's history
 * (its snapshots predate the write), and a failed one puts the overlay back,
 * so a step could only ever describe a commit that is gone; the import record
 * is this write's undo.
 *
 * A save that writes nothing (a stale file, which `saveProject` refuses before
 * the first write) puts the overlay back to what it held before — the
 * translator's own pending edits included — and rethrows. A save that wrote
 * some files and then failed (`PartialSaveError`) keeps the cells in those
 * files, which are on disk now, and rolls back only the others; the caller
 * records what landed and names what did not.
 */
async function commitAndSave(
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
  plans: readonly PlannedCell[],
  stateOf: (plan: PlannedCell) => UnitState | undefined,
): Promise<SaveOutcome> {
  const before = new Map<PlannedCell, PendingEdit | undefined>();
  for (const plan of plans) {
    before.set(plan, projects.pendingFor(plan.row.rowId, plan.locale));
    commitTarget(projects, plan.row, plan.locale, plan.segments, stateOf(plan), plan.cell);
  }

  const rollBack = (cells: readonly PlannedCell[]): void => {
    for (const plan of cells) {
      const pending = before.get(plan);
      if (pending === undefined) projects.clearPending(plan.row.rowId, plan.locale);
      else projects.setPending(pending);
      const row = projects.index?.byRowId.get(plan.row.rowId);
      if (row !== undefined) refreshIndexCell(projects, row, plan.locale);
    }
  };

  const cells: SaveCell[] = plans.map((p) => ({ rowId: p.row.rowId, locale: p.locale }));
  try {
    const saved = await saveProject(cfg, projects, bus, { cells });
    return { at: saved.at, saved: plans, failed: [] };
  } catch (error) {
    if (!(error instanceof PartialSaveError)) {
      rollBack(plans);
      throw error;
    }
    const written = new Set(error.written);
    const saved = plans.filter((p) => written.has(p.cell.doc.path));
    const failed = plans.filter((p) => !written.has(p.cell.doc.path));
    rollBack(failed);
    // The save wrote the drafts file before these came back.
    await writeDrafts(cfg, projects);
    return { at: new Date().toISOString(), saved, failed };
  }
}

/** The 409 for a save that stopped halfway: what landed is kept, the rest named. */
function partialConflict(failed: readonly PlannedCell[], importId: string | null): HttpError {
  const files = [...new Set(failed.map((p) => p.cell.relPath))];
  return new HttpError(
    409,
    'conflict',
    `Could not write ${files.join(', ')}. Those rows were not imported; the other files were written.`,
    { importId, notWritten: files },
  );
}

/**
 * A cell's target as the FILE now holds it: segments for the record, and the
 * inner XML for a hash. Read from the reloaded document after a save, because a
 * marker is only believed while the bytes on disk hash to it — a hash of the
 * pre-save compose would be right only as long as the writer never changed a
 * byte of it on the way.
 */
function fileTargetOf(
  projects: ProjectService,
  rowId: string,
  locale: string,
): { row: IndexedRow; segments: SegmentDto[] | null; inner: string | null } | undefined {
  const row = projects.index?.byRowId.get(rowId);
  if (row === undefined) return undefined;
  const cell = row.cells.get(locale);
  const target = cell?.unit?.target;
  if (cell?.doc === undefined || cell.unit === undefined || !hasTargetContent(cell.unit)) {
    return { row, segments: null, inner: null };
  }
  const inner =
    target === undefined || target.selfClosing
      ? null
      : cell.doc.raw.slice(target.innerSpan.start, target.innerSpan.end);
  return {
    row,
    segments: toWireSegments(effectiveSegments(row, locale, () => undefined)),
    inner,
  };
}

/** The state a cell reads with no pending edit over it: the file, its draft and final markers. */
function fileStateOf(projects: ProjectService, row: IndexedRow, locale: string): UnitState {
  const cell = row.cells.get(locale);
  if (cell?.doc === undefined || cell.unit === undefined) return 'untranslated';
  const key = originKey(row.rowId, locale);
  return fileCellState(
    cell.doc,
    cell.unit,
    projects.machineOrigins.get(key),
    projects.finalMarkers.get(key),
  );
}

/**
 * Write the rows the user included (S16's Apply).
 *
 * The files are classified again here rather than trusted from the preview,
 * and every included row must still be `changed` or `conflict` with the cell
 * reading as the preview saw it. Anything else — a Grid edit, a reload, a job
 * in between — is a 409 before a single cell is committed: an import must
 * never overwrite something the user has not seen.
 *
 * Only the imported cells are saved. Every other pending edit stays in the
 * overlay, in these files too; a pending edit in an imported cell is replaced.
 *
 * With `finalizeUnchanged`, every `finalizable` cell is written too: its text
 * as it is, state `final`, recorded like any imported cell so Undo puts its
 * old state back.
 */
export async function applyCsvImport(
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
  projectPath: string,
  req: CsvImportApplyRequest,
): Promise<CsvImportApplyResponse> {
  const preview = await previewCsvImport(projects, projectPath, req);
  const byKey = new Map(preview.rows.map((r) => [r.key, r]));

  const plans: PlannedCell[] = [];
  const rows: CsvImportRow[] = [];
  const keys = new Set<string>();
  for (const { key, current } of req.include) {
    if (keys.has(key)) continue;
    keys.add(key);
    const row = byKey.get(key);
    if (row === undefined) throw conflict(`Row ${key} is not in the file. Choose the file again.`);
    const stale = (): Error =>
      conflict(`Row ${row.file}:${row.line} changed since the preview. Choose the file again.`);
    if (row.category !== 'changed' && row.category !== 'conflict') throw stale();
    if (row.rowId === null || row.csv === null || textOf(row.current) !== current) throw stale();

    const planned = planCell(projects, openRow(projects, row.rowId), row.locale, row.csv);
    if ('problem' in planned) {
      throw badRequest(`Row ${row.file}:${row.line}: ${planned.problem}`);
    }
    plans.push(planned.plan);
    rows.push(row);
  }

  // Unchanged rows the reviewer confirmed: their own text again, now final.
  // The preview just re-read them, so V == C holds for exactly these cells.
  const finalizing = new Set<PlannedCell>();
  if (req.finalizeUnchanged) {
    for (const row of preview.rows) {
      if (!row.finalizable || row.rowId === null || row.current === null) continue;
      const planned = planCell(projects, openRow(projects, row.rowId), row.locale, row.current);
      // Confirming is a bonus to the import, never a reason to refuse it.
      if ('problem' in planned) continue;
      plans.push(planned.plan);
      rows.push(row);
      finalizing.add(planned.plan);
    }
  }
  if (plans.length === 0) throw badRequest('Nothing to import.');
  const stateOf = (plan: PlannedCell): UnitState => (finalizing.has(plan) ? 'final' : req.state);

  // What each cell held on disk before. The FILE's target, not a pending edit
  // over it: Undo restores the files, and an unsaved draft was never in them.
  const before = new Map(
    plans.map((p, i) => {
      const key = originKey(p.row.rowId, p.locale);
      const file = fileTargetOf(projects, p.row.rowId, p.locale);
      return [
        p,
        {
          csv: rows[i]!.csv!,
          previous: file?.segments ?? null,
          previousState: fileStateOf(projects, p.row, p.locale),
          previousOrigin: projects.machineOrigins.get(key) ?? null,
          previousFinal: projects.finalMarkers.get(key) ?? null,
        },
      ] as const;
    }),
  );

  const { at, saved, failed } = await commitAndSave(cfg, projects, bus, plans, stateOf);
  if (saved.length === 0) throw partialConflict(failed, null);

  const id = randomUUID();
  const project = projects.current;
  if (!project) throw notFound('no project is open');
  let origins = false;
  let finals = false;
  const cells: ImportedCell[] = [];
  const written = new Map<string, number>();
  for (const plan of saved) {
    const { rowId } = plan.row;
    const { locale } = plan;
    const { csv: sent, ...previous } = before.get(plan)!;
    // The import made these targets the user's: a machine draft's marker
    // retires like it does on any human edit, and an older final marker
    // describes bytes that are gone (the record keeps it for Undo).
    origins = projects.clearMachineOrigin(rowId, locale) || origins;
    finals = projects.clearFinalMarker(rowId, locale) || finals;
    const file = fileTargetOf(projects, rowId, locale);
    if (stateOf(plan) === 'final' && !plan.writesState && file?.inner != null) {
      projects.setFinalMarker(rowId, locale, { hash: targetHash(file.inner), at, importId: id });
      finals = true;
    }
    // The save rebuilt the index without the marker change; read the cell again.
    if (file !== undefined) refreshIndexCell(projects, file.row, locale);

    cells.push({
      rowId,
      locale,
      path: plan.cell.relPath,
      segments: file?.segments ?? sent,
      ...previous,
    });
    written.set(plan.cell.relPath, (written.get(plan.cell.relPath) ?? 0) + 1);
  }
  if (origins) await writeMachineOrigins(cfg, project.path, projects.machineOrigins);
  if (finals) await writeFinalMarkers(cfg, project.path, projects.finalMarkers);

  // Written for exactly the cells on disk, so a save that stopped halfway
  // can still be undone for the part that landed.
  const record: ImportRecord = {
    version: 1,
    id,
    at,
    // From the Grid there is no job in the request, but the Export column
    // still names the job the CSV came from; its Run Log lists the import.
    jobId: req.jobId ?? preview.baseline?.jobId ?? null,
    exportId: preview.baseline?.exportId ?? null,
    state: req.state,
    undone: false,
    cells,
  };
  await writeImportRecord(cfg, project.path, record);
  if (failed.length > 0) throw partialConflict(failed, id);

  return {
    importId: id,
    at,
    written: [...written].map(([path, count]) => ({ path, count })),
  };
}

/**
 * Undo an import from its record — the way back once the save has cleared the
 * session's own history.
 *
 * A cell is restored only while it still reads as the import wrote it
 * (compared as token text, pending edit included); a cell edited since is
 * somebody's later work and is reported in `skipped`, not reverted. The
 * restored cells are saved on their own, like Apply's.
 */
export async function undoCsvImport(
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
  projectPath: string,
  id: string,
): Promise<CsvImportUndoResponse> {
  if (!isImportId(id)) throw notFound('no such import');
  const record = await readImportRecord(projectPath, id);
  if (record === null) throw notFound('no such import');
  if (record.undone) throw conflict('This import has already been undone.');
  if (projects.index === null) throw notFound('no project is open');

  const plans: { plan: PlannedCell; cell: ImportedCell }[] = [];
  const skipped: CsvImportUndoResponse['skipped'] = [];
  for (const cell of record.cells) {
    const row = projects.index.byRowId.get(cell.rowId);
    const now = (r: IndexedRow): string =>
      tokenText(
        toWireSegments(effectiveSegments(r, cell.locale, (id, l) => projects.pendingFor(id, l))),
      );
    if (row === undefined || now(row) !== tokenText(cell.segments)) {
      skipped.push({ rowId: cell.rowId, locale: cell.locale });
      continue;
    }
    const planned = planCell(projects, row, cell.locale, cell.previous ?? []);
    if ('problem' in planned) {
      skipped.push({ rowId: cell.rowId, locale: cell.locale });
      continue;
    }
    plans.push({ plan: planned.plan, cell });
  }

  let failed: readonly PlannedCell[] = [];
  let restored = 0;
  if (plans.length > 0) {
    const byPlan = new Map(plans.map((p) => [p.plan, p.cell]));
    const outcome = await commitAndSave(
      cfg,
      projects,
      bus,
      plans.map((p) => p.plan),
      (plan) => byPlan.get(plan)?.previousState,
    );
    failed = outcome.failed;
    restored = outcome.saved.length;

    let origins = false;
    let finals = false;
    for (const plan of outcome.saved) {
      const cell = byPlan.get(plan)!;
      finals = projects.clearFinalMarker(cell.rowId, cell.locale) || finals;
      const file = fileTargetOf(projects, cell.rowId, cell.locale);
      const hash = file?.inner == null ? null : targetHash(file.inner);
      // Hash-guarded like every marker: put back only when the restore
      // produced the very bytes the draft run wrote.
      const origin: MachineOrigin | null = cell.previousOrigin;
      if (origin !== null && hash === origin.hash) {
        projects.setMachineOrigin(cell.rowId, cell.locale, origin);
        origins = true;
      }
      // A cell that was `final` through an earlier import's marker, in a file
      // with no `state`, is `final` again only with a marker: the earlier one
      // when the bytes are its own, else a fresh one over the restored bytes.
      const previousFinal: FinalMarker | null = cell.previousFinal ?? null;
      if (hash !== null && previousFinal !== null && hash === previousFinal.hash) {
        projects.setFinalMarker(cell.rowId, cell.locale, previousFinal);
        finals = true;
      } else if (hash !== null && cell.previousState === 'final' && !plan.writesState) {
        projects.setFinalMarker(cell.rowId, cell.locale, {
          hash,
          at: new Date().toISOString(),
          importId: previousFinal?.importId ?? record.id,
        });
        finals = true;
      }
      if (file !== undefined) refreshIndexCell(projects, file.row, cell.locale);
    }
    if (origins) await writeMachineOrigins(cfg, projectPath, projects.machineOrigins);
    if (finals) await writeFinalMarkers(cfg, projectPath, projects.finalMarkers);
  }

  // Stopped halfway: the record stays undoable. The restored cells no longer
  // read as the import wrote them, so a second Undo skips them and retries
  // only the files that were not written.
  if (failed.length > 0) throw partialConflict(failed, record.id);
  await writeImportRecord(cfg, projectPath, { ...record, undone: true });
  return { restored, skipped };
}
