// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  placeholderIds,
  plainText,
  segmentsOf,
  validateSegments,
  type Finding,
  type GlossaryCheck,
  type RuleId,
  type Segment,
  type Severity,
  type UnitState,
} from '@lexi/xliff';
import {
  GRID_TEXT_LIMIT,
  isRtlLocale,
  type Term,
  type MachineOriginDto,
  type PreviousTarget as PreviousTargetDto,
  type ScannedFile,
  type UnitCell,
  type UnitDetail,
  type UnitRow,
  type UnitTarget,
} from '@lexi/shared';

import { glossaryChecks } from '../services/termbase.js';
import type { PendingNotes } from '../services/project-service.js';
import { effectiveNotes } from './notes.js';
import {
  UnknownPlaceholderError,
  fullSegments,
  gridSegments,
  rebuildSegments,
  toWireSegments,
  vocabularyOf,
} from './wire-segments.js';
import { newLocaleFilePath } from './target-cell.js';
import { originKey, type MachineOrigin } from './machine-origin.js';
import type { PendingEdit } from '../services/project-service.js';
import { sourceTextOf, type IndexedCell, type IndexedRow } from '../services/unit-index.js';
import { sourceHash } from '../services/project-service.js';
import type { IgnoredFindings } from './ignored-findings.js';

/**
 * The row and detail payloads, in one place because both the read routes and the
 * write routes build them.
 *
 * THE ONE RULE HERE: a cell is rendered from its PENDING EDIT when it has one,
 * and from the document otherwise. The grid, the detail panel and the PATCH
 * response all go through this, so the three can never disagree about what the
 * user is looking at — which they would the moment any of them read the file
 * directly while an uncommitted edit existed.
 */

/** Resolve the uncommitted edit for a cell, if any. */
export type PendingLookup = (rowId: string, locale: string) => PendingEdit | undefined;

/** Resolve the machine-draft marker for a cell, if any. */
export type OriginLookup = (rowId: string, locale: string) => MachineOrigin | undefined;

export interface DtoContext {
  readonly sourceLocale: string;
  readonly severities: Readonly<Record<RuleId, Severity>>;
  /** The glossary resolved for one target locale (FR-8.1's two glossary rules). */
  readonly glossaryFor: (locale: string) => readonly GlossaryCheck[];
  readonly pendingOf: PendingLookup;
  /** `.lexi/state.json`'s record for a cell — M14's provenance and diff. */
  readonly originOf: OriginLookup;
  /** `.lexi/review-notes.json`'s reject-reason chips for a cell (M14). */
  readonly reasonsOf: (rowId: string, locale: string) => readonly string[];
  /** Whether this locale has a file in this group at all (FR-1.9). */
  readonly hasFile: (group: string, locale: string) => boolean;
  /** What a new file for this locale would be called, when there is none. */
  readonly proposeFile: (group: string, locale: string) => string | null;
  /** A row's unsaved note edit, if any (FR-4.2). */
  readonly notesPendingOf: (rowId: string) => PendingNotes | undefined;
  /** The scanned file a document path belongs to — for "is this the template". */
  readonly fileAt: (path: string) => ScannedFile | undefined;
  /** Rules ignored for this cell whose ignore still matches the source (S12). */
  readonly ignoredOf: (row: IndexedRow, locale: string) => ReadonlySet<RuleId>;
}

const targetSegmentsOf = (
  raw: string,
  innerSpan: { start: number; end: number } | undefined,
): Segment[] => (innerSpan === undefined ? [] : segmentsOf(raw, innerSpan));

/** The engine segments a cell currently shows: the draft, else the file. */
export function effectiveSegments(
  row: IndexedRow,
  locale: string,
  pendingOf: PendingLookup,
): Segment[] {
  const pending = pendingOf(row.rowId, locale);
  if (pending !== undefined) return [...pending.segments];

  const cell = row.cells.get(locale);
  if (!cell?.unit || !cell.doc || cell.unit.target === undefined || cell.unit.target.selfClosing) {
    return [];
  }
  return targetSegmentsOf(cell.doc.raw, cell.unit.target.innerSpan);
}

export const sourceSegmentsOf = (row: IndexedRow): Segment[] =>
  row.sourceUnit && row.sourceDoc
    ? segmentsOf(row.sourceDoc.raw, row.sourceUnit.source.innerSpan)
    : [];

/**
 * The source one locale's target is judged against: the source file's, or for
 * an orphan the unit's own `<source>` (Angular writes it into every file). The
 * index validates orphans that way, so the panel has to as well, or it shows
 * "no findings" for a cell the grid counts as broken.
 */
