// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  DEFAULT_SEVERITIES,
  hasTargetContent,
  looksLikeIcu,
  readUnitState,
  validateUnit,
  type Finding,
  type GlossaryCheck,
  type LoadedDocument,
  type RuleId,
  type Severity,
  type TransUnit,
  type UnitState,
} from '@lexi/xliff';
import { rowIdOf, type GridFilter } from '@lexi/shared';

import { glossaryChecks } from './termbase.js';
import { sourceHash, type OpenProject } from './project-service.js';
import type { FinalMarkers } from '../lib/final-marker.js';
import { originKey, targetHash, type MachineOrigins } from '../lib/machine-origin.js';
import { IgnoredFindings } from '../lib/ignored-findings.js';

/**
 * The row model behind the grid, built once when a project opens.
 *
 * Until M5 every unit-level question re-walked
 * `files -> documents.get(path) -> files[fileIndex].units` from scratch. That is
 * fine for a dashboard rollup computed twice; it is not fine for a query that
 * runs on every keystroke over twenty locales by twenty thousand units.
 *
 * The shape:
 * `group -> unitId -> locale -> unit`, which yields all six FR-2.2 counters in
 * a single pass — including the two the dashboard could not compute before,
 * "missing entirely from the file" and "orphan, present in the target but not
 * the source".
 *
 * WHAT IS PRECOMPUTED AND WHY. Everything the filters and the search need, so
 * that a query is a linear scan over primitives and never touches the XML
 * again: lowercase haystacks (FR-3.5's budget is 200 ms end to end, of which
 * the server gets about 30), and per-cell error counts (the "has validation
 * errors" facet is a project-wide count, so it cannot be computed lazily).
 *
 * What is NOT precomputed: segments. At this scale eager segment arrays run to
 * hundreds of megabytes, which is exactly why `segmentsOf` is lazy. Rows are
 * segmented per request, for the ~200 the viewport actually asked for.
 */

/**
 * Shared by every cell with nothing wrong with it, which at 20k x 10 is almost
 * all of them: the rule arrays cost one frozen empty array for the project
 * rather than 200,000 allocations.
 */
const NO_RULES: readonly RuleId[] = Object.freeze([]);

export interface IndexedCell {
  /** Absent when the unit does not exist in this locale's file at all. */
  readonly unit: TransUnit | undefined;
  readonly doc: LoadedDocument | undefined;
  readonly relPath: string | undefined;
  readonly state: UnitState;
  readonly errorCount: number;
  readonly warningCount: number;
  /**
   * WHICH rules fired, not just how many — M7's needs-attention rail asks
   * "which locales are missing plural categories", and a count cannot answer
   * it. Stored per cell rather than aggregated once at build time because
   * `patchCell` must be able to move the figure: an aggregate computed here
   * would silently go stale the moment somebody fixes a string.
   */
  readonly errorRules: readonly RuleId[];
  readonly warningRules: readonly RuleId[];
  /**
   * Rules that fired but were ignored for this cell (`.lexi/ignored-findings.json`).
   * Kept out of the counts and rule lists above, and kept HERE so the Issues
   * screen can say "5 findings ignored" about findings that still fire, rather
   * than about entries in a file.
   */
  readonly ignoredRules: readonly RuleId[];
  readonly targetLower: string;
}

/** The derived half of a cell — everything a pending edit can change. */
export interface CellPatch {
  readonly state: UnitState;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly errorRules: readonly RuleId[];
  readonly warningRules: readonly RuleId[];
  readonly ignoredRules: readonly RuleId[];
  readonly targetLower: string;
}

/**
 * The source text a cell is validated against: the source file's, or for an
 * orphan the unit's own copy, since Angular writes the source into every file.
 * What an ignore's hash is checked against.
 */
export const sourceTextOf = (row: IndexedRow, locale: string): string =>
  row.sourceUnit?.sourcePlain ?? row.cells.get(locale)?.unit?.sourcePlain ?? '';

