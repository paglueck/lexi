// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_SEVERITIES,
  atomicWrite,
  detectLocale,
  isTemplateFile,
  localeFileSkeleton,
  scan,
  type LoadedDocument,
  type RuleId,
  type Severity,
} from '@lexi/xliff';
import {
  CreateLocaleFileRequestSchema,
  ESCAPE_POLICIES,
  GRID_FILTERS,
  isRtlLocale,
  ProjectOpenRequestSchema,
  ProjectPatchSchema,
  ProjectResumeRequestSchema,
  ProjectScanRequestSchema,
  RULE_IDS,
  SEVERITIES,
  WRITE_STATE_MODES,
  type EscapePolicy,
  type FileMapping,
  type GridFilter,
  type CreateLocaleFileResponse,
  type Project,
  type ProjectResumeResponse,
  type ProjectScanResponse,
  type ScannedFile,
  type WriteStateMode,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { writeLexiJson, readLexiJson } from '../lib/lexi-dir.js';
import { readFinalMarkers } from '../lib/final-marker.js';
import { readMachineOrigins } from '../lib/machine-origin.js';
import { readReviewStats } from '../lib/review-stats.js';
import { readReviewNotes } from '../lib/review-notes.js';
import { restoreDrafts, syncPendingIntoIndex } from '../lib/drafts.js';
import { readIgnoredFindings } from '../lib/ignored-findings.js';
import { sourceTextOf } from '../services/unit-index.js';
import { resolveForCreate, resolveWithinRoots } from '../lib/paths.js';
import { localeFileOf, newLocaleFilePath } from '../lib/target-cell.js';
import { syncPendingIntoIndex as syncPending } from '../lib/drafts.js';
import { readRecents, recentIdFor, recordRecent, type StoredRecent } from '../lib/recents.js';
import type { FileWatcher } from '../services/file-watcher.js';
import type { SharedSourceWatcher } from '../services/shared-source-watcher.js';
import { loadTermBase } from '../services/termbase.js';
import type { JobQueue } from '../services/job-queue.js';
import {
  fileKey,
  previousHashesOf,
  sourceHash,
  type ProjectService,
} from '../services/project-service.js';
import { scanProject, suggestSourceLocale } from '../services/scan-project.js';

/**
 * Opening a project (S1 + S2).
 *
 * Scan and open are separate calls because FR-1.3 requires a confirmation step:
 * scan reports what the directory contains and how each locale was worked out,
 * the wizard shows it, and open records what the user actually confirmed.
 */

/** Shape of `.lexi/project.json`. Committed by users, so additive changes only. */
interface ProjectFile {
  version: 1;
  sourceLocale: string;
  visibleLocales: string[];
  /** Added in M5. Absent in a file written by M4, hence the optional. */
  filters?: GridFilter[];
  /** Added in M6. Committed on purpose: how a team writes `state` is a team decision. */
  writeState?: WriteStateMode;
  escapePolicy?: EscapePolicy;
  severities?: Partial<Record<RuleId, Severity>>;
  mapping: Array<{ relPath: string; fileIndex: number; locale: string }>;
}

export function registerProjects(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  watcher?: FileWatcher,
  jobQueue?: JobQueue,
  sharedWatcher?: SharedSourceWatcher,
): { reopenLast: () => Promise<Project | null> } {
  app.post('/api/projects/scan', async (req): Promise<ProjectScanResponse> => {
    const { path } = ProjectScanRequestSchema.parse(req.body);
    const root = await resolveWithinRoots(path, cfg);

    const started = performance.now();
    const outcome = await scanProject(root);
    const durationMs = performance.now() - started;

    // Kept so `open` does not re-read and re-parse the whole tree.
    projects.rememberScan(root, outcome);

    return {
      root,
      files: [...outcome.files],
      skipped: [...outcome.skipped],
      durationMs,
      suggestedSourceLocale: suggestSourceLocale(outcome.files),
      saved: savedMappingOf(await readProjectFile(root)),
    };
  });

  /**
   * Open `root` with a confirmed mapping. Shared by the route below and by
   * `reopenLast`, which replays the mapping `.lexi/project.json` saved.
   */
  const openAt = async (
    root: string,
    mapping: readonly FileMapping[],
    sourceLocale: string,
  ): Promise<Project> => {
    // Opening a project — even re-opening the same one — replaces the row
    // index a running job's ids point at. A job from the previous project has
    // nothing left to draft into, so it is cancelled rather than left to fail
    // unit by unit.
    jobQueue?.cancelAll();

    const outcome = projects.scanFor(root) ?? (await scanProject(root));
    projects.rememberScan(root, outcome);

    const known = new Set(outcome.files.map((f) => fileKey(f.path, f.fileIndex)));
    for (const entry of mapping) {
      if (!known.has(fileKey(entry.path, entry.fileIndex))) {
        throw badRequest(`no scanned file at ${entry.path}#${entry.fileIndex}`);
      }
    }

    // The amber "Fix to pt-BR" rows, applied before the project is opened so
    // the in-memory documents and the files on disk cannot disagree.
    const fixes = mapping.filter((m) => m.fixTargetLanguage);
    for (const fix of fixes) {
      await projects.fixTargetLanguage(fix.path, fix.fileIndex, fix.locale);
    }

    // Read the PREVIOUS source hashes before `persist` overwrites them below.
    // This is the only moment they exist: sources.json is rewritten from the
    // current text on every open, so a comparison made afterwards would report
    // no drift by construction. It is what "stale source" in the grid's filter
    // rail actually means — the English changed since the last time this
    // project was opened, i.e. somebody re-ran extraction.
    const previousHashes = previousHashesOf(await readLexiJson<unknown>(root, 'sources.json'));

    // Which targets a model wrote (requirements §4.2). Unlike the hashes above this is
    // NOT rewritten on open — it is the record itself, and it is committed, so
    // a teammate opening the project sees the same drafts marked.
    const origins = await readMachineOrigins(root);

    // FR-7.4's edit-rate counter — machine-local, unlike the origins above
    // (lib/review-stats.ts explains why it cannot be committed the same way).
    const reviewStats = await readReviewStats(root);

    // S11's reject-reason chips. Committed, like the origins and unlike the
    // counter: "we do not say Kostenloser Versand here" is a note to the next
    // person, and its map shape merges across branches the way a scalar cannot.
    const reviewNotes = await readReviewNotes(root);

    // FR-8.1's glossary rules validate every cell as the index is built, which
    // is synchronous — so the terms are read here, with the other `.lexi/` state.
    const glossary = await loadTermBase(cfg, root);

    // S12's ignored findings. Committed like the review notes; each entry is
    // believed only while the source it was made against is unchanged.
    const ignored = await readIgnoredFindings(root);

    // Imported-as-final markers; committed, hash-guarded like the origins.
    const finalMarkers = await readFinalMarkers(root);

    if (fixes.length > 0) {
      const rescanned = await scanProject(root);
      projects.rememberScan(root, rescanned);
      projects.open(
        root,
        rescanned,
        mapping,
        sourceLocale,
        previousHashes,
        origins,
        reviewStats,
        reviewNotes,
        glossary,
        ignored,
        finalMarkers,
      );
    } else {
      projects.open(
        root,
        outcome,
        mapping,
        sourceLocale,
        previousHashes,
        origins,
        reviewStats,
        reviewNotes,
        glossary,
        ignored,
        finalMarkers,
      );
    }

    // FR-3.2: the visible locale columns and the filter set are "persisted per
    // project". M4 wrote them and nothing read them back; this is that half of
    // the debt paid. The mapping half is `restoreMapping`, used by `resume` and
    // `reopenLast`, so only a first open or a deliberate re-map runs the wizard.
    await restoreGridView(projects, root);
    // After the index exists, because a draft is re-attached against the unit it
    // belongs to. A draft whose placeholders no longer resolve is dropped rather
    // than repaired — see lib/drafts.ts.
    const drafts = await restoreDrafts(projects);
    // The overlay is what the grid reads; the index cells are what the filters
    // and the dashboard read. Restoring drafts without this showed the buffer in
    // the grid and pre-draft figures on the dashboard, from the same request.
    syncPendingIntoIndex(projects);
    // Forget ignores whose unit is gone or whose source has changed. In memory
    // only: opening a project must not write to the repository. The next ignore
    // or un-ignore writes the pruned file.
    const openIndex = projects.index;
    if (openIndex !== null) {
      projects.ignoredFindings.prune((e) => {
        const row = openIndex.byRowId.get(e.rowId);
        return row !== undefined && sourceHash(sourceTextOf(row, e.locale)) === e.sourceHash;
      });
    }
    if (drafts.dropped > 0) {
      app.log.warn(
        { dropped: drafts.dropped, restored: drafts.restored },
        'dropped drafts whose source changed since they were written',
      );
    }

    const dto = projects.toDto();
    if (!dto) throw badRequest('project failed to open');

    await persist(cfg, projects, root, dto);
    await remember(cfg, root, dto);
    // Last, and only once the documents are in memory: the watcher decides what
    // changed by comparing against them (FR-1.5).
    watcher?.watchProject(root);
    await sharedWatcher?.watchProject(root);
    await jobQueue?.restore(root);
    return dto;
  };

  app.post('/api/projects/open', async (req): Promise<Project> => {
    const body = ProjectOpenRequestSchema.parse(req.body);
    const root = await resolveWithinRoots(body.path, cfg);
    return openAt(root, body.mapping, body.sourceLocale);
  });

  /**
   * Open a folder with what it saved last time, skipping the wizard.
   *
   * Locale mapping and source locale are a one-time decision per project; the
   * wizard is for the first open and for a deliberate re-map from the project
   * menu. Anything less than a usable `project.json` answers `needsSetup`.
   */
  app.post('/api/projects/resume', async (req): Promise<ProjectResumeResponse> => {
    const { path } = ProjectResumeRequestSchema.parse(req.body);
    const root = await resolveWithinRoots(path, cfg);
    const restored = await restoreMapping(root);
    if (restored === null) return { needsSetup: true };
    return {
      needsSetup: false,
      project: await openAt(root, restored.mapping, restored.sourceLocale),
    };
  });

  app.get('/api/project', async (): Promise<Project> => {
    const dto = projects.toDto();
    if (!dto) throw notFound('no project is open');
    return dto;
  });

  /**
   * Put the server back to having nothing open — S1's "Switch project".
   *
   * Jobs are cancelled for the reason `open` already gives: a job's unit ids
   * point into a row index that is about to stop existing, so it is cancelled
   * rather than left to fail one unit at a time.
   *
   * 204 whether or not anything was open. Closing is a button, the button looks
   * the same in both states, and a client that closes twice — or closes after
   * the project went away underneath it — has not done anything wrong. Making
   * that a 404 would only invite every caller to ignore the status.
   *
   * Unsaved drafts go with it. The warning belongs in the client, which is the
   * only side that can ask before the click; see `ProjectService.close`.
   */
  app.post('/api/project/close', async (_req, reply): Promise<void> => {
    jobQueue?.cancelAll();
    sharedWatcher?.stop();
    projects.close();
    reply.code(204);
  });

  /**
   * Start a locale that has no file yet (FR-1.9).
   *
   * The skeleton is the SOURCE file, copied and emptied — so the prolog, the
   * unprefixed namespace, the `<file>` attribute order, the indentation and the
   * line endings match the rest of the project rather than announcing that a
   * tool made this one. The units arrive one at a time, as translations are
   * written and saved.
   *
   * Explicit rather than implicit, because it puts a new file in somebody's
   * repository and their build has to be told about it.
   */
  app.post('/api/locales/file', async (req): Promise<CreateLocaleFileResponse> => {
    const body = CreateLocaleFileRequestSchema.parse(req.body ?? {});
    const project = projects.current;
    if (!project) throw notFound('no project is open');

    const { group, locale } = body;
    if (locale === project.sourceLocale) {
      throw badRequest(`${locale} is the source locale; it is not a translation target.`);
    }
    const existing = localeFileOf(project, group, locale);
    if (existing !== undefined) {
      throw badRequest(`"${group}" already has a ${locale} file: ${existing.relPath}`);
    }

    // The file to copy: this group's source. Without one there is nothing to
    // start from, and nothing to translate either.
    const source =
      project.files.find((f) => f.group === group && f.isTemplate) ??
      project.files.find((f) => f.group === group && f.locale === project.sourceLocale);
    if (source === undefined) {
      throw badRequest(`"${group}" has no source file to copy a ${locale} skeleton from.`);
    }

    // The naming convention is read off a sibling rather than chosen: a project
    // writing `messages.de.xlf` gets `messages.pl.xlf`, one writing
    // `de/messages.xlf` gets `pl/messages.xlf`.
    const sibling =
      project.files.find((f) => f.group === group && f.locale !== null && !f.isTemplate) ?? source;
    const { path, relPath } = newLocaleFilePath(sibling, locale);

    if (project.documents.has(path)) {
      throw badRequest(`${relPath} already exists in this project.`);
    }
    const jailed = await resolveForCreate(path, cfg);
    if (
      await readFile(jailed, 'utf8')
        .then(() => true)
        .catch(() => false)
    ) {
      throw badRequest(`${relPath} already exists on disk. Re-open the project to pick it up.`);
    }

    const sourceDoc = project.documents.get(source.path);
    if (sourceDoc === undefined) throw notFound(`the source file for "${group}" is not loaded`);

    const text = localeFileSkeleton(sourceDoc, locale);
    await atomicWrite(jailed, text);

    const doc: LoadedDocument = { ...scan(text), path: jailed };
    const file = doc.files[0];
    if (file === undefined) throw badRequest('the generated skeleton has no <file> element');

    const detection = detectLocale(relPath, file);
    const scanned: ScannedFile = {
      path: jailed,
      relPath,
      fileIndex: 0,
      group,
      locale,
      localeSource: detection.source,
      conflictingTargetLanguage: detection.conflictingAttr ?? null,
      sourceLanguage: file.attrs['source-language'] ?? null,
      targetLanguage: file.attrs['target-language'] ?? null,
      unitCount: 0,
      isTemplate: isTemplateFile(file),
      isRtl: isRtlLocale(locale),
    };
    projects.addFile(scanned, doc);
    // `addFile` rebuilds the index from the files, so any pending edit's derived
    // half has to be put back — the same step the reload path takes.
    syncPending(projects);

    const dto = projects.toDto();
    if (!dto) throw notFound('no project is open');
    await persist(cfg, projects, project.path, dto);
    return { created: relPath, project: dto };
  });

  app.patch('/api/project', async (req): Promise<Project> => {
    const patch = ProjectPatchSchema.parse(req.body);
    const open = projects.current;
    if (!open) throw notFound('no project is open');

    const sourceLocaleChanged =
      patch.sourceLocale !== undefined && patch.sourceLocale !== open.sourceLocale;
    if (patch.sourceLocale !== undefined) open.sourceLocale = patch.sourceLocale;
    if (patch.visibleLocales !== undefined) open.visibleLocales = patch.visibleLocales;
    if (patch.filters !== undefined) open.filters = patch.filters;
    if (patch.writeState !== undefined) open.writeState = patch.writeState;
    if (patch.escapePolicy !== undefined) open.escapePolicy = patch.escapePolicy;
    if (patch.severities !== undefined) {
      // A partial map: merged over what is already chosen, so switching one rule
      // off does not put every other rule back to its default.
      open.severities = { ...DEFAULT_SEVERITIES, ...open.severities, ...patch.severities };
      // Severities decide what counts as an error, and the index caches those
      // counts per cell, so the row model has to be rebuilt.
      projects.rebuildIndex();
    }
    // The row model is derived from which files count as the source (FR-2.1
    // makes the source locale switchable at any time), so it is rebuilt rather
    // than patched. Changing only the visible columns leaves it untouched.
    if (sourceLocaleChanged) projects.rebuildIndex();

    const dto = projects.toDto();
    if (!dto) throw notFound('no project is open');
    await persist(cfg, projects, open.path, dto);
    return dto;
  });

  /**
   * Reopen the most recent project, as the server boots.
   *
   * The mapping is rebuilt by `restoreMapping`, the same rule `resume` uses.
   *
   * Recents that no longer resolve — deleted, or outside the roots `lexi <path>`
   * narrowed to — are skipped in favour of the next one.
   */
  const reopenLast = async (): Promise<Project | null> => {
    for (const recent of await readRecents(cfg)) {
      const root = await resolveWithinRoots(recent.path, cfg).catch(() => null);
      if (root === null) continue;

      // Hand-edited or half-written: the wizard is the safer place to land.
      const restored = await restoreMapping(root);
      if (restored === null) return null;

      return openAt(root, restored.mapping, restored.sourceLocale);
    }
    return null;
  };

  /**
   * The saved mapping laid over a fresh scan, or null when there is nothing
   * usable saved — the wizard is then the safer place to land.
   *
   * A file added since last time still comes in on its detected locale, and a
   * file that went away simply is not in the scan. `target-language` is never
   * rewritten here; that stays the wizard's explicit amber action (FR-1.2b).
   */
  const restoreMapping = async (
    root: string,
  ): Promise<{ mapping: FileMapping[]; sourceLocale: string } | null> => {
    const saved = savedMappingOf(await readProjectFile(root));
    if (saved === null) return null;

    // Always fresh: the cached scan is from whenever this folder was last
    // looked at, and a file added since is exactly what must not be missed.
    const outcome = await scanProject(root);
    projects.rememberScan(root, outcome);

    const savedLocale = new Map(
      saved.mapping.map((m) => [fileKey(m.relPath, m.fileIndex), m.locale]),
    );
    const mapping: FileMapping[] = outcome.files.flatMap((f) => {
      const locale = savedLocale.get(fileKey(f.relPath, f.fileIndex)) ?? f.locale;
      return locale === null
        ? []
        : [{ path: f.path, fileIndex: f.fileIndex, locale, fixTargetLanguage: false }];
    });
    if (mapping.length === 0) return null;

    return { mapping, sourceLocale: saved.sourceLocale };
  };

  return { reopenLast };
}

/**
 * Write `.lexi/project.json` and `.lexi/sources.json`.
 *
 * `sources.json` is phase-2 groundwork and carries no weight today: without a
 * record of what the source text hashed to, FR-2.5b drift detection for
 * `@@customId` units can never be added retroactively.
 */
async function persist(
  cfg: ServerConfig,
  projects: ProjectService,
  root: string,
  dto: Project,
): Promise<void> {
  const open = projects.current;
  if (!open) return;

  const file: ProjectFile = {
    version: 1,
    sourceLocale: dto.sourceLocale,
    visibleLocales: [...open.visibleLocales],
    filters: [...open.filters],
    writeState: open.writeState,
    escapePolicy: open.escapePolicy,
    severities: { ...open.severities },
    mapping: dto.files
      .filter((f) => f.locale !== null)
      .map((f) => ({ relPath: f.relPath, fileIndex: f.fileIndex, locale: f.locale as string })),
  };

  await writeLexiJson(cfg, root, 'project.json', file);
  await writeLexiJson(cfg, root, 'sources.json', projects.sourceHashes());
}

/**
 * Reapply the persisted grid view.
 *
 * Both fields are validated against the current project rather than trusted:
 * `.lexi/project.json` is a committed file that a teammate may have written
 * against a different set of locales, or edited by hand. A column naming a
 * locale this project does not have would render an empty, unremovable grid
 * column, and an unknown filter id would fail the query schema on every
 * keystroke — so unknown entries are dropped rather than carried.
 */
async function restoreGridView(projects: ProjectService, root: string): Promise<void> {
  const open = projects.current;
  const saved = await readProjectFile(root);
  if (!open || !saved) return;

  const known = new Set(projects.index?.locales ?? []);
  const columns = (saved.visibleLocales ?? []).filter((l) => known.has(l));
  if (columns.length > 0) open.visibleLocales = columns;

  const filters = (saved.filters ?? []).filter((f): f is GridFilter =>
    (GRID_FILTERS as readonly string[]).includes(f),
  );
  open.filters = filters;

  // Validated against the vocabularies rather than trusted: project.json is a
  // committed file a teammate may have written with a different version.
  if (saved.writeState && (WRITE_STATE_MODES as readonly string[]).includes(saved.writeState)) {
    open.writeState = saved.writeState;
  }
  if (saved.escapePolicy && (ESCAPE_POLICIES as readonly string[]).includes(saved.escapePolicy)) {
    open.escapePolicy = saved.escapePolicy;
  }
  if (saved.severities) {
    const severities = { ...DEFAULT_SEVERITIES };
    for (const [rule, severity] of Object.entries(saved.severities)) {
      if (!(RULE_IDS as readonly string[]).includes(rule)) continue;
      if (!(SEVERITIES as readonly string[]).includes(severity as string)) continue;
      severities[rule as RuleId] = severity as Severity;
    }
    open.severities = severities;
  }
}

/** Read back a previously committed mapping, so reopening skips the wizard. */
export const readProjectFile = (root: string): Promise<ProjectFile | null> =>
  readLexiJson<ProjectFile>(root, 'project.json');

/**
 * The mapping half of a saved `project.json`, or null when it is missing or
 * hand-edited past recognition. Entries that are not well-formed are dropped.
 */
function savedMappingOf(saved: ProjectFile | null): ProjectScanResponse['saved'] {
  if (typeof saved?.sourceLocale !== 'string' || saved.sourceLocale === '') return null;
  if (!Array.isArray(saved.mapping)) return null;
  const mapping = saved.mapping.filter(
    (m) =>
      typeof m?.relPath === 'string' &&
      Number.isInteger(m.fileIndex) &&
      typeof m.locale === 'string' &&
      m.locale !== '',
  );
  return { sourceLocale: saved.sourceLocale, mapping };
}

async function remember(cfg: ServerConfig, root: string, dto: Project): Promise<void> {
  const totals = dto.locales.reduce(
    (acc, l) => ({
      units: acc.units + l.unitCount,
      translated: acc.translated + l.translated,
      draft: acc.draft + l.draftMachine,
      review: acc.review + l.needsReview,
    }),
    { units: 0, translated: 0, draft: 0, review: 0 },
  );

  const pct = (n: number): number =>
    totals.units === 0 ? 0 : Math.round((n / totals.units) * 100);

  const entry: StoredRecent = {
    id: recentIdFor(root),
    path: root,
    name: dto.name,
    openedAt: dto.openedAt,
    localeCount: dto.locales.length,
    unitCount: totals.units,
    // `draft` was hard-coded to 0 until M7 split the counter out of needsReview;
    // the recents bar on S1 has had a segment for it since M4.
    coverage: {
      translated: pct(totals.translated),
      draft: pct(totals.draft),
      needsReview: pct(totals.review),
    },
  };
  await recordRecent(cfg, entry);
}