export function cellSourceSegmentsOf(row: IndexedRow, locale: string): Segment[] {
  if (row.sourceUnit !== undefined) return sourceSegmentsOf(row);
  const cell = row.cells.get(locale);
  return cell?.unit && cell.doc ? segmentsOf(cell.doc.raw, cell.unit.source.innerSpan) : [];
}

/**
 * Placeholders present in the source but absent from the target (FR-3.8).
 *
 * A multiset difference, not a set difference: a source with two INTERPOLATIONs
 * and a target with one is missing one, not zero.
 */
export function missingPlaceholdersOf(
  sourceIds: readonly string[],
  targetSegments: readonly Segment[],
): string[] {
  const remaining = placeholderIds(targetSegments);
  const missing: string[] = [];
  for (const id of sourceIds) {
    const at = remaining.indexOf(id);
    if (at === -1) missing.push(id);
    else remaining.splice(at, 1);
  }
  return missing;
}

/**
 * The marker for a cell, but ONLY while the cell actually reads as a machine
 * draft.
 *
 * The presence of a record is not the question — `unit-index.ts`'s
 * `machineState` already did the real work by hashing the bytes, and a cell
 * edited in vim keeps a stale record in the map until the next PATCH clears
 * it. Surfacing "this is how the model wrote it" over somebody's hand-written
 * correction would be exactly the lie the hash gate exists to prevent, and it
 * would never expire on its own.
 */
function liveOrigin(
  row: IndexedRow,
  locale: string,
  ctx: DtoContext,
  state: UnitState,
): MachineOrigin | undefined {
  return state === 'draftMachine' ? ctx.originOf(row.rowId, locale) : undefined;
}

/** The marker's public half — the hash and the snapshot stay server-side. */
function originDtoOf(origin: MachineOrigin | undefined): MachineOriginDto | null {
  if (origin === undefined) return null;
  return {
    at: origin.at,
    model: origin.model,
    style: origin.style,
    ...(origin.temperature === undefined ? {} : { temperature: origin.temperature }),
    ...(origin.styleGuide === undefined ? {} : { styleGuide: origin.styleGuide }),
    ...(origin.glossaryInjected === undefined ? {} : { glossaryInjected: origin.glossaryInjected }),
    ...(origin.glossaryApplied === undefined ? {} : { glossaryApplied: origin.glossaryApplied }),
    ...(origin.glossaryTotal === undefined ? {} : { glossaryTotal: origin.glossaryTotal }),
    ...(origin.confidence === undefined ? {} : { confidence: origin.confidence }),
    ...(origin.notesForReviewer === undefined ? {} : { notesForReviewer: origin.notesForReviewer }),
  };
}

/**
 * The snapshot the draft displaced, rehydrated into wire segments.
 *
 * `.lexi/state.json` stores ids and text, like `drafts.json` and for the same
 * reason, so the placeholder bytes have to be re-attached before the chips can
 * carry their `equiv-text` labels into the diff. An id the unit no longer has
 * means the source changed under the snapshot; that is a diff nobody should be
 * shown, so it reads as "no previous target" rather than as a guess.
 */
function previousDtoOf(
  origin: MachineOrigin | undefined,
  cell: IndexedCell | undefined,
): PreviousTargetDto | null {
  const previous = origin?.previous;
  if (!previous || !cell?.unit || !cell.doc) return null;
  try {
    const vocabulary = vocabularyOf(
      cell.doc.raw,
      cell.unit.source.innerSpan,
      cell.unit.target?.innerSpan,
    );
    return {
      segments: toWireSegments(rebuildSegments(previous.segments, vocabulary)),
      state: previous.state,
    };
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) return null;
    throw error;
  }
}

