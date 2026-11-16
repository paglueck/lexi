// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  CsvImportApplyRequest,
  CsvImportApplyResponse,
  CsvImportPreviewRequest,
  CsvImportPreviewResponse,
  CsvImportUndoResponse,
  JobImportsResponse,
} from '@lexi/shared';

/**
 * The reviewed-CSV re-import calls: preview, apply, undo and a job's import
 * history. Thin like `JobsApi`: the comparison and the write both live on the
 * server, and a 409 on apply is left to the caller to read off the error.
 */
@Injectable({ providedIn: 'root' })
export class CsvImportApi {
  readonly #http = inject(HttpClient);

  preview(request: CsvImportPreviewRequest): Promise<CsvImportPreviewResponse> {
    return firstValueFrom(
      this.#http.post<CsvImportPreviewResponse>('/api/csv-import/preview', request),
    );
  }

  apply(request: CsvImportApplyRequest): Promise<CsvImportApplyResponse> {
    return firstValueFrom(
      this.#http.post<CsvImportApplyResponse>('/api/csv-import/apply', request),
    );
  }

  undo(id: string): Promise<CsvImportUndoResponse> {
    return firstValueFrom(
      this.#http.post<CsvImportUndoResponse>(
        `/api/csv-import/${encodeURIComponent(id)}/undo`,
        {},
      ),
    );
  }

  jobImports(jobId: string): Promise<JobImportsResponse> {
    return firstValueFrom(
      this.#http.get<JobImportsResponse>(`/api/jobs/${encodeURIComponent(jobId)}/imports`),
    );
  }
}
