// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  DEFAULT_SEVERITIES,
  fileGroupOf,
  loadDocument,
  saveDocument,
  setFileAttr,
  type LoadedDocument,
  type NoteSpec,
  type RuleId,
  type Segment,
  type Severity,
  type UnitState,
} from '@lexi/xliff';
import {
  isRtlLocale,
  rowIdOf,
  type EditRateLocaleStats,
  type EscapePolicy,
  type FileMapping,
  type Term,
  type GridFilter,
  type HistoryStatus,
  type LocaleSummary,
  type Project,
  type ProjectHealth,
  type RuleIssue,
  type ScannedFile,
  type WriteStateMode,
} from '@lexi/shared';

import type { ScanOutcome } from './scan-project.js';
import { UnitIndex, type IndexedRow } from './unit-index.js';
import type { FinalMarker, FinalMarkers } from '../lib/final-marker.js';
import { originKey, type MachineOrigin, type MachineOrigins } from '../lib/machine-origin.js';
import { recordOutcome, type ReviewOutcome, type ReviewStats } from '../lib/review-stats.js';
import { noteKey, type ReviewNotes } from '../lib/review-notes.js';
import { IgnoredFindings } from '../lib/ignored-findings.js';
import { syncPendingIntoIndex } from '../lib/drafts.js';
import { HISTORY_LIMIT, pruneSteps, statusOf, type UndoStep } from '../lib/history.js';

/**
 * The open project, in memory.
 *
 * No SQLite: the server holds the parsed
 * documents anyway, and only readable files under `.lexi/` persist. One instance
 * per process, created in `buildApp` and passed to the routes by argument —
 * the same convention `cfg` already uses, and there is no Fastify decorator
 * anywhere in this codebase to be consistent with instead.
 */

export interface OpenProject {
  readonly path: string;
  readonly name: string;
  sourceLocale: string;
  visibleLocales: readonly string[];
  /** The grid's ticked filter boxes, restored from `.lexi/project.json`. */
  filters: readonly GridFilter[];
  readonly files: readonly ScannedFile[];
  readonly documents: ReadonlyMap<string, LoadedDocument>;
  /** path -> fileIndex -> confirmed locale, as the wizard left it. */
  readonly localeOf: ReadonlyMap<string, string>;
  readonly openedAt: string;
  /** See `ProjectSchema.writeState`. `auto` is the NFR-8 default. */
  writeState: WriteStateMode;
  escapePolicy: EscapePolicy;
  severities: Readonly<Record<RuleId, Severity>>;
  /**
   * `.lexi/termbase.csv`, held in memory for FR-8.1's glossary rules: the row
   * model is built synchronously, so the validator cannot await the file.
   * Replaced (never mutated) by `setGlossary` on every term base write.
   */
  glossary: readonly Term[];
}

/**
 * One unit's notes as the user wants them, before they are saved (FR-4.2).
 *
 * Its own overlay beside the target edits, because the unit of change is
 * different: a target edit is one cell (row x locale), a note edit is the ROW —
 * notes are written to the source-locale file, where every locale and the
 * prompt read them. Stated as the whole desired list plus the list it was
 * based on (`original`), never as spans: spans move on a reload, and `original`
 * is what lets a reload tell "still applies" from "the file changed under it".
 */
export interface PendingNotes {
  readonly rowId: string;
  /** The source-locale file the notes are written to. */
  readonly path: string;
  readonly unitId: string;
  readonly original: readonly NoteSpec[];
  readonly notes: readonly NoteSpec[];
  readonly at: string;
}

/**
 * One uncommitted target edit.
 *
 * THE DOCUMENTS STAY PRISTINE UNTIL SAVE. Splicing into `doc.raw` on every
 * commit was the obvious alternative and is wrong three times over:
 * `saveDocument` decides staleness by re-reading the file and comparing it
 * against `doc.raw`, so mutating that in memory makes every save throw; editing
 * one unit shifts the spans of every later unit in the same file, so each commit
 * would cost a full re-scan; and `applyEdits(raw, []) === raw`, the identity the
 * whole design rests on, only means anything while `raw` is what came off disk.
 *
 * The segments are rebuilt — bytes re-attached — at COMMIT time rather than at
 * save time, because that is the moment the document is demonstrably current.
 * It leaves save as a compose-and-splice with no lookups left to fail.
 */
