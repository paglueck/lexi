// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { PlaceholderStyle, PromptPreviewResponse, TranslateUnitResponse } from '@lexi/shared';

/**
 * S5's two calls (M9).
 *
 * Note what is NOT here: any notion of what a prompt looks like. The client
 * asks for one and renders the blocks it is given — the order, the wording and
 * the masking all live on the server, which is what makes the preview provably
 * the same text the run carries (FR-5.7).
 *
 * The browser never talks to the model either. It could not: the page's CSP
 * carries `connect-src 'self'`, so the one door to the endpoint is the server's
 * `llmFetch` (FR-6.15).
 */
@Injectable({ providedIn: 'root' })
export class PromptApi {
  readonly #http = inject(HttpClient);

  preview(
    rowId: string,
    locale: string,
    placeholderStyle?: PlaceholderStyle,
    instruction?: string,
  ): Promise<PromptPreviewResponse> {
    return firstValueFrom(
      this.#http.post<PromptPreviewResponse>('/api/prompt/preview', {
        rowId,
        locale,
        ...(placeholderStyle === undefined ? {} : { placeholderStyle }),
        ...(instruction === undefined || instruction === '' ? {} : { instruction }),
      }),
    );
  }

  /**
   * One unit (FR-6.5).
   *
   * `overwrite` is deliberately not defaulted here. The server answers 409 when
   * a human translation is in the way, and the confirmation belongs to the
   * screen that can show what would be replaced.
   */
  translate(
    rowId: string,
    locale: string,
    options: {
      placeholderStyle?: PlaceholderStyle;
      instruction?: string;
      overwrite?: boolean;
    } = {},
  ): Promise<TranslateUnitResponse> {
    return firstValueFrom(
      this.#http.post<TranslateUnitResponse>('/api/translate/unit', {
        rowId,
        locale,
        ...(options.placeholderStyle === undefined
          ? {}
          : { placeholderStyle: options.placeholderStyle }),
        ...(options.instruction === undefined || options.instruction === ''
          ? {}
          : { instruction: options.instruction }),
        ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
      }),
    );
  }
}