/** One `Target ·` section of the detail panel, for the file's value or a draft's. */
export function buildTarget(
  row: IndexedRow,
  locale: string,
  ctx: DtoContext,
  rowSource: readonly Segment[],
): UnitTarget {
  const cell = row.cells.get(locale);
  const sourceSegments =
    row.sourceUnit === undefined ? cellSourceSegmentsOf(row, locale) : rowSource;
  const sourceIds = placeholderIds(sourceSegments);
  const pending = ctx.pendingOf(row.rowId, locale);

  // A unit that is not in this locale's file yet reads as missing UNTIL somebody
  // writes one, and from that moment it reads as the pending edit it now has —
  // the `<trans-unit>` is spliced in on save (FR-1.9). Checking the draft first
  // is what makes the panel show what the user just typed rather than the empty
  // cell the file still has.
  if ((!cell?.unit || !cell.doc) && pending === undefined) {
    return {
      locale,
      isRtl: isRtlLocale(locale),
      state: 'untranslated',
      missing: true,
      noFile: !ctx.hasFile(row.group, locale),
      newFile: ctx.hasFile(row.group, locale) ? null : ctx.proposeFile(row.group, locale),
      segments: [],
      findings: [],
      missingPlaceholders: [...sourceIds],
      charCount: 0,
      // Nothing is in the file and nothing is pending, so there is no draft to
      // have provenance and nothing for it to have displaced.
      previous: null,
      origin: null,
      reviewReasons: [...ctx.reasonsOf(row.rowId, locale)],
    };
  }

  const segments = effectiveSegments(row, locale, ctx.pendingOf);
  const findings: Finding[] = validateSegments(sourceSegments, segments, {
    sourceLocale: ctx.sourceLocale,
    targetLocale: locale,
    severities: ctx.severities,
    glossary: ctx.glossaryFor(locale),
  });

  const state = pending?.state ?? cell?.state ?? 'untranslated';
  const origin = liveOrigin(row, locale, ctx, state);

  return {
    locale,
    isRtl: isRtlLocale(locale),
    state,
    missing: false,
    noFile: false,
    newFile: null,
    segments: toWireSegments(segments),
    findings,
    missingPlaceholders: missingPlaceholdersOf(sourceIds, segments),
    charCount: plainText(segments).length,
    previous: previousDtoOf(origin, cell),
    origin: originDtoOf(origin),
    reviewReasons: [...ctx.reasonsOf(row.rowId, locale)],
  };
}

/**
 * The severity counts a pending edit puts into the index (`patchCell`).
 *
 * `ignored` findings are counted apart, never as errors or warnings, so the
 * grid, the dashboard and the Issues screen all leave them out alike.
 */
export function countFindings(
  findings: readonly Pick<Finding, 'rule' | 'severity'>[],
  ignored: ReadonlySet<RuleId> = new Set(),
): CellPatchCounts {
  let errorCount = 0;
  let warningCount = 0;
  const errorRules: RuleId[] = [];
  const warningRules: RuleId[] = [];
  const ignoredRules: RuleId[] = [];
  for (const f of findings) {
    if (ignored.has(f.rule)) {
      ignoredRules.push(f.rule);
    } else if (f.severity === 'error') {
      errorCount += 1;
      errorRules.push(f.rule);
    } else {
      warningCount += 1;
      warningRules.push(f.rule);
    }
  }
  return { errorCount, warningCount, errorRules, warningRules, ignoredRules };
}

/**
 * Exactly the derived half of an index cell, so an edit can hand `patchCell`
 * the whole thing rather than the caller assembling it field by field and
 * forgetting the one added last.
 */
export interface CellPatchCounts {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly errorRules: readonly RuleId[];
  readonly warningRules: readonly RuleId[];
  readonly ignoredRules: readonly RuleId[];
}

/**
 * The state an edit moves a target to when the client does not say.
 *
 * Emptying a target makes it untranslated again — the absent-or-empty signal is
 * authoritative and outranks any `state` attribute (requirements §4.2). Anything else a
 * human typed is reviewed.
 */
export const stateForEdit = (segments: readonly Segment[]): UnitState =>
  placeholderIds(segments).length === 0 && plainText(segments).trim() === ''
    ? 'untranslated'
    : 'reviewed';

/* ---- rows ---------------------------------------------------------------- */

export function toWireRow(row: IndexedRow, locales: readonly string[], ctx: DtoContext): UnitRow {
  const cells: Record<string, UnitCell> = {};
  for (const locale of locales) {
    const cell = row.cells.get(locale);
    if (!cell) {
      cells[locale] = { state: 'untranslated', error: false, missing: true, segments: [] };
      continue;
    }
    const pending = ctx.pendingOf(row.rowId, locale);
    cells[locale] = {
      state: pending?.state ?? cell.state,
      error: cell.errorCount > 0,
      // A pending edit for a unit the file does not have yet is not "missing":
      // it is about to exist, and the grid should show the text (FR-1.9).
      missing: cell.unit === undefined && pending === undefined,
      segments:
        pending !== undefined
          ? toWireSegments(pending.segments, GRID_TEXT_LIMIT)
          : cell.unit && cell.doc && cell.unit.target && !cell.unit.target.selfClosing
            ? gridSegments(cell.doc.raw, cell.unit.target.innerSpan)
            : [],
    };
  }

  return {
    rowId: row.rowId,
    unitId: row.unitId,
    group: row.group,
    customId: row.customId,
    isIcu: row.isIcu,
    source:
      row.sourceUnit && row.sourceDoc
        ? gridSegments(row.sourceDoc.raw, row.sourceUnit.source.innerSpan)
        : [],
    cells,
  };
}

