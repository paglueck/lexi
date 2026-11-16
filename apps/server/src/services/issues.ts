// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { suggestFix, validateSegments, type Finding, type RuleId, type Segment } from '@lexi/xliff';
import {
  GRID_TEXT_LIMIT,
  type IssueFinding,
  type IssueRuleSummary,
  type IssuesSummary,
} from '@lexi/shared';

import { cellSourceSegmentsOf, effectiveSegments, type DtoContext } from '../lib/unit-dto.js';
import { toWireSegments } from '../lib/wire-segments.js';
import type { OpenProject } from './project-service.js';
import type { IndexedRow, UnitIndex } from './unit-index.js';

/**
 * The Issues screen's reads (S12, FR-8.3).
 *
 * The summary comes straight off the index, like the dashboard's rail, so the
 * two cannot disagree. The findings for ONE rule are recomputed with messages,
 * but only for the cells whose index entry says that rule fires: the index
 * already knows which cells to look at, so a 20k-unit project costs a few
 * dozen validations, not two hundred thousand.
 */

const byErrorsThenCount = (a: IssueRuleSummary, b: IssueRuleSummary): number =>
  Number(b.severity === 'error') - Number(a.severity === 'error') ||
  b.count - a.count ||
  a.rule.localeCompare(b.rule);

export function issuesSummary(
  project: OpenProject,
  index: UnitIndex,
  validatedAt: number,
  locale?: string,
): IssuesSummary {
  interface Tally {
    severity: 'error' | 'warning';
    count: number;
    locales: Set<string>;
  }
  const tallies = new Map<RuleId, Tally>();
  const withFindings = new Set<string>();
  let errors = 0;
  let warnings = 0;
  let ignored = 0;

  const add = (rule: RuleId, severity: 'error' | 'warning', cellLocale: string): void => {
    let entry = tallies.get(rule);
    if (entry === undefined) {
      entry = { severity, count: 0, locales: new Set() };
      tallies.set(rule, entry);
    }
    entry.count += 1;
    entry.locales.add(cellLocale);
  };

  for (const row of index.rows) {
    for (const [cellLocale, cell] of row.cells) {
      if (cell.errorRules.length + cell.warningRules.length > 0) withFindings.add(cellLocale);
      if (locale !== undefined && cellLocale !== locale) continue;
      for (const rule of cell.errorRules) add(rule, 'error', cellLocale);
      for (const rule of cell.warningRules) add(rule, 'warning', cellLocale);
      errors += cell.errorRules.length;
      warnings += cell.warningRules.length;
      ignored += cell.ignoredRules.length;
    }
  }

  const rules: IssueRuleSummary[] = [...tallies]
    .map(([rule, t]) => ({
      rule,
      severity: t.severity,
      count: t.count,
      locales: [...t.locales].sort((a, b) => a.localeCompare(b)),
    }))
    .sort(byErrorsThenCount);

  return {
    validatedAt,
    units: index.rows.length,
    locales: index.locales.filter((l) => withFindings.has(l)),
    errors,
    warnings,
    ignored,
    rulesOff: Object.values(project.severities).filter((s) => s === 'off').length,
    rules,
  };
}

/** The file a cell lives in, or would be created in, relative to the project root. */
function fileOf(project: OpenProject, row: IndexedRow, locale: string): string {
  const cell = row.cells.get(locale);
  return (
    cell?.relPath ??
    project.files.find((f) => f.group === row.group && f.locale === locale && !f.isTemplate)
      ?.relPath ??
    ''
  );
}

export interface CellFindings {
  readonly source: Segment[];
  readonly target: Segment[];
  readonly findings: Finding[];
}

/** One cell's findings, with messages, over what the cell currently shows. */
export function cellFindings(row: IndexedRow, locale: string, ctx: DtoContext): CellFindings {
  const source = cellSourceSegmentsOf(row, locale);
  const target = effectiveSegments(row, locale, ctx.pendingOf);
  const findings = validateSegments(source, target, validateContextOf(ctx, locale));
  return { source, target, findings };
}

export const validateContextOf = (ctx: DtoContext, locale: string) => ({
  sourceLocale: ctx.sourceLocale,
  targetLocale: locale,
  severities: ctx.severities,
  glossary: ctx.glossaryFor(locale),
});

export function issuesForRule(
  project: OpenProject,
  index: UnitIndex,
  ctx: DtoContext,
  rule: RuleId,
  locale?: string,
): IssueFinding[] {
  const out: IssueFinding[] = [];
  for (const row of index.rows) {
    for (const [cellLocale, cell] of row.cells) {
      if (locale !== undefined && cellLocale !== locale) continue;
      if (!cell.errorRules.includes(rule) && !cell.warningRules.includes(rule)) continue;

      const { source, target, findings } = cellFindings(row, cellLocale, ctx);
      const vctx = validateContextOf(ctx, cellLocale);
      const pending = ctx.pendingOf(row.rowId, cellLocale);
      const file = fileOf(project, row, cellLocale);
      const excerpt = toWireSegments(target, GRID_TEXT_LIMIT);

      for (const finding of findings) {
        if (finding.rule !== rule) continue;
        const fix = suggestFix(source, target, finding, vctx);
        out.push({
          ...finding,
          rowId: row.rowId,
          unitId: row.unitId,
          group: row.group,
          locale: cellLocale,
          file,
          state: pending?.state ?? cell.state,
          excerpt,
          fix:
            fix === null
              ? null
              : {
                  kind: fix.kind,
                  explanation: fix.explanation,
                  origin: fix.origin,
                  segments: toWireSegments(fix.segments),
                  changed: [...fix.changed],
                },
        });
      }
    }
  }
  // Grouped by file for the table; the index order inside a file is the file's
  // own order, so a stable sort keeps it.
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
