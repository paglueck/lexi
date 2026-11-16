// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, type HttpParameterCodec } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  PhraseCheckoutBranchesResponse,
  PhraseCheckoutRequest,
  PhraseCheckoutResult,
  PhraseCheckoutScope,
  PhraseCheckoutValidateResponse,
  PhraseProjectDetail,
  PhraseScopeKeys,
  PhraseScopePreview,
  PhraseTagsResponse,
} from '@lexi/shared';

/**
 * S18's calls. Everything that reaches Phrase goes through a saved token,
 * named by its local id; the browser never holds a secret.
 */
@Injectable({ providedIn: 'root' })
export class PhraseCheckoutApi {
  readonly #http = inject(HttpClient);

  /** `branch`: an open branch to read, or null for the main project (here and below). */
  project(
    tokenId: string,
    projectId: string,
    branch: string | null = null,
  ): Promise<PhraseProjectDetail> {
    return firstValueFrom(
      this.#http.get<PhraseProjectDetail>(`${base(tokenId, projectId)}`, {
        params: branchParams(branch),
      }),
    );
  }

  /** The project's open branches; step 2 offers them before the scope. */
  branches(tokenId: string, projectId: string): Promise<PhraseCheckoutBranchesResponse> {
    return firstValueFrom(
      this.#http.get<PhraseCheckoutBranchesResponse>(`${base(tokenId, projectId)}/branches`),
    );
  }

  tags(
    tokenId: string,
    projectId: string,
    branch: string | null = null,
  ): Promise<PhraseTagsResponse> {
    return firstValueFrom(
      this.#http.get<PhraseTagsResponse>(`${base(tokenId, projectId)}/tags`, {
        params: branchParams(branch),
      }),
    );
  }

  /** `…/preview?scope=all`, or `…/preview?tag=a&tag=b` with every tag encoded. */
  preview(
    tokenId: string,
    projectId: string,
    scope: PhraseCheckoutScope,
    branch: string | null = null,
  ): Promise<PhraseScopePreview> {
    return firstValueFrom(
      this.#http.get<PhraseScopePreview>(`${base(tokenId, projectId)}/preview`, {
        params: scopeParams(scope, branch),
      }),
    );
  }

  /** Every key of the scope with its base text; the same query as `preview`. */
  keys(
    tokenId: string,
    projectId: string,
    scope: PhraseCheckoutScope,
    branch: string | null = null,
  ): Promise<PhraseScopeKeys> {
    return firstValueFrom(
      this.#http.get<PhraseScopeKeys>(`${base(tokenId, projectId)}/keys`, {
        params: scopeParams(scope, branch),
      }),
    );
  }

  /** Step 3's folder checks on the server — mainly "does it exist already". */
  validate(parentDir: string, folderName: string): Promise<PhraseCheckoutValidateResponse> {
    return firstValueFrom(
      this.#http.post<PhraseCheckoutValidateResponse>('/api/phrase/checkout/validate', {
        parentDir,
        folderName,
      }),
    );
  }

  /** Long-running; the log rows move through `phrase-checkout-progress` events meanwhile. */
  checkout(body: PhraseCheckoutRequest): Promise<PhraseCheckoutResult> {
    return firstValueFrom(this.#http.post<PhraseCheckoutResult>('/api/phrase/checkout', body));
  }

  /** Only honoured while the keys or base text are still being fetched. */
  cancel(): Promise<void> {
    return firstValueFrom(this.#http.post<void>('/api/phrase/checkout/cancel', {}));
  }
}

/**
 * `encodeURIComponent` for keys and values. Angular's default codec leaves
 * `+`, `,`, `;`, … as they are, and a tag may well contain a `+`.
 */
const STRICT: HttpParameterCodec = {
  encodeKey: (key) => encodeURIComponent(key),
  encodeValue: (value) => encodeURIComponent(value),
  decodeKey: (key) => decodeURIComponent(key),
  decodeValue: (value) => decodeURIComponent(value),
};

/** `branch=name` for a branch, nothing for the main project. */
function branchParams(branch: string | null): HttpParams {
  const params = new HttpParams({ encoder: STRICT });
  return branch === null ? params : params.set('branch', branch);
}

/** `scope=all`, or one `tag` parameter per tag, every value encoded; plus the branch. */
function scopeParams(scope: PhraseCheckoutScope, branch: string | null = null): HttpParams {
  let params = branchParams(branch);
  if (scope.kind === 'all') params = params.set('scope', 'all');
  else for (const tag of scope.tags) params = params.append('tag', tag);
  return params;
}

const base = (tokenId: string, projectId: string): string =>
  `/api/phrase/tokens/${encodeURIComponent(tokenId)}/projects/${encodeURIComponent(projectId)}`;