export interface PendingEdit {
  readonly rowId: string;
  readonly locale: string;
  readonly path: string;
  readonly unitId: string;
  readonly segments: readonly Segment[];
  readonly state: UnitState;
  readonly at: string;
  /**
   * The `<trans-unit>` is not in that file yet and saving has to insert it
   * (FR-1.9).
   *
   * It is a flag on the edit rather than a separate kind of pending thing
   * because everything else about it is identical — same overlay, same
   * validation, same save, same crash file. Only the splice differs: an
   * insertion into `<body>` instead of a replacement inside `<target>`.
   */
  readonly create?: boolean;
}

const draftKey = (rowId: string, locale: string): string => `${rowId}\u0000${locale}`;

/**
 * One entry in `.lexi/sources.json`.
 *
 * M4 wrote a bare `unitId -> hash` map. M5 widened it, for two reasons.
 *
 * The first is that the row model finally knows the other three things FR-2.5a
 * will score orphan pairings on: the source file, the line, and the
 * `from="meaning"` note.
 *
 * The second is a bug the flat map could not express. A unit id is unique
 * within a file group, NOT within a project (FR-1.4) — `messages` and
 * `checkout/messages` may both define `pay`, with different English. Keyed by
 * id alone the second one overwrites the first, so every subsequent open
 * reported one of them as drifted. Entries are therefore nested by group.
 */
export interface SourceRecord {
  readonly hash: string;
  readonly sourcefile?: string;
  readonly line?: string;
  readonly meaning?: string;
}

/** The whole file. `version` is here so a future change can be detected, not guessed. */
export interface SourcesFile {
  readonly version: 2;
  readonly groups: Record<string, Record<string, SourceRecord>>;
}

/**
 * Read either shape of `sources.json` back as a hash lookup.
 *
 * Keys are row ids (`group + separator + unitId`) for the current shape and
 * bare unit ids for M4's, so the index can try the precise key first and fall
 * back. Both shapes are in the wild the moment anyone upgrades with a project
 * already committed, and a reader that rejected the old one would report every
 * unit in the project as drifted on the first open after the upgrade.
 */
export const previousHashesOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== 'object') return out;

  const file = raw as Partial<SourcesFile> & Record<string, unknown>;
  if (file.version === 2 && file.groups && typeof file.groups === 'object') {
    for (const [group, units] of Object.entries(file.groups)) {
      for (const [unitId, record] of Object.entries(units)) {
        if (typeof record?.hash === 'string') out[rowIdOf(group, unitId)] = record.hash;
      }
    }
    return out;
  }

  // M4: a flat `unitId -> hash` map, with no group to disambiguate by.
  for (const [id, value] of Object.entries(file)) {
    if (typeof value === 'string') out[id] = value;
  }
  return out;
};

/** The key the mapping is stored under: one `<file>` element, not one path. */
export const fileKey = (path: string, fileIndex: number): string => `${path}#${fileIndex}`;

/**
 * Normalised source text, hashed. The basis of `.lexi/sources.json` and the
 * only way FR-2.5b drift detection can ever be added — a hash not written now
 * cannot be recovered later.
 */
export const sourceHash = (text: string): string =>
  createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

export class ProjectService {
  #project: OpenProject | null = null;
  /** The last scan, so `open` need not re-read the whole tree. */
  #lastScan: { root: string; outcome: ScanOutcome } | null = null;
  /** The grid's row model. Derived from the documents; rebuilt, never patched. */
  #index: UnitIndex | null = null;
  /** `sources.json` as it was BEFORE this open, which is what makes drift visible. */
  #previousHashes: Readonly<Record<string, string>> = {};
  /** Uncommitted target edits. The files on disk know nothing about these. */
  #pending = new Map<string, PendingEdit>();
  #pendingNotes = new Map<string, PendingNotes>();
  /** Undo and redo for the overlay — see `lib/history.ts`. In memory only. */
  #undo: UndoStep[] = [];
  #redo: UndoStep[] = [];
  /** `.lexi/state.json`: which targets a model wrote (requirements §4.2, option (a)). */
  #origins: MachineOrigins = new Map();
  /** `.lexi/final.json`: targets imported as `final` into a file that cannot say so. */
  #finals: FinalMarkers = new Map();
  /** `.lexi/review-stats.json`: FR-7.4's edit-rate counter, per locale. */
  #reviewStats: ReviewStats = new Map();
  /** `.lexi/review-notes.json`: why a reviewer rejected a draft (S11). */
  #reviewNotes: ReviewNotes = new Map();
  /** `.lexi/ignored-findings.json`: findings ignored per cell (S12). */
  #ignored = new IgnoredFindings();
  /** When the row model was last built, epoch ms — the Issues screen's "Validated 14:09". */
  #validatedAt = 0;
  /** Saves are serialized: `saveDocument`'s check-then-write is not atomic. */
  #saveChain: Promise<unknown> = Promise.resolve();

