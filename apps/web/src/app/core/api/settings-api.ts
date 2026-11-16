// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { LlmProbe, Settings, SettingsPatch } from '@lexi/shared';

/**
 * S7's three calls (FR-6.1 … FR-6.4).
 *
 * Promise-returning like `ProjectApi`, and for the same reason: every one of
 * these is an imperative answer to a click.
 *
 * Note what is NOT here: nothing translates yet, and nothing on this screen
 * talks to the model directly. The page patches settings and asks the server to
 * probe — the browser never holds the endpoint's address as anything but text,
 * and the page's own CSP (`connect-src 'self'`) would refuse the call anyway.
 */
@Injectable({ providedIn: 'root' })
export class SettingsApi {
  readonly #http = inject(HttpClient);

  get(): Promise<Settings> {
    return firstValueFrom(this.#http.get<Settings>('/api/settings'));
  }

  patch(patch: SettingsPatch): Promise<Settings> {
    return firstValueFrom(this.#http.patch<Settings>('/api/settings', patch));
  }

  /** Probes what is STORED, which is why the page patches before it tests. */
  test(): Promise<LlmProbe> {
    return firstValueFrom(this.#http.post<LlmProbe>('/api/llm/test', {}));
  }
}
