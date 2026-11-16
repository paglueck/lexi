// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  PhraseRegion,
  PhraseToken,
  PhraseTokenCreateRequest,
  PhraseTokenUpdateRequest,
  PhraseTokenVerifyResponse,
  PhraseTokensResponse,
} from '@lexi/shared';

/**
 * S19's saved Phrase tokens. A secret goes up once — to verify, to save, or
 * to replace — and never comes back: every answer is the token without it.
 * Shared by Settings › Phrase and the checkout's step 1.
 */
@Injectable({ providedIn: 'root' })
export class PhraseTokensApi {
  readonly #http = inject(HttpClient);

  list(): Promise<PhraseTokensResponse> {
    return firstValueFrom(this.#http.get<PhraseTokensResponse>('/api/phrase/tokens'));
  }

  /** Check a token that is not saved yet. A rejection is `ok: false`, not an HTTP error. */
  verify(token: string, region: PhraseRegion): Promise<PhraseTokenVerifyResponse> {
    return firstValueFrom(
      this.#http.post<PhraseTokenVerifyResponse>('/api/phrase/tokens/verify', { token, region }),
    );
  }

  create(body: PhraseTokenCreateRequest): Promise<PhraseToken> {
    return firstValueFrom(this.#http.post<PhraseToken>('/api/phrase/tokens', body));
  }

  update(id: string, patch: PhraseTokenUpdateRequest): Promise<PhraseToken> {
    return firstValueFrom(this.#http.patch<PhraseToken>(`/api/phrase/tokens/${enc(id)}`, patch));
  }

  replaceSecret(id: string, token: string): Promise<PhraseToken> {
    return firstValueFrom(
      this.#http.put<PhraseToken>(`/api/phrase/tokens/${enc(id)}/secret`, { token }),
    );
  }

  /** Ask Phrase again; status, projects and `checkedAt` come back updated. */
  check(id: string): Promise<PhraseToken> {
    return firstValueFrom(this.#http.post<PhraseToken>(`/api/phrase/tokens/${enc(id)}/check`, {}));
  }

  remove(id: string): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`/api/phrase/tokens/${enc(id)}`));
  }
}

const enc = encodeURIComponent;