export interface IndexedRow {
  readonly rowId: string;
  readonly unitId: string;
  readonly group: string;
  /** A developer-assigned `@@customId` rather than a content hash (FR-2.5b). */
  readonly customId: boolean;
  readonly isIcu: boolean;
  readonly hasNote: boolean;
  /** The source text hashes differently than it did at the last open (FR-2.5b). */
  readonly stale: boolean;
  /** Present in a target file but absent from the source (FR-2.2). */
  readonly orphan: boolean;
  readonly sourceUnit: TransUnit | undefined;
  readonly sourceDoc: LoadedDocument | undefined;
  readonly idLower: string;
  readonly sourceLower: string;
  readonly notesLower: string;
  readonly cells: ReadonlyMap<string, IndexedCell>;
}

export interface IndexStats {
  readonly rows: number;
  readonly cells: number;
  readonly buildMs: number;
  readonly validateMs: number;
  /** FR-2.5b's health metric: the share of units on stable ids. */
  readonly customIdShare: number;
}

/**
 * Angular's auto-generated ids are content hashes — long, and hex or decimal
 * throughout. Anything else came from `@@myId` in a template and is stable
 * across a source edit, which is the distinction FR-2.5b asks us to report.
 */
const isCustomId = (id: string): boolean => !/^[0-9a-f]{10,}$/i.test(id);

/**
 * `draftMachine`, but only while the file still holds the bytes the model wrote.
 *
 * This is the only way that state can ever be reached: XLIFF 1.2 has no
 * `subState`, so `readUnitState` cannot tell a machine draft from a human one
 * and never returns it. The marker lives in `.lexi/state.json` (requirements §4.2 option
 * (a)) and is believed only when the target's bytes still hash to what the
 * draft wrote — otherwise somebody has since edited the string, in Lexi or in
 * an editor, and calling their work a machine draft would be a lie that never
 * expires.
 *
 * Hashing is per MARKED cell, not per cell: at 20k x 10 the alternative is
 * 200,000 sha256 calls on every index build to answer a question about a few
 * hundred of them.
 */
function machineState(
  raw: string,
  unit: TransUnit,
  origin: { readonly hash: string } | undefined,
): UnitState | undefined {
  if (origin === undefined || unit.target === undefined || unit.target.selfClosing)
    return undefined;
  const inner = raw.slice(unit.target.innerSpan.start, unit.target.innerSpan.end);
  return targetHash(inner) === origin.hash ? 'draftMachine' : undefined;
}

/**
 * `final`, but only while the file still holds the bytes the import wrote.
 *
 * The same guard as `machineState`, for the same reason. The marker exists
 * because a file with no `state` attributes cannot say "final" itself
 * (`lib/final-marker.ts`); an edit since the import makes the marker a lie, so
 * the hash retires it.
 */
function finalState(
  raw: string,
  unit: TransUnit,
  final: { readonly hash: string } | undefined,
): UnitState | undefined {
  if (final === undefined || unit.target === undefined || unit.target.selfClosing)
    return undefined;
  const inner = raw.slice(unit.target.innerSpan.start, unit.target.innerSpan.end);
  return targetHash(inner) === final.hash ? 'final' : undefined;
}

/**
 * A cell's state as the FILE reads it, with no pending edit over it — what the
 * index is built with, and what a discard or an undo has to put back, since a
 * commit overwrote it with the pending edit's state.
 *
 * Every caller must pass the cell's final marker as well as its origin:
 * leaving it out would make a discard over a final cell read `reviewed`.
 */
export function fileCellState(
  doc: LoadedDocument,
  unit: TransUnit,
  origin: { readonly hash: string } | undefined,
  final?: { readonly hash: string },
): UnitState {
  return hasTargetContent(unit)
    ? (machineState(doc.raw, unit, origin) ??
        finalState(doc.raw, unit, final) ??
        readUnitState(unit))
    : 'untranslated';
}

