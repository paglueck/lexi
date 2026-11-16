// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { UpdateStatus } from '@lexi/shared';

/**
 * `/api/update` — the desktop app's updater, which the server forwards.
 *
 * `check` resolves with what the check found. `download` and `install` only
 * start something; how it goes arrives as `update` events on the SSE stream.
 */
@Injectable({ providedIn: 'root' })
export class UpdateApi {
  readonly #http = inject(HttpClient);

  status(): Promise<UpdateStatus> {
    return firstValueFrom(this.#http.get<UpdateStatus>('/api/update'));
  }

  check(): Promise<UpdateStatus> {
    return firstValueFrom(this.#http.post<UpdateStatus>('/api/update/check', {}));
  }

  download(): Promise<UpdateStatus> {
    return firstValueFrom(this.#http.post<UpdateStatus>('/api/update/download', {}));
  }

  install(): Promise<UpdateStatus> {
    return firstValueFrom(this.#http.post<UpdateStatus>('/api/update/install', {}));
  }
}