  get current(): OpenProject | null {
    return this.#project;
  }

  /** Null only when no project is open. */
  get index(): UnitIndex | null {
    return this.#index;
  }

  get isOpen(): boolean {
    return this.#project !== null;
  }

  rememberScan(root: string, outcome: ScanOutcome): void {
    this.#lastScan = { root, outcome };
  }

  scanFor(root: string): ScanOutcome | null {
    return this.#lastScan?.root === root ? this.#lastScan.outcome : null;
  }

  /**
   * `previousHashes` is `.lexi/sources.json` as it was read BEFORE this open
   * overwrites it. Without it "stale source" is unanswerable: the file is
   * rewritten from the current text on every open, so comparing against the
   * freshly written copy would report zero drift by construction.
   */
  open(
    root: string,
    outcome: ScanOutcome,
    mapping: readonly FileMapping[],
    sourceLocale: string,
    previousHashes: Readonly<Record<string, string>> = {},
    origins: MachineOrigins = new Map(),
    reviewStats: ReviewStats = new Map(),
    reviewNotes: ReviewNotes = new Map(),
    glossary: readonly Term[] = [],
    ignored: IgnoredFindings = new IgnoredFindings(),
    finalMarkers: FinalMarkers = new Map(),
  ): OpenProject {
    const localeOf = new Map(mapping.map((m) => [fileKey(m.path, m.fileIndex), m.locale]));

    // The confirmed mapping overrides what detection guessed — that is the
    // entire point of the confirmation step (FR-1.3). The group follows it: a
    // bare `en.xlf` with no `target-language` was grouped as `en` by detection,
    // and once confirmed as `en` it belongs in `''` beside `de-DE.xlf`.
    const files = outcome.files.map((f) => {
      const locale = localeOf.get(fileKey(f.path, f.fileIndex)) ?? f.locale;
      return { ...f, locale, group: fileGroupOf(f.relPath, locale ?? undefined) };
    });

    this.#project = {
      path: root,
      name: basename(root) || root,
      sourceLocale,
      // Three columns is the mock's default; a persisted choice overwrites it
      // immediately afterwards when `.lexi/project.json` had one (FR-3.2).
      visibleLocales: [
        ...new Set(files.map((f) => f.locale).filter((l): l is string => l !== null)),
      ]
        .filter((l) => l !== sourceLocale)
        .slice(0, 3),
      filters: [],
      files,
      documents: outcome.documents,
      localeOf,
      openedAt: new Date().toISOString(),
      writeState: 'auto',
      escapePolicy: 'angular',
      severities: { ...DEFAULT_SEVERITIES },
      glossary,
    };
    this.#previousHashes = previousHashes;
    this.#origins = origins;
    this.#reviewStats = reviewStats;
    this.#reviewNotes = reviewNotes;
    this.#ignored = ignored;
    this.#finals = finalMarkers;
    this.#index = new UnitIndex(this.#project, previousHashes, origins, ignored, finalMarkers);
    this.#validatedAt = Date.now();
    return this.#project;
  }

  /**
   * Rebuild the row model: after a source-locale or severity change, a glossary
   * write, a save, a reload, or the Issues screen's "Revalidate".
   *
   * The index is built from the FILES, so the pending overlay is folded back in
   * straight away. Leaving that to each caller is how three of them forgot it,
   * and every unsaved draft's findings silently vanished from the counts after
   * a severity change.
   */
  rebuildIndex(): void {
    this.#index = this.#project
      ? new UnitIndex(
          this.#project,
          this.#previousHashes,
          this.#origins,
          this.#ignored,
          this.#finals,
        )
      : null;
    this.#validatedAt = Date.now();
    if (this.#index !== null) syncPendingIntoIndex(this);
  }

  get validatedAt(): number {
    return this.#validatedAt;
  }

  /**
   * A term base write changes what two rules find in every cell, so the row
   * model is rebuilt — the same reason a severity change rebuilds it.
   */
  setGlossary(terms: readonly Term[]): void {
    if (!this.#project) return;
    this.#project.glossary = terms;
    this.rebuildIndex();
  }

  /** The project's target locales, in the order the grid and the Term Base show them. */
  targetLocales(): string[] {
    return [...(this.#index?.locales ?? [])];
  }

  close(): void {
    this.#project = null;
    this.#index = null;
    this.#previousHashes = {};
    this.#pending.clear();
    this.#pendingNotes.clear();
    this.#origins.clear();
    this.#finals.clear();
    this.#reviewStats = new Map();
    this.#reviewNotes.clear();
    this.#ignored = new IgnoredFindings();
    this.#validatedAt = 0;
    this.clearHistory();
  }

  /* ---- ignored findings (S12) --------------------------------------------- */

  /** See `lib/ignored-findings.ts`. Mutated in place; the caller patches the index. */
  get ignoredFindings(): IgnoredFindings {
    return this.#ignored;
  }

  /* ---- machine origin (M9) ----------------------------------------------- */

  /**
   * Which targets a model wrote, and the bytes it wrote — see
   * `lib/machine-origin.ts` for why the bytes are part of the record.
   *
   * Held here rather than on `OpenProject` because the index has to be handed
   * the whole map at construction time, and because clearing one marker must
   * not require rebuilding the project object.
   */
  get machineOrigins(): MachineOrigins {
    return this.#origins;
  }

  setMachineOrigin(rowId: string, locale: string, origin: MachineOrigin): void {
    this.#origins.set(originKey(rowId, locale), origin);
  }

  /** True when a marker was actually removed, so the caller can skip a write. */
  clearMachineOrigin(rowId: string, locale: string): boolean {
    return this.#origins.delete(originKey(rowId, locale));
  }

  /* ---- final markers ------------------------------------------------------ */

  /** See `lib/final-marker.ts`: held beside the origins, handed to the index the same way. */
  get finalMarkers(): FinalMarkers {
    return this.#finals;
  }

  setFinalMarker(rowId: string, locale: string, marker: FinalMarker): void {
    this.#finals.set(originKey(rowId, locale), marker);
  }

  /** True when a marker was actually removed, so the caller can skip a write. */
  clearFinalMarker(rowId: string, locale: string): boolean {
    return this.#finals.delete(originKey(rowId, locale));
  }

  /* ---- review stats (M12) ------------------------------------------------- */

  /** FR-7.4's edit rate, per locale. See `lib/review-stats.ts` for why it is
   * machine-local rather than committed alongside `state.json`. */
  get reviewStats(): ReviewStats {
    return this.#reviewStats;
  }

  recordReviewOutcome(locale: string, outcome: ReviewOutcome): void {
    this.#reviewStats = recordOutcome(this.#reviewStats, locale, outcome);
  }

  /** An undo putting the counters back as they were before the step. */
  replaceReviewStats(stats: ReviewStats): void {
    this.#reviewStats = stats;
  }

  /* ---- review notes (M14) ------------------------------------------------- */

  /** S11's reject-reason chips. See `lib/review-notes.ts`. */
  get reviewNotes(): ReviewNotes {
    return this.#reviewNotes;
  }

  reasonsFor(rowId: string, locale: string): readonly string[] {
    return this.#reviewNotes.get(noteKey(rowId, locale)) ?? [];
  }

  /**
   * Returns true when the file actually needs rewriting, so an ordinary edit —
   * which clears reasons that were never there — costs no write at all.
   */
  setReviewReasons(rowId: string, locale: string, reasons: readonly string[]): boolean {
    const key = noteKey(rowId, locale);
    const before = this.#reviewNotes.get(key);
    if (reasons.length === 0) return this.#reviewNotes.delete(key);
    if (
      before !== undefined &&
      before.length === reasons.length &&
      before.every((r, i) => r === reasons[i])
    ) {
      return false;
    }
    this.#reviewNotes.set(key, [...reasons]);
    return true;
  }

  /* ---- pending edits (M6) ------------------------------------------------ */

  get pending(): ReadonlyMap<string, PendingEdit> {
    return this.#pending;
  }

  get unsavedCount(): number {
    return this.#pending.size + this.#pendingNotes.size;
  }

  pendingFor(rowId: string, locale: string): PendingEdit | undefined {
    return this.#pending.get(draftKey(rowId, locale));
  }

  setPending(edit: PendingEdit): void {
    this.#pending.set(draftKey(edit.rowId, edit.locale), edit);
  }

  clearPending(rowId: string, locale: string): boolean {
    return this.#pending.delete(draftKey(rowId, locale));
  }

  /** Everything still uncommitted, grouped by the file it will be spliced into. */
  pendingByPath(): Map<string, PendingEdit[]> {
    const byPath = new Map<string, PendingEdit[]>();
    for (const edit of this.#pending.values()) {
      const list = byPath.get(edit.path);
      if (list === undefined) byPath.set(edit.path, [edit]);
      else list.push(edit);
    }
    return byPath;
  }

  /* ---- pending note edits (FR-4.2) ---------------------------------------- */

  get pendingNotes(): ReadonlyMap<string, PendingNotes> {
    return this.#pendingNotes;
  }

  pendingNotesFor(rowId: string): PendingNotes | undefined {
    return this.#pendingNotes.get(rowId);
  }

  setPendingNotes(edit: PendingNotes): void {
    this.#pendingNotes.set(edit.rowId, edit);
  }

  clearPendingNotes(rowId: string): boolean {
    return this.#pendingNotes.delete(rowId);
  }

  /* ---- undo history ------------------------------------------------------- */

  get historyStatus(): HistoryStatus {
    return statusOf(this.#undo, this.#redo);
  }

  /** A new step from something the user did. Anything that could be redone no longer can. */
  recordStep(step: UndoStep): void {
    this.#undo.push(step);
    if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
    this.#redo = [];
  }

  takeUndo(): UndoStep | undefined {
    return this.#undo.pop();
  }

  takeRedo(): UndoStep | undefined {
    return this.#redo.pop();
  }

  /** The inverse of an undo, so redo can put it back. */
  pushRedo(step: UndoStep): void {
    this.#redo.push(step);
  }

  /** The inverse of a redo. Unlike `recordStep`, it leaves the redo stack alone. */
  pushUndo(step: UndoStep): void {
    this.#undo.push(step);
  }

  /** Something other than the user wrote into a cell: its old states are not theirs to restore. */
  pruneHistory(rowId: string, locale?: string): void {
    this.#undo = pruneSteps(this.#undo, rowId, locale);
    this.#redo = pruneSteps(this.#redo, rowId, locale);
  }

  clearHistory(): void {
    this.#undo = [];
    this.#redo = [];
  }

  /** Run `task` after every save already queued. */
  serializeSave<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#saveChain.then(task, task);
    // Keep the chain alive even when a save rejects, or one failure stops them all.
    this.#saveChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Register a file that did not exist when the project was opened (FR-1.9).
   *
   * The alternative — re-scanning and re-opening — would re-run the wizard's
   * whole confirmation path to learn one thing we already know, and would throw
   * away the mapping the user confirmed. `files` and `documents` are cast here
   * for the same reason `reloadDocument` casts `documents`: they are readonly
   * to callers, and this class is the one place allowed to move them.
   */
  addFile(file: ScannedFile, doc: LoadedDocument): void {
    const project = this.#project;
    if (!project) return;
    (project.files as ScannedFile[]).push(file);
    (project.documents as Map<string, LoadedDocument>).set(file.path, doc);
    (project.localeOf as Map<string, string>).set(
      fileKey(file.path, file.fileIndex),
      file.locale ?? '',
    );
    this.rebuildIndex();
  }

  /**
   * Replace a document after it was written, and refresh the rows that point at
   * it. Every span in the old snapshot refers to bytes that have moved.
   */
  async reloadDocument(path: string): Promise<void> {
    const project = this.#project;
    if (!project) return;
    const fresh = await loadDocument(path);
    (project.documents as Map<string, LoadedDocument>).set(path, fresh);
  }

  /**
   * Rewrite a stale `target-language` (FR-1.2b, the wizard's "Fix to pt-BR").
   *
   * One attribute, spliced — `setFileAttr` exists for exactly this — so the
   * result is a one-line diff and every other byte in the file is untouched.
   */
  async fixTargetLanguage(path: string, fileIndex: number, locale: string): Promise<boolean> {
    const doc = this.#lastScan?.outcome.documents.get(path);
    const file = doc?.files[fileIndex];
    if (!doc || !file) return false;
    if (file.attrs['target-language'] === locale) return false;

    const result = await saveDocument(doc, setFileAttr(doc, file, 'target-language', locale));
    return result.written;
  }

  /** `unitId -> sha256(normalised source)`, written to `.lexi/sources.json`. */
  /**
   * `.lexi/sources.json` — phase-2 groundwork, and the only thing here that
   * carries no weight today.
   *
   * It is written anyway because a value not recorded now cannot be recovered
   * later: FR-2.5 reconciliation has to pair a NEW unit (no translations, id
   * never seen) against an ORPHAN (translations, id gone from the source), and
   * FR-2.5a scores those pairs on source-text similarity, `sourcefile` plus a
   * near line number, and an identical `from="meaning"` note. All three inputs
   * exist in the scan today and none of them survive an `ng extract-i18n` run.
   * Reconstructing them after the fact means reading a git history that may not
   * have one.
   *
   * The hash alone has a second job from M5 on: compared against the current
   * text at the NEXT open, it is what makes "stale source" answerable
   * (see `restoreGridView`'s counterpart in routes/projects.ts).
   *
   * The shape stays additive — this file lands in the user's commits.
   */
  sourceHashes(): SourcesFile {
    const groups: Record<string, Record<string, SourceRecord>> = {};
    const index = this.#index;
    if (!index) return { version: 2, groups };

    for (const row of index.rows) {
      const unit = row.sourceUnit;
      if (!unit) continue;

      const location = unit.contextGroups.find(
        (g) => g.purpose === 'location' && g.sourcefile !== undefined,
      );
      const meaning = unit.notes.find((n) => n.attrs['from'] === 'meaning');

      (groups[row.group] ??= {})[row.unitId] = {
        hash: sourceHash(unit.sourcePlain),
        ...(location?.sourcefile === undefined ? {} : { sourcefile: location.sourcefile }),
        ...(location?.linenumber === undefined ? {} : { line: location.linenumber }),
        ...(meaning === undefined ? {} : { meaning: meaning.text }),
      };
    }
    return { version: 2, groups };
  }

  /**
   * The per-locale counters behind the dashboard (FR-2.2, FR-2.3).
   *
   * Read off the row model rather than by re-walking the documents, which is
   * what finally makes the last two of FR-2.2's six counters computable:
   * `missing` (the unit exists in the source but not in this locale's file at
   * all) and `orphans` (it exists here but no longer in the source). Neither is
   * derivable from one locale's units in isolation — they are statements about
   * the correlation, so they need the index.
   */
  summaries(): LocaleSummary[] {
    const project = this.#project;
    const index = this.#index;
    if (!project || !index) return [];

    const fileCounts = new Map<string, number>();
    for (const file of project.files) {
      if (file.locale === null) continue;
      fileCounts.set(file.locale, (fileCounts.get(file.locale) ?? 0) + 1);
    }

    return index.locales
      .map((locale) => {
        let translated = 0;
        let draftMachine = 0;
        let needsReview = 0;
        let untranslated = 0;
        let missing = 0;
        let orphans = 0;

        for (const row of index.rows) {
          const cell = row.cells.get(locale);
          if (!cell) continue;
          if (row.orphan) {
            if (cell.unit) orphans += 1;
            continue;
          }
          if (!cell.unit) {
            missing += 1;
            untranslated += 1;
            continue;
          }
          if (cell.state === 'untranslated') untranslated += 1;
          else if (cell.state === 'draftMachine') draftMachine += 1;
          else if (cell.state === 'needsReview') needsReview += 1;
          else translated += 1;
        }

        return {
          locale,
          isRtl: isRtlLocale(locale),
          fileCount: fileCounts.get(locale) ?? 0,
          unitCount: translated + draftMachine + needsReview + untranslated,
          translated,
          untranslated,
          draftMachine,
          needsReview,
          missing,
          orphans,
        };
      })
      .sort((a, b) => a.locale.localeCompare(b.locale));
  }

  /**
   * The stat strip and the needs-attention rail (S3, FR-4.4, FR-2.5b, FR-8.3).
   *
   * One scan over the row model, next to `summaries()`'s, rather than an
   * aggregate maintained as edits come in. The reason is the same one that
   * makes `patchCell` safe: everything downstream recomputes on every call, so
   * there is no invalidation path to get wrong — and an edit that fixes a
   * placeholder mismatch has to move "Open issues" in the same breath as it
   * moves the grid cell, or the dashboard becomes a thing users learn to
   * distrust.
   */
  health(): ProjectHealth {
    const index = this.#index;
    if (!index) {
      return {
        units: 0,
        unitsWithNote: 0,
        noteCoverage: 0,
        customIdUnits: 0,
        customIdShare: 0,
        errorCells: 0,
        warningCells: 0,
        staleUnits: 0,
        issues: [],
      };
    }

    let unitsWithNote = 0;
    let customIdUnits = 0;
    let staleUnits = 0;
    let errorCells = 0;
    let warningCells = 0;

    interface Tally {
      severity: 'error' | 'warning';
      cells: number;
      units: Set<string>;
      byLocale: Map<string, number>;
    }
    const tallies = new Map<RuleId, Tally>();

    const tally = (
      rule: RuleId,
      severity: 'error' | 'warning',
      row: IndexedRow,
      locale: string,
    ) => {
      let entry = tallies.get(rule);
      if (entry === undefined) {
        entry = { severity, cells: 0, units: new Set(), byLocale: new Map() };
        tallies.set(rule, entry);
      }
      entry.cells += 1;
      entry.units.add(row.rowId);
      entry.byLocale.set(locale, (entry.byLocale.get(locale) ?? 0) + 1);
    };

    for (const row of index.rows) {
      if (row.hasNote) unitsWithNote += 1;
      if (row.customId) customIdUnits += 1;
      if (row.stale) staleUnits += 1;

      for (const [locale, cell] of row.cells) {
        if (cell.errorCount > 0) errorCells += 1;
        if (cell.warningCount > 0) warningCells += 1;
        // A rule can fire twice on one cell (two broken placeholders); the
        // rail counts cells and units, so each rule is tallied once per cell.
        for (const rule of new Set(cell.errorRules)) tally(rule, 'error', row, locale);
        for (const rule of new Set(cell.warningRules)) tally(rule, 'warning', row, locale);
      }
    }

    const rows = index.rows.length;
    const pct = (n: number): number => (rows === 0 ? 0 : Math.round((n / rows) * 1000) / 10);

    const issues: RuleIssue[] = [...tallies]
      .map(([rule, entry]) => ({
        rule,
        severity: entry.severity,
        cells: entry.cells,
        units: entry.units.size,
        locales: [...entry.byLocale]
          .map(([locale, cells]) => ({ locale, cells }))
          .sort((a, b) => b.cells - a.cells || a.locale.localeCompare(b.locale)),
      }))
      // Errors before warnings, then by size: the rail shows the first few, and
      // "9 broken placeholders" outranks "400 missing full stops" every time.
      .sort(
        (a, b) =>
          Number(b.severity === 'error') - Number(a.severity === 'error') ||
          b.cells - a.cells ||
          a.rule.localeCompare(b.rule),
      );

    return {
      units: rows,
      unitsWithNote,
      noteCoverage: pct(unitsWithNote),
      customIdUnits,
      customIdShare: index.stats.customIdShare,
      errorCells,
      warningCells,
      staleUnits,
      issues,
    };
  }

  /**
   * FR-7.4's edit rate, one entry per target locale — zeroed for a locale
   * nobody has reviewed yet, `rate: null` while the denominator is 0.
   */
  editRate(): EditRateLocaleStats[] {
    const index = this.#index;
    if (!index) return [];
    return index.locales
      .map((locale) => {
        const stats = this.#reviewStats.get(locale) ?? { approvedClean: 0, corrected: 0 };
        const total = stats.approvedClean + stats.corrected;
        return {
          locale,
          approvedClean: stats.approvedClean,
          corrected: stats.corrected,
          rate: total > 0 ? Math.round((stats.approvedClean / total) * 100) : null,
        };
      })
      .sort((a, b) => a.locale.localeCompare(b.locale));
  }

  /** The `GET /api/project` body. */
  toDto(): Project | null {
    const project = this.#project;
    if (!project) return null;
    return {
      path: project.path,
      name: project.name,
      sourceLocale: project.sourceLocale,
      files: [...project.files],
      locales: this.summaries(),
      unitCount: this.#index?.stats.rows ?? 0,
      customIdShare: this.#index?.stats.customIdShare ?? 0,
      health: this.health(),
      editRate: this.editRate(),
      visibleLocales: [...project.visibleLocales],
      filters: [...project.filters],
      groups: [...new Set(project.files.map((f) => f.group))].sort(),
      openedAt: project.openedAt,
      writeState: project.writeState,
      escapePolicy: project.escapePolicy,
      severities: { ...project.severities },
    };
  }
}
