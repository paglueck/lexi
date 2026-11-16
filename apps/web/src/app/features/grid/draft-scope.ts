// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { GridFilter, UnitsQueryRequest } from '@lexi/shared';

import type { UnitsApi } from '../../core/api/units-api.js';
import { FILTER_LABEL } from './grid-rail.js';

/**
 * "Draft these units, into these locales" — which units, per locale (M15, S15).
 *
 * WHY EACH LOCALE NEEDS ITS OWN QUERY. Every per-cell grid filter is an ANY
 * over the locales in scope (`unit-index.ts`'s `matches`) — with three columns
 * visible, `UnitsStore.ids()` means "untranslated in de OR fr OR pl". Handing
 * that one list to every locale of a job would enqueue rows a locale does not
 * need: the FR-6.10 guard would skip them, but the locale row would promise
 * 140 units and deliver forty. So the scope asks the question once per locale,
 * with `locales: [one]`, and the answers are both the counts the modal shows
 * AND the id lists the job drafts — one query per locale in total, not two.
 */

/**
 * The filters that say something about a CELL's state, as opposed to the row.
 *
 * If the user has ticked one of these, they have said what they want drafted
 * and the scope asks exactly that. If they have not, it adds `untranslated` —
 * because "Draft" means "draft what needs it", and without this an unfiltered
 * grid offers to re-draft the whole project, most of which the FR-6.10 guard
 * would then skip one unit at a time.
 */
export const STATE_FILTERS: readonly GridFilter[] = [
  'untranslated',
  'needsReview',
  'machineDrafts',
  'toReview',
];

export interface DraftCandidate {
  readonly locale: string;
  readonly ids: readonly string[];
  readonly total: number;
}

export interface DraftScope {
  /** One per locale asked, in the order asked. */
  readonly candidates: readonly DraftCandidate[];
  /** The read-only chips S15 shows under "Scope from Grid filters". */
  readonly chips: readonly string[];
}

/** The filters the scope will actually apply, with `untranslated` added when no state filter is set. */
export function draftFilters(body: UnitsQueryRequest): readonly GridFilter[] {
  return body.filters.some((f) => STATE_FILTERS.includes(f))
    ? body.filters
    : [...body.filters, 'untranslated'];
}

export function scopeChips(body: UnitsQueryRequest): readonly string[] {
  return [
    ...draftFilters(body).map((f) => FILTER_LABEL[f]),
    ...body.groups.map((g) => `file: ${g}`),
    ...(body.search.trim() === '' ? [] : [`search: ${body.search.trim()}`]),
  ];
}

/**
 * Ask each locale the CURRENT filter's question, keeping the answers.
 *
 * One request per locale, on open. At 20k rows that is the ~300 kB per locale
 * that is negligible over loopback — and it is spent once,
 * because these same responses are what the job drafts from.
 */
export async function loadDraftScope(
  units: Pick<UnitsApi, 'query'>,
  body: UnitsQueryRequest,
  locales: readonly string[],
): Promise<DraftScope> {
  const filters = [...draftFilters(body)];
  const candidates = await Promise.all(
    locales.map(async (locale): Promise<DraftCandidate> => {
      const res = await units.query({ ...body, filters, locales: [locale] });
      return { locale, ids: res.ids, total: res.total };
    }),
  );
  return { candidates, chips: scopeChips(body) };
}