export class UnitIndex {
  readonly rows: readonly IndexedRow[];
  readonly byRowId: ReadonlyMap<string, IndexedRow>;
  readonly locales: readonly string[];
  readonly groups: readonly string[];
  readonly stats: IndexStats;

  constructor(
    project: OpenProject,
    previousHashes: Readonly<Record<string, string>> = {},
    origins: MachineOrigins = new Map(),
    ignored: IgnoredFindings = new IgnoredFindings(),
    finalMarkers: FinalMarkers = new Map(),
  ) {
    const started = performance.now();
    let validateMs = 0;

    // FR-8.2: the project's own choices, over the engine's defaults for any rule
    // nobody has configured. The per-cell error flags cached below are what the
    // grid's facets and the dashboard count, so they must agree with the panel.
    const severities: Readonly<Record<RuleId, Severity>> = {
      ...DEFAULT_SEVERITIES,
      ...project.severities,
    };
    const sourceLocale = project.sourceLocale;
    // Resolved once per locale, not once per cell: 20k units x 10 locales
    // would otherwise re-filter the glossary two hundred thousand times.
    const checksByLocale = new Map<string, GlossaryCheck[]>();
    const glossaryFor = (locale: string): GlossaryCheck[] => {
      let checks = checksByLocale.get(locale);
      if (checks === undefined) {
        checks = glossaryChecks(project.glossary ?? [], locale);
        checksByLocale.set(locale, checks);
      }
      return checks;
    };

    interface Builder {
      sourceUnit?: TransUnit;
      sourceDoc?: LoadedDocument;
      /** Document order in the source file, so the grid reads like the file. */
      order: number;
      readonly cells: Map<string, { unit: TransUnit; doc: LoadedDocument; relPath: string }>;
    }

    const byGroup = new Map<string, Map<string, Builder>>();
    const localeSet = new Set<string>();

    for (const file of project.files) {
      if (file.locale === null) continue;
      const doc = project.documents.get(file.path);
      const xf = doc?.files[file.fileIndex];
      if (!doc || !xf) continue;

      // The extraction template carries the source strings even when its
      // `target-language` was never touched, so it counts as a source file.
      const isSource = file.locale === sourceLocale || file.isTemplate;
      if (!isSource) localeSet.add(file.locale);

      let groupMap = byGroup.get(file.group);
      if (!groupMap) {
        groupMap = new Map();
        byGroup.set(file.group, groupMap);
      }

      let order = 0;
      for (const unit of xf.units) {
        let builder = groupMap.get(unit.id);
        if (!builder) {
          builder = { order: Number.MAX_SAFE_INTEGER, cells: new Map() };
          groupMap.set(unit.id, builder);
        }
        if (isSource) {
          builder.sourceUnit = unit;
          builder.sourceDoc = doc;
          builder.order = order;
        } else {
          builder.cells.set(file.locale, { unit, doc, relPath: file.relPath });
        }
        order += 1;
      }
    }

    const locales = [...localeSet].sort((a, b) => a.localeCompare(b));
    const groups = [...byGroup.keys()].sort((a, b) => a.localeCompare(b));

    const rows: IndexedRow[] = [];
    let cellCount = 0;
    let customIds = 0;

    for (const group of groups) {
      const groupMap = byGroup.get(group);
      if (!groupMap) continue;

      // Source order first, orphans after — a row with no source has no place
      // in the file's sequence, and burying them mid-list hides them.
      const entries = [...groupMap.entries()].sort(([idA, a], [idB, b]) =>
        a.order === b.order ? idA.localeCompare(idB) : a.order - b.order,
      );

      for (const [unitId, builder] of entries) {
        const sourceUnit = builder.sourceUnit;
        const cells = new Map<string, IndexedCell>();
        // The row id first; a bare unit id is M4's shape, which had no group
        // to disambiguate by and is accepted only as a fallback.
        const rowId = rowIdOf(group, unitId);

        for (const locale of locales) {
          const found = builder.cells.get(locale);
          if (!found) {
            cells.set(locale, {
              unit: undefined,
              doc: undefined,
              relPath: undefined,
              state: 'untranslated',
              errorCount: 0,
              warningCount: 0,
              errorRules: NO_RULES,
              warningRules: NO_RULES,
              ignoredRules: NO_RULES,
              targetLower: '',
            });
            continue;
          }

          const translated = hasTargetContent(found.unit);

          let errorCount = 0;
          let warningCount = 0;
          let errorRules: RuleId[] | undefined;
          let warningRules: RuleId[] | undefined;
          let ignoredRules: RuleId[] | undefined;
          /**
           * Validate only a cell that HAS a translation, and only against a
           * real source.
           *
           * The empty case is the important one. `target.empty` is an error by
           * default and rightly so — an empty target ships an empty string to
           * users — but counting it here would make "has validation errors" a
           * second, worse spelling of "untranslated": in a fresh project every
           * untranslated cell would carry an error, the rail would read
           * "Untranslated 140 · Has validation errors 140", and the filter that
           * is supposed to surface the seven genuinely broken strings would be
           * useless. The two are different questions and the rail asks them
           * separately (S4's left rail: "Untranslated 140" beside "Has
           * validation errors 7").
           *
           * An ORPHAN is still validated, though. The first version of this
           * skipped it — "no source unit, nothing to compare against" — which
           * was simply wrong: every `<trans-unit>` carries its own `<source>`,
           * because Angular writes the source text into each translation file.
           * So the comparison is not only possible, it is the right one. It
           * cost the Polish ICU unit in `testdata/northwind`, which exists to
           * trip FR-PH-5's plural-category check and silently stopped doing so
           * — and plural coverage does not depend on the source file at all,
           * only on the target's own ICU and the target locale's CLDR
           * categories. Found by opening the fixture, not by a test.
           */
          if (translated) {
            const t0 = performance.now();
            const findings: Finding[] = validateUnit(found.doc.raw, found.unit, {
              sourceLocale,
              targetLocale: locale,
              severities,
              glossary: glossaryFor(locale),
            });
            validateMs += performance.now() - t0;
            const skip =
              findings.length > 0 && ignored.hasAny(rowId, locale)
                ? ignored.rulesFor(rowId, locale, () =>
                    sourceHash(builder.sourceUnit?.sourcePlain ?? found.unit.sourcePlain),
                  )
                : undefined;
            for (const f of findings) {
              if (skip?.has(f.rule)) {
                (ignoredRules ??= []).push(f.rule);
              } else if (f.severity === 'error') {
                errorCount += 1;
                (errorRules ??= []).push(f.rule);
              } else {
                warningCount += 1;
                (warningRules ??= []).push(f.rule);
              }
            }
          }

          cells.set(locale, {
            unit: found.unit,
            doc: found.doc,
            relPath: found.relPath,
            state: fileCellState(
              found.doc,
              found.unit,
              origins.get(originKey(rowId, locale)),
              finalMarkers.get(originKey(rowId, locale)),
            ),
            errorCount,
            warningCount,
            errorRules: errorRules ?? NO_RULES,
            warningRules: warningRules ?? NO_RULES,
            ignoredRules: ignoredRules ?? NO_RULES,
            targetLower: (found.unit.targetPlain ?? '').toLowerCase(),
          });
          cellCount += 1;
        }

        const notes = sourceUnit?.notes ?? [...builder.cells.values()][0]?.unit.notes ?? [];
        const sourcePlain = sourceUnit?.sourcePlain ?? '';
        const custom = isCustomId(unitId);
        if (custom) customIds += 1;

        const previous = previousHashes[rowId] ?? previousHashes[unitId];

        rows.push({
          rowId,
          unitId,
          group,
          customId: custom,
          isIcu: sourcePlain !== '' && looksLikeIcu(sourcePlain),
          hasNote: notes.length > 0,
          // Only a hash we have seen before can be stale. A unit that is new
          // since the last open is new, not drifted.
          stale:
            previous !== undefined && sourcePlain !== '' && previous !== sourceHash(sourcePlain),
          orphan: sourceUnit === undefined,
          sourceUnit,
          sourceDoc: builder.sourceDoc,
          idLower: unitId.toLowerCase(),
          sourceLower: sourcePlain.toLowerCase(),
          notesLower: notes
            .map((n) => n.text)
            .join(' ')
            .toLowerCase(),
          cells,
        });
      }
    }

    this.rows = rows;
    this.byRowId = new Map(rows.map((r) => [r.rowId, r]));
    this.locales = locales;
    this.groups = groups;
    this.stats = {
      rows: rows.length,
      cells: cellCount,
      buildMs: Math.round(performance.now() - started),
      validateMs: Math.round(validateMs),
      customIdShare: rows.length === 0 ? 0 : Math.round((customIds / rows.length) * 1000) / 10,
    };
  }

