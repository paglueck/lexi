// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { composeSegments, suggestFix, type RuleId } from '@lexi/xliff';
import {
  IssueFixAllRequestSchema,
  IssueRefSchema,
  RuleIdSchema,
  splitRowId,
  type IgnoredFindingsResponse,
  type IssueFindingsResponse,
  type IssueFixAllResponse,
  type IssueFixResponse,
  type IssuesSummary,
  type UnitState,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { commitTarget, editableCell, openRow } from '../lib/commit.js';
import { writeDrafts } from '../lib/drafts.js';
import { StepRecorder } from '../lib/history.js';
import { HttpError, notFound } from '../lib/http-error.js';
import { writeIgnoredFindings } from '../lib/ignored-findings.js';
import { originKey, targetHash, writeMachineOrigins } from '../lib/machine-origin.js';
import { countFindings, dtoContextOf, type DtoContext } from '../lib/unit-dto.js';
import {
  cellFindings,
  issuesForRule,
  issuesSummary,
  validateContextOf,
} from '../services/issues.js';
import { sourceHash, type ProjectService } from '../services/project-service.js';
import { sourceTextOf, type IndexedRow, type UnitIndex } from '../services/unit-index.js';

/**
 * The Issues screen (S12, FR-8.3 and FR-8.4).
 *
 * Reads are recomputed from the row model on every request, like the
 * dashboard. The writes are two, and neither touches a file in the user's
 * repository:
 *
 * - a FIX goes into the overlay through `commitTarget`, the one commit path
 *   every edit takes, and waits for Save like any other edit;
 * - an IGNORE writes `.lexi/ignored-findings.json` and moves the index counts.
 */

const conflict = (message: string): HttpError => new HttpError(409, 'conflict', message);

const localeOf = (query: unknown): string | undefined => {
  const value = (query as { locale?: unknown } | undefined)?.locale;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

export function registerIssues(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
): void {
  const open = () => {
    const project = projects.current;
    const index = projects.index;
    if (!project || !index) throw notFound('no project is open');
    return { project, index };
  };

  app.get('/api/issues', async (req): Promise<IssuesSummary> => {
    const { project, index } = open();
    return issuesSummary(project, index, projects.validatedAt, localeOf(req.query));
  });

  app.get('/api/issues/rules/:rule', async (req): Promise<IssueFindingsResponse> => {
    const { project, index } = open();
    const rule = RuleIdSchema.parse((req.params as { rule: string }).rule);
    return {
      rule,
      severity: project.severities[rule],
      findings: issuesForRule(project, index, dtoContextOf(projects), rule, localeOf(req.query)),
    };
  });

  /**
   * Revalidate: rebuild the row model from the files and fold the overlay back
   * in. Edits already move the counts one cell at a time, so this is for what
   * they cannot see: a file changed outside Lexi and not yet reloaded, or a
   * suspicion that the counts are wrong.
   */
  app.post('/api/issues/revalidate', async (req): Promise<IssuesSummary> => {
    projects.rebuildIndex();
    const { project, index } = open();
    return issuesSummary(project, index, projects.validatedAt, localeOf(req.query));
  });

  /**
   * Apply one finding's deterministic fix.
   *
   * The fix is recomputed HERE from what the cell currently holds. The client
   * names the finding and nothing more, so a stale screen cannot apply a fix
   * computed against text that has since changed.
   *
   * The state does not move. A machine draft stays a machine draft, so it still
   * waits in the review queue. Its marker is re-stamped with the new bytes'
   * hash, because a fix is not a reviewer's decision: recording it as a
   * correction would count against the model in the edit rate for a
   * placeholder a tool put back.
   */
  const applyFix = async (
    row: IndexedRow,
    locale: string,
    rule: RuleId,
    ctx: DtoContext,
  ): Promise<IssueFixResponse | null> => {
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    const { source, target, findings } = cellFindings(row, locale, ctx);
    const finding = findings.find((f) => f.rule === rule);
    if (finding === undefined) return null;
    const fix = suggestFix(source, target, finding, validateContextOf(ctx, locale));
    if (fix === null) return null;

    const state: UnitState =
      ctx.pendingOf(row.rowId, locale)?.state ?? row.cells.get(locale)?.state ?? 'reviewed';
    const segments = [...fix.segments];
    const response = commitTarget(
      projects,
      row,
      locale,
      segments,
      state,
      editableCell(projects, row, locale),
    );

    const origin = projects.machineOrigins.get(originKey(row.rowId, locale));
    if (origin !== undefined && state === 'draftMachine') {
      projects.setMachineOrigin(row.rowId, locale, {
        ...origin,
        hash: targetHash(composeSegments(segments, project.escapePolicy)),
      });
    }
    return response;
  };

  const writeOrigins = async (): Promise<void> => {
    const project = projects.current;
    if (project) await writeMachineOrigins(cfg, project.path, projects.machineOrigins);
  };

  app.post('/api/issues/fix', async (req): Promise<IssueFixResponse> => {
    const ref = IssueRefSchema.parse(req.body ?? {});
    const row = openRow(projects, ref.rowId);
    const step = new StepRecorder(projects, 'Fix');
    step.cell(ref.rowId, ref.locale);
    const response = await applyFix(row, ref.locale, ref.rule, dtoContextOf(projects));
    if (response === null) {
      throw conflict('This finding has no suggested fix any more. It may already have been fixed.');
    }
    step.finish();
    await writeOrigins();
    await writeDrafts(cfg, projects);
    return { ...response, history: projects.historyStatus };
  });

  /** "Apply N suggested fixes": every finding of one rule that has one. */
  app.post('/api/issues/fix-all', async (req): Promise<IssueFixAllResponse> => {
    const body = IssueFixAllRequestSchema.parse(req.body ?? {});
    const { project, index } = open();
    const ctx = dtoContextOf(projects);
    // Collected first: each fix patches the index, and a cell whose rule
    // stopped firing must not be visited twice.
    const targets = issuesForRule(project, index, ctx, body.rule, body.locale)
      .filter((f) => f.fix !== null)
      .map((f) => ({ rowId: f.rowId, locale: f.locale }));
    const seen = new Set<string>();
    const step = new StepRecorder(projects, 'Fix all');
    let applied = 0;
    for (const { rowId, locale } of targets) {
      const key = `${rowId} ${locale}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = index.byRowId.get(rowId);
      if (row === undefined) continue;
      step.cell(rowId, locale);
      if ((await applyFix(row, locale, body.rule, ctx)) !== null) applied += 1;
    }
    step.finish();
    if (applied > 0) {
      await writeOrigins();
      await writeDrafts(cfg, projects);
    }
    return { applied, unsavedCount: projects.unsavedCount };
  });

  /** Move one cell's counts after its ignores changed. */
  const recount = (index: UnitIndex, row: IndexedRow, locale: string): void => {
    const cell = row.cells.get(locale);
    if (cell === undefined) return;
    const ctx = dtoContextOf(projects);
    // An untranslated cell is never counted (see the index build), whatever it ignores.
    const counted =
      cell.errorRules.length + cell.warningRules.length + cell.ignoredRules.length > 0;
    const findings = counted ? cellFindings(row, locale, ctx).findings : [];
    index.patchCell(row.rowId, locale, {
      state: cell.state,
      targetLower: cell.targetLower,
      ...countFindings(findings, ctx.ignoredOf(row, locale)),
    });
  };

  const persistIgnores = async (): Promise<void> => {
    const project = projects.current;
    if (!project) return;
    const index = projects.index;
    // The write is the moment stale entries leave the committed file.
    if (index !== null) {
      projects.ignoredFindings.prune((e) => {
        const row = index.byRowId.get(e.rowId);
        return row !== undefined && sourceHash(sourceTextOf(row, e.locale)) === e.sourceHash;
      });
    }
    await writeIgnoredFindings(cfg, project.path, projects.ignoredFindings);
  };

  app.post('/api/issues/ignore', async (req): Promise<IssuesSummary> => {
    const ref = IssueRefSchema.parse(req.body ?? {});
    const { project, index } = open();
    const row = openRow(projects, ref.rowId);
    if (!row.cells.has(ref.locale)) throw notFound(`this unit has no ${ref.locale} column`);
    projects.ignoredFindings.add({
      rowId: row.rowId,
      locale: ref.locale,
      rule: ref.rule,
      sourceHash: sourceHash(sourceTextOf(row, ref.locale)),
    });
    recount(index, row, ref.locale);
    await persistIgnores();
    return issuesSummary(project, index, projects.validatedAt);
  });

  app.delete('/api/issues/ignore', async (req): Promise<IssuesSummary> => {
    const ref = IssueRefSchema.parse(req.body ?? {});
    const { project, index } = open();
    const row = openRow(projects, ref.rowId);
    if (projects.ignoredFindings.remove(row.rowId, ref.locale, ref.rule)) {
      recount(index, row, ref.locale);
      await persistIgnores();
    }
    return issuesSummary(project, index, projects.validatedAt);
  });

  /** The ignores the footer can undo: only those that still hide a finding. */
  app.get('/api/issues/ignored', async (): Promise<IgnoredFindingsResponse> => {
    const { index } = open();
    const ignored: IgnoredFindingsResponse['ignored'] = [];
    for (const row of index.rows) {
      for (const [locale, cell] of row.cells) {
        for (const rule of new Set(cell.ignoredRules)) {
          const { group, unitId } = splitRowId(row.rowId);
          ignored.push({ rowId: row.rowId, locale, rule, group, unitId });
        }
      }
    }
    return { ignored };
  });
}
