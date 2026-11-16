// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  Job,
  JobCreateRequest,
  JobLogResponse,
  JobsClearResponse,
  ReportQuery,
} from '@lexi/shared';

/**
 * S14's calls (M11) — the job queue, a loop over M9's single-unit path per locale.
 *
 * Same shape as `PromptApi`: thin, no business logic. A job's state machine
 * lives entirely on the server (`JobQueue`), and this class only asks for it.
 */
@Injectable({ providedIn: 'root' })
export class JobsApi {
  readonly #http = inject(HttpClient);

  /** One job over every locale in `request.locales`, run in that order. */
  create(request: JobCreateRequest): Promise<Job> {
    const { instruction, overwrite, ...rest } = request;
    return firstValueFrom(
      this.#http.post<Job>('/api/jobs', {
        ...rest,
        ...(instruction === undefined || instruction === '' ? {} : { instruction }),
        ...(overwrite === undefined ? {} : { overwrite }),
      }),
    );
  }

  /** Takes a queued job out of the queue, or a finished one off the list. */
  remove(id: string): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`/api/jobs/${id}`));
  }

  /** Takes every finished job off the list. */
  clearFinished(): Promise<JobsClearResponse> {
    return firstValueFrom(this.#http.post<JobsClearResponse>('/api/jobs/clear-finished', {}));
  }

  skipLocale(id: string, locale: string): Promise<Job> {
    return firstValueFrom(
      this.#http.post<Job>(`/api/jobs/${id}/locales/${encodeURIComponent(locale)}/skip`, {}),
    );
  }

  unskipLocale(id: string, locale: string): Promise<Job> {
    return firstValueFrom(
      this.#http.post<Job>(`/api/jobs/${id}/locales/${encodeURIComponent(locale)}/unskip`, {}),
    );
  }

  list(): Promise<Job[]> {
    return firstValueFrom(this.#http.get<Job[]>('/api/jobs'));
  }

  get(id: string): Promise<Job> {
    return firstValueFrom(this.#http.get<Job>(`/api/jobs/${id}`));
  }

  pause(id: string): Promise<Job> {
    return firstValueFrom(this.#http.post<Job>(`/api/jobs/${id}/pause`, {}));
  }

  resume(id: string): Promise<Job> {
    return firstValueFrom(this.#http.post<Job>(`/api/jobs/${id}/resume`, {}));
  }

  cancel(id: string): Promise<Job> {
    return firstValueFrom(this.#http.post<Job>(`/api/jobs/${id}/cancel`, {}));
  }

  /** `after` omitted fetches the whole log; passed, it fetches only the tail. */
  log(id: string, after?: number): Promise<JobLogResponse> {
    const qs = after === undefined ? '' : `?after=${after}`;
    return firstValueFrom(this.#http.get<JobLogResponse>(`/api/jobs/${id}/log${qs}`));
  }

  /**
   * The review report, a self-contained HTML file, or the translations as CSV.
   * Fetched rather than linked to, because a plain link cannot carry
   * `X-Lexi-Token`.
   */
  async report(id: string, query: ReportQuery): Promise<{ blob: Blob; filename: string }> {
    const res = await firstValueFrom(
      this.#http.get(`/api/jobs/${id}/report`, {
        params: { ...query },
        observe: 'response',
        responseType: 'blob',
      }),
    );
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ??
      `lexi-review-${id}.${query.split === 'perLocale' ? 'zip' : query.format}`;
    const type =
      query.split === 'perLocale'
        ? 'application/zip'
        : query.format === 'csv'
          ? 'text/csv'
          : 'text/html';
    return {
      blob: res.body ?? new Blob([], { type }),
      filename,
    };
  }
}
