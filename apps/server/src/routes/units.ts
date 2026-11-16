// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';

import {
  GRID_FILTERS,
  UNAVAILABLE_FILTERS,
  UnitRowsRequestSchema,
  UnitsQueryRequestSchema,
  splitRowId,
  type GridFilter,
  type UnitDetail,
  type UnitRow,
  type UnitRowsResponse,
  type UnitsFacets,
  type UnitsQueryRequest,
  type UnitsQueryResponse,
} from '@lexi/shared';

import { notFound } from '../lib/http-error.js';
import { dtoContextOf, toWireDetail, toWireRow } from '../lib/unit-dto.js';
import type { ProjectService } from '../services/project-service.js';
import type { IndexedRow, UnitIndex } from '../services/unit-index.js';

/**
 * The grid (S4, M5).
 *
 * THE DIVISION OF LABOUR (docs/architecture.md): the client owns the ordered id list, the
 * server owns the row bodies. `query` answers "which rows, in what order, and
 * how many of each kind" in one round trip; `rows` fills in the ~200 the
 * viewport is actually showing; `:rowId` fills in the detail panel.
 *
 * Read-only throughout: nothing here writes a byte. M6's editing routes live in
 * `edit.ts`, deliberately in their own file, so the one path that can touch a
 * user's repository stays visible rather than blending into the read surface.
 *
 * Both row and detail payloads render a cell's PENDING EDIT when it has one, via
 * `lib/unit-dto.ts` — so an uncommitted change shows in the grid and the panel
 * alike, and the two cannot disagree.
 */
export function registerUnits(app: FastifyInstance, projects: ProjectService): void {
  const openIndex = (): { index: UnitIndex; visible: readonly string[]; sourceLocale: string } => {
    const open = projects.current;
    const index = projects.index;
    if (!open || !index) throw notFound('no project is open');
    return { index, visible: open.visibleLocales, sourceLocale: open.sourceLocale };
  };

  app.post('/api/units/query', async (req): Promise<UnitsQueryResponse> => {
    const body = UnitsQueryRequestSchema.parse(req.body ?? {});
    const { index, visible } = openIndex();
    return runQuery(index, body, visible);
  });

  app.post('/api/units/rows', async (req): Promise<UnitRowsResponse> => {
    const body = UnitRowsRequestSchema.parse(req.body ?? {});
    const { index, visible } = openIndex();
    const locales = body.locales.length > 0 ? body.locales : visible;

    const rows: UnitRow[] = [];
    for (const rowId of body.ids) {
      const row = index.byRowId.get(rowId);
      // A stale id is skipped rather than erroring the window: the client's id
      // list can legitimately predate a reload, and losing one row beats losing
      // the screenful it was in.
      if (row) rows.push(toWireRow(row, locales, dtoContextOf(projects)));
    }
    return { rows };
  });

  app.get('/api/units/:rowId', async (req): Promise<UnitDetail> => {
    const { rowId } = req.params as { rowId: string };
    const { index, visible } = openIndex();
    const row = index.byRowId.get(rowId);
    if (!row) {
      const { unitId } = splitRowId(rowId);
      throw notFound(`no unit ${unitId} in this project`);
    }

    /**
     * The panel explains the row the user is looking at, so it shows the same
     * locales that row shows — the VISIBLE columns, not all of them. On a
     * twenty-locale project the alternative is a panel twenty sections long,
     * nineteen of which are answering a question nobody asked.
     *
     * `?locales=` overrides it, for a caller that wants the whole picture.
     */
    const asked = (req.query as { locales?: string }).locales;
    const locales = asked
      ? asked.split(',').filter((l) => index.locales.includes(l))
      : visible.length > 0
        ? visible
        : index.locales;

    return toWireDetail(row, locales, dtoContextOf(projects));
  });

  app.get('/api/units', async (): Promise<{ rows: number; groups: readonly string[] }> => {
    const { index } = openIndex();
    return { rows: index.stats.rows, groups: index.groups };
  });
}

/* ---- query --------------------------------------------------------------- */

/**
 * One linear scan over precomputed primitives. No XML is touched here, which is
 * the whole reason the index exists: FR-3.5 budgets 200 ms from the last
 * keystroke to pixels, and the server's share of that is about 30.
 */
function runQuery(
  index: UnitIndex,
  q: UnitsQueryRequest,
  visible: readonly string[],
): UnitsQueryResponse {
  const locales = q.locales.length > 0 ? q.locales : visible.length > 0 ? visible : index.locales;
  const needle = q.search.trim().toLowerCase();
  const groupSet = q.groups.length > 0 ? new Set(q.groups) : null;

  const hit = (row: IndexedRow): boolean => {
    if (needle === '') return true;
    switch (q.scope) {
      case 'key':
        return row.idLower.includes(needle);
      case 'source':
        return row.sourceLower.includes(needle);
      case 'notes':
        return row.notesLower.includes(needle);
      case 'target':
        return locales.some((l) => row.cells.get(l)?.targetLower.includes(needle) ?? false);
      case 'all':
        return (
          row.idLower.includes(needle) ||
          row.sourceLower.includes(needle) ||
          row.notesLower.includes(needle) ||
          locales.some((l) => row.cells.get(l)?.targetLower.includes(needle) ?? false)
        );
    }
  };

  // The search scope, ignoring the namespace tree and the checkboxes. The
  // rail's per-group counts are read off this, so picking one group does not
  // zero the others.
  const groupCounts: Record<string, number> = {};
  const searched: IndexedRow[] = [];
  for (const row of index.rows) {
    if (!hit(row)) continue;
    searched.push(row);
    groupCounts[row.group] = (groupCounts[row.group] ?? 0) + 1;
  }

  const scoped = groupSet ? searched.filter((r) => groupSet.has(r.group)) : searched;

  /**
   * Facets are counted over the scope with the CHECKBOXES EXCLUDED. Counting
   * them against the active filter set instead would make each count collapse
   * to the number of rows already on screen the moment its own box was ticked —
   * the number jumping under the cursor that clicked it.
   */
  const facets: UnitsFacets = {};
  for (const filter of GRID_FILTERS) {
    if (UNAVAILABLE_FILTERS.includes(filter)) continue;
    let n = 0;
    for (const row of scoped) if (index.matches(row, filter, locales)) n += 1;
    facets[filter] = n;
  }

  const active: readonly GridFilter[] = q.filters.filter((f) => !UNAVAILABLE_FILTERS.includes(f));
  const matching =
    active.length === 0
      ? scoped
      : scoped.filter((row) => active.every((f) => index.matches(row, f, locales)));

  return {
    total: matching.length,
    ids: matching.map((r) => r.rowId),
    scopeTotal: scoped.length,
    facets,
    groupCounts,
  };
}
