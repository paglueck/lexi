// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { SharedSourcesPutRequest, SharedSourcesResponse } from '@lexi/shared';

/** Link the style guides or the Term Base to a shared folder, or unlink them. */
@Injectable({ providedIn: 'root' })
export class SharedSourcesApi {
  readonly #http = inject(HttpClient);

  get(): Promise<SharedSourcesResponse> {
    return firstValueFrom(this.#http.get<SharedSourcesResponse>('/api/shared-sources'));
  }

  put(request: SharedSourcesPutRequest): Promise<SharedSourcesResponse> {
    return firstValueFrom(this.#http.put<SharedSourcesResponse>('/api/shared-sources', request));
  }
}