  /**
   * Does this row satisfy one filter, considering only `locales`?
   *
   * "Untranslated" has to mean untranslated IN SOMETHING, and the answer
   * differs per locale — so every per-cell filter is an ANY over the locales in
   * scope. A row counts as untranslated when at least one visible locale lacks
   * a translation, which is what makes the rail's count match what the user is
   * looking at.
   */
  /**
   * Overwrite the derived half of one cell, in place.
   *
   * A pending edit changes what the grid, the rail and the dashboard should say
   * about exactly one cell, and nothing else. Rebuilding the index for that
   * costs 491 ms at 20k x 10 (`units-perf.test.ts`), so it cannot run per edit —
   * and it does not need to: `unit` and `doc` keep pointing at the document,
   * which genuinely has not changed, because pending edits live in an overlay
   * and the files stay pristine until save.
   *
   * Everything downstream recomputes from the index on every call — `runQuery`
   * scans rows for the facets, `summaries()` scans them for FR-2.2's six
   * counters — so patching one cell is the whole invalidation story.
   */
  patchCell(rowId: string, locale: string, patch: CellPatch): void {
    const row = this.byRowId.get(rowId);
    const cell = row?.cells.get(locale);
    if (row === undefined || cell === undefined) return;
    (row.cells as Map<string, IndexedCell>).set(locale, { ...cell, ...patch });
  }