/* ---- detail -------------------------------------------------------------- */

/** An orphan's own `<source>`, from the first requested locale that has the unit. */
function orphanSourceOf(
  row: IndexedRow,
  locales: readonly string[],
): ReturnType<typeof fullSegments> | null {
  if (row.sourceUnit !== undefined) return null;
  for (const locale of [...locales, ...row.cells.keys()]) {
    const cell = row.cells.get(locale);
    if (cell?.unit && cell.doc) return fullSegments(cell.doc.raw, cell.unit.source.innerSpan);
  }
  return null;
}

export function toWireDetail(
  row: IndexedRow,
  locales: readonly string[],
  ctx: DtoContext,
): UnitDetail {
  const sourceUnit = row.sourceUnit;
  const sourceDoc = row.sourceDoc;
  const sourceSegments = sourceSegmentsOf(row);

  const files: Record<string, string> = {};
  const targets: UnitTarget[] = [];

  for (const locale of locales) {
    const cell = row.cells.get(locale);
    if (!cell) continue;
    if (cell.relPath) files[locale] = cell.relPath;
    targets.push(buildTarget(row, locale, ctx, sourceSegments));
  }

  return {
    rowId: row.rowId,
    unitId: row.unitId,
    group: row.group,
    customId: row.customId,
    isIcu: row.isIcu,
    sourceLocale: ctx.sourceLocale,
    source:
      orphanSourceOf(row, locales) ??
      fullSegments(sourceDoc?.raw ?? '', sourceUnit?.source.innerSpan ?? { start: 0, end: 0 }),
    notes: effectiveNotes(row, ctx.notesPendingOf).map((n) => ({ ...n })),
    notesFile: sourceDoc === undefined ? null : (ctx.fileAt(sourceDoc.path)?.relPath ?? null),
    notesFileIsTemplate:
      sourceDoc !== undefined && (ctx.fileAt(sourceDoc.path)?.isTemplate ?? false),
    notesPending: ctx.notesPendingOf(row.rowId) !== undefined,
    locations: (sourceUnit?.contextGroups ?? [])
      .filter((g) => g.purpose === 'location' && g.sourcefile !== undefined)
      .map((g) => ({ sourcefile: g.sourcefile as string, linenumber: g.linenumber ?? null })),
    targets,
    files,
  };
}

/**
 * The DTO context for the currently open project.
 *
 * A function rather than a stored object so a change to the project's severities
 * or a newly committed edit is picked up on the next request without anyone
 * having to remember to invalidate anything.
 */
export function dtoContextOf(projects: {
  current: {
    sourceLocale: string;
    severities: Readonly<Record<RuleId, Severity>>;
    files: readonly ScannedFile[];
    glossary?: readonly Term[];
  } | null;
  pendingFor: PendingLookup;
  pendingNotesFor: (rowId: string) => PendingNotes | undefined;
  machineOrigins: ReadonlyMap<string, MachineOrigin>;
  reasonsFor: (rowId: string, locale: string) => readonly string[];
  ignoredFindings: IgnoredFindings;
}): DtoContext {
  const project = projects.current;
  return {
    sourceLocale: project?.sourceLocale ?? '',
    severities: project?.severities ?? ({} as Record<RuleId, Severity>),
    glossaryFor: (locale) => glossaryChecks(project?.glossary ?? [], locale),
    pendingOf: (rowId, locale) => projects.pendingFor(rowId, locale),
    notesPendingOf: (rowId) => projects.pendingNotesFor(rowId),
    // A document path names one file; `fileIndex` only matters for multi-<file> docs.
    fileAt: (path) => project?.files.find((f) => f.path === path),
    originOf: (rowId, locale) => projects.machineOrigins.get(originKey(rowId, locale)),
    reasonsOf: (rowId, locale) => projects.reasonsFor(rowId, locale),
    ignoredOf: (row, locale) =>
      projects.ignoredFindings.rulesFor(row.rowId, locale, () =>
        sourceHash(sourceTextOf(row, locale)),
      ),
    hasFile: (group, locale) =>
      project?.files.some((f) => f.group === group && f.locale === locale) ?? false,
    proposeFile: (group, locale) => {
      // The convention is read off a sibling, exactly as the create route reads
      // it — same function, so the name shown is the name written.
      const sibling =
        project?.files.find((f) => f.group === group && f.locale !== null && !f.isTemplate) ??
        project?.files.find((f) => f.group === group);
      return sibling === undefined ? null : newLocaleFilePath(sibling, locale).relPath;
    },
  };
}
