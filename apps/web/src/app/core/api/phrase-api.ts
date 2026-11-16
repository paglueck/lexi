// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  PhraseBranchesResponse,
  PhrasePinLocalesResponse,
  PhraseProjectsResponse,
  PhrasePushRequest,
  PhrasePushResponse,
  PhraseStatus,
} from '@lexi/shared';

/**
 * The push and connect calls. The browser never sees an access token: tokens
 * are saved through `PhraseTokensApi`, and every call here is answered by the
 * server, which is the one that talks to Phrase.
 */
@Injectable({ providedIn: 'root' })
export class PhraseApi {
  readonly #http = inject(HttpClient);

  /**
   * `branch`: check the files against that branch, null against the main
   * project, undefined against what `.phrase.yml` says.
   */
  status(branch?: string | null): Promise<PhraseStatus> {
    const query = branch === undefined ? '' : `?branch=${encodeURIComponent(branch ?? '')}`;
    return firstValueFrom(this.#http.get<PhraseStatus>(`/api/phrase/status${query}`));
  }

  projects(): Promise<PhraseProjectsResponse> {
    return firstValueFrom(this.#http.get<PhraseProjectsResponse>('/api/phrase/projects'));
  }

  /** Writes `.phrase.yml` into the project. 409 when one exists already. */
  connect(projectId: string): Promise<PhraseStatus> {
    return firstValueFrom(this.#http.post<PhraseStatus>('/api/phrase/connect', { projectId }));
  }

  /** Rewrites `.phrase.yml`'s locale_id values to Phrase locale ids. All or nothing. */
  pinLocales(): Promise<PhrasePinLocalesResponse> {
    return firstValueFrom(this.#http.post<PhrasePinLocalesResponse>('/api/phrase/pin-locales', {}));
  }

  /** The open branches of the config's Phrase project, and the one the config names. */
  branches(): Promise<PhraseBranchesResponse> {
    return firstValueFrom(this.#http.get<PhraseBranchesResponse>('/api/phrase/branches'));
  }

  /**
   * `branch`: a branch name, null for the main project, or undefined to push
   * where `.phrase.yml` says. `verify`: mark the uploaded translations as
   * verified (or not); undefined lets `.phrase.yml` decide.
   */
  push(branch?: string | null, verify?: boolean): Promise<PhrasePushResponse> {
    const body: PhrasePushRequest = {
      ...(branch === undefined ? {} : { branch }),
      ...(verify === undefined ? {} : { verify }),
    };
    return firstValueFrom(this.#http.post<PhrasePushResponse>('/api/phrase/push', body));
  }

  /** Stops the push under way; its own request then answers with what got pushed. */
  cancelPush(): Promise<void> {
    return firstValueFrom(this.#http.post<void>('/api/phrase/push/cancel', {}));
  }
}
