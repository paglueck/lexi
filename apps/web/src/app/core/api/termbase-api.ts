// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  Term,
  TermBaseResponse,
  TermCreateRequest,
  TermImportRequest,
  TermImportResponse,
  TermPatchRequest,
} from '@lexi/shared';

/** The Term Base tab (FR-5.8). */
@Injectable({ providedIn: 'root' })
export class TermBaseApi {
  readonly #http = inject(HttpClient);

  list(): Promise<TermBaseResponse> {
    return firstValueFrom(this.#http.get<TermBaseResponse>('/api/termbase'));
  }

  add(term: TermCreateRequest): Promise<Term> {
    return firstValueFrom(this.#http.post<Term>('/api/termbase', term));
  }

  patch(id: string, patch: TermPatchRequest): Promise<Term> {
    return firstValueFrom(this.#http.patch<Term>(`/api/termbase/${encodeURIComponent(id)}`, patch));
  }

  remove(id: string): Promise<TermBaseResponse> {
    return firstValueFrom(
      this.#http.delete<TermBaseResponse>(`/api/termbase/${encodeURIComponent(id)}`),
    );
  }

  import(request: TermImportRequest): Promise<TermImportResponse> {
    return firstValueFrom(this.#http.post<TermImportResponse>('/api/termbase/import', request));
  }
}