  /**
   * A pending note edit (FR-4.2) changes the row's "has a note" and what search
   * finds in its notes — both derived here, so the row is replaced in place for
   * the same reason `patchCell` exists: a rebuild per keystroke-paced edit is
   * half a second at 20k x 10.
   */
  patchNotes(rowId: string, notes: readonly { readonly text: string }[]): void {
    const row = this.byRowId.get(rowId);
    if (row === undefined) return;
    const next: IndexedRow = {
      ...row,
      hasNote: notes.length > 0,
      notesLower: notes
        .map((n) => n.text)
        .join(' ')
        .toLowerCase(),
    };
    (this.byRowId as Map<string, IndexedRow>).set(rowId, next);
    const at = this.rows.indexOf(row);
    if (at !== -1) (this.rows as IndexedRow[])[at] = next;
  }

  matches(row: IndexedRow, filter: GridFilter, locales: readonly string[]): boolean {
    switch (filter) {
      case 'untranslated':
        return locales.some((l) => (row.cells.get(l)?.state ?? 'untranslated') === 'untranslated');
      case 'needsReview':
        return locales.some((l) => row.cells.get(l)?.state === 'needsReview');
      case 'machineDrafts':
        return locales.some((l) => row.cells.get(l)?.state === 'draftMachine');
      case 'toReview': {
        const reviewable = new Set(['needsReview', 'draftMachine']);
        return locales.some((l) => reviewable.has(row.cells.get(l)?.state ?? ''));
      }
      case 'hasErrors':
        return locales.some((l) => (row.cells.get(l)?.errorCount ?? 0) > 0);
      case 'stale':
        return row.stale;
      case 'noNote':
        return !row.hasNote;
      case 'icuOnly':
        return row.isIcu;
    }
  }
}
