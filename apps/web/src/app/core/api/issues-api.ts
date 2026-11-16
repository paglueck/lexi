// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  IgnoredFindingsResponse,
  IssueFixAllResponse,
  IssueFixResponse,
  IssueRef,
  IssuesSummary,
} from '@lexi/shared';
import type { RuleId } from '@lexi/shared/constants';

/**
 * S12's actions. The two reads (the summary and one rule's findings) are
 * `httpResource`s in `IssuesStore`, because they follow the selection and a
 * superseded answer must never land.
 */
@Injectable({ providedIn: 'root' })
export class IssuesApi {
  readonly #http = inject(HttpClient);

  /** The server recomputes the fix from what the cell holds now; the ref only names it. */
  fix(ref: IssueRef): Promise<IssueFixResponse> {
    return firstValueFrom(this.#http.post<IssueFixResponse>('/api/issues/fix', ref));
  }

  fixAll(rule: RuleId, locale: string | null): Promise<IssueFixAllResponse> {
    return firstValueFrom(
      this.#http.post<IssueFixAllResponse>('/api/issues/fix-all', {
        rule,
        ...(locale === null ? {} : { locale }),
      }),
    );
  }

  ignore(ref: IssueRef): Promise<IssuesSummary> {
    return firstValueFrom(this.#http.post<IssuesSummary>('/api/issues/ignore', ref));
  }

  unignore(ref: IssueRef): Promise<IssuesSummary> {
    return firstValueFrom(this.#http.delete<IssuesSummary>('/api/issues/ignore', { body: ref }));
  }

  ignored(): Promise<IgnoredFindingsResponse> {
    return firstValueFrom(this.#http.get<IgnoredFindingsResponse>('/api/issues/ignored'));
  }

  revalidate(locale: string | null): Promise<IssuesSummary> {
    const qs = locale === null ? '' : `?locale=${encodeURIComponent(locale)}`;
    return firstValueFrom(this.#http.post<IssuesSummary>(`/api/issues/revalidate${qs}`, {}));
  }
}
