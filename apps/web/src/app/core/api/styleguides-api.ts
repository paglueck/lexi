// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { MarkdownPreviewResponse, StyleGuide, StyleGuideListResponse } from '@lexi/shared';

/**
 * S6's style guide calls (FR-5.1 … FR-5.5).
 *
 * Promise-returning, like the other imperative APIs: opening a tab and saving a
 * guide are both answers to a click. The live PREVIEW is the exception and does
 * not live here — it is keyed on what is in the editor, so it belongs to an
 * `httpResource` in the store, where a superseded render is cancelled rather
 * than raced.
 */
@Injectable({ providedIn: 'root' })
export class StyleguidesApi {
  readonly #http = inject(HttpClient);

  list(): Promise<StyleGuideListResponse> {
    return firstValueFrom(this.#http.get<StyleGuideListResponse>('/api/styleguides'));
  }

  get(key: string): Promise<StyleGuide> {
    return firstValueFrom(
      this.#http.get<StyleGuide>(`/api/styleguides/${encodeURIComponent(key)}`),
    );
  }

  save(key: string, text: string): Promise<StyleGuide> {
    return firstValueFrom(
      this.#http.put<StyleGuide>(`/api/styleguides/${encodeURIComponent(key)}`, { text }),
    );
  }

  remove(key: string): Promise<StyleGuide> {
    return firstValueFrom(
      this.#http.delete<StyleGuide>(`/api/styleguides/${encodeURIComponent(key)}`),
    );
  }

  /** Only for a one-off render; the live pane uses the store's resource. */
  render(text: string): Promise<MarkdownPreviewResponse> {
    return firstValueFrom(
      this.#http.post<MarkdownPreviewResponse>('/api/markdown/preview', { text }),
    );
  }
}
