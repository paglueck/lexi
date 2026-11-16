// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  BulkApproveResponse,
  DiscardRequest,
  DiscardResponse,
  EditSegmentDto,
  HistoryStatus,
  HistoryStepResponse,
  NoteEdit,
  NotesPutResponse,
  ReviewPatch,
  SaveResponse,
  TargetPatchResponse,
  UnitCreateRequest,
  UnitCreateResponse,
  UnitDeleteResponse,
  UnitDetail,
  UnitRowsResponse,
  UnitState,
  UnitsQueryRequest,
  UnitsQueryResponse,
} from '@lexi/shared';

/**
 * The imperative half of the grid's server calls.
 *
 * The QUERY is not here: it is a pure function of reactive state — the search
 * box, the filter checkboxes, the namespace tree — and a superseded request
 * must be cancelled rather than queued, which is exactly what `httpResource`
 * does and what a promise cannot. It lives in `UnitsStore`.
 *
 * Row windows are the opposite shape. They are driven by the rendered range,
 * they ACCUMULATE into a cache rather than replacing a value, and two windows
 * in flight at once is the normal case during a fling — so an awaited call that
 * merges its result is the honest expression of what happens.
 */
@Injectable({ providedIn: 'root' })
export class UnitsApi {
  readonly #http = inject(HttpClient);

  rows(ids: readonly string[], locales: readonly string[]): Promise<UnitRowsResponse> {
    return firstValueFrom(this.#http.post<UnitRowsResponse>('/api/units/rows', { ids, locales }));
  }

  /**
   * The review queue's id list (M14).
   *
   * The grid asks the same question through an `httpResource`, because there it
   * is a function of state that changes under the user's fingers — a keystroke
   * in the search box must abort the request the previous keystroke started.
   * The review queue is the opposite: it is asked once on entry and again after
   * each decision, and every answer matters, so an awaited call is the honest
   * expression of it. The same split `rows` versus `query` already makes.
   */
  query(body: UnitsQueryRequest): Promise<UnitsQueryResponse> {
    return firstValueFrom(this.#http.post<UnitsQueryResponse>('/api/units/query', body));
  }

  /** `locales` omitted means the visible columns, as the panel wants it. */
  detail(rowId: string, locales?: readonly string[]): Promise<UnitDetail> {
    const qs = locales === undefined ? '' : `?locales=${locales.map(encodeURIComponent).join(',')}`;
    return firstValueFrom(
      this.#http.get<UnitDetail>(`/api/units/${encodeURIComponent(rowId)}${qs}`),
    );
  }

  /**
   * Delete a key from the source and every locale file. NOT staged — this
   * writes to disk at once, so the caller confirms first.
   */
  deleteUnit(rowId: string): Promise<UnitDeleteResponse> {
    return firstValueFrom(
      this.#http.delete<UnitDeleteResponse>(`/api/units/${encodeURIComponent(rowId)}`),
    );
  }

  /**
   * Add a key to a group's source file. NOT staged either — the unit is on disk
   * when this resolves; its translations are then ordinary staged edits.
   */
  createUnit(req: UnitCreateRequest): Promise<UnitCreateResponse> {
    return firstValueFrom(this.#http.post<UnitCreateResponse>('/api/units', req));
  }

  /* ---- writing (M6) ------------------------------------------------------ */

  /**
   * Commit one target. Imperative and awaited, not an `httpResource`: this is an
   * ACTION with a consequence, not a view of reactive state, and its answer —
   * the live findings and the unsaved count — has to be applied rather than
   * merely displayed.
   *
   * The payload carries ids and text only. The server re-attaches every
   * placeholder's original bytes; the browser never sees or sends one.
   */
  patchTarget(
    rowId: string,
    locale: string,
    segments: readonly EditSegmentDto[],
    state?: UnitState,
    review?: ReviewPatch,
  ): Promise<TargetPatchResponse> {
    return firstValueFrom(
      this.#http.patch<TargetPatchResponse>(
        `/api/units/${encodeURIComponent(rowId)}/targets/${encodeURIComponent(locale)}`,
        {
          segments,
          ...(state === undefined ? {} : { state }),
          ...(review === undefined ? {} : { review }),
        },
      ),
    );
  }

  /** FR-4.2: a unit's notes as they should read — the whole list. Lands in the overlay. */
  putNotes(rowId: string, notes: readonly NoteEdit[]): Promise<NotesPutResponse> {
    return firstValueFrom(
      this.#http.put<NotesPutResponse>(`/api/units/${encodeURIComponent(rowId)}/notes`, { notes }),
    );
  }

  /** FR-3.12. Server-side, so the copy keeps the source's original bytes. */
  copySource(rowId: string, locale: string): Promise<TargetPatchResponse> {
    return firstValueFrom(
      this.#http.post<TargetPatchResponse>(
        `/api/units/${encodeURIComponent(rowId)}/targets/${encodeURIComponent(locale)}/copy-source`,
        {},
      ),
    );
  }

  discardDraft(rowId: string, locale: string): Promise<TargetPatchResponse> {
    return firstValueFrom(
      this.#http.delete<TargetPatchResponse>(
        `/api/units/${encodeURIComponent(rowId)}/targets/${encodeURIComponent(locale)}/draft`,
      ),
    );
  }

  save(paths?: readonly string[]): Promise<SaveResponse> {
    return firstValueFrom(
      this.#http.post<SaveResponse>('/api/save', paths === undefined ? {} : { paths }),
    );
  }

  /** FR-7.3. Behind Focus mode's own confirmation — this call does not ask again. */
  bulkApprove(rowIds: readonly string[], locale: string): Promise<BulkApproveResponse> {
    return firstValueFrom(
      this.#http.post<BulkApproveResponse>('/api/units/bulk-approve', { rowIds, locale }),
    );
  }

  /** Throw these cells' drafts away — or, with none given, every unsaved edit. One undo step. */
  discard(cells?: DiscardRequest['cells']): Promise<DiscardResponse> {
    return firstValueFrom(
      this.#http.post<DiscardResponse>('/api/drafts/discard', cells === undefined ? {} : { cells }),
    );
  }

  history(): Promise<HistoryStatus> {
    return firstValueFrom(this.#http.get<HistoryStatus>('/api/history'));
  }

  undo(): Promise<HistoryStepResponse> {
    return firstValueFrom(this.#http.post<HistoryStepResponse>('/api/history/undo', {}));
  }

  redo(): Promise<HistoryStepResponse> {
    return firstValueFrom(this.#http.post<HistoryStepResponse>('/api/history/redo', {}));
  }
}
