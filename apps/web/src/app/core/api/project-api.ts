// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  CreateLocaleFileResponse,
  FilesReloadResponse,
  FsBrowseResponse,
  FsRootsResponse,
  Project,
  ProjectPatch,
  ProjectResumeResponse,
  ProjectScanResponse,
  RecentsResponse,
} from '@lexi/shared';

/**
 * The server calls behind S1 and S2.
 *
 * Plain promise-returning methods rather than `httpResource`, deliberately.
 * These are imperative one-shot actions in response to a click — scan this
 * folder, open this project — where an awaited call reads the way the code
 * actually behaves. `httpResource` earns its keep where a request is a function
 * of reactive state and a superseded request should be cancelled, which is M5's
 * grid query, not any of these.
 *
 * The boot token is attached by `lexiTokenInterceptor`; nothing here knows
 * about it.
 */
@Injectable({ providedIn: 'root' })
export class ProjectApi {
  readonly #http = inject(HttpClient);

  roots(): Promise<FsRootsResponse> {
    return firstValueFrom(this.#http.get<FsRootsResponse>('/api/fs/roots'));
  }

  browse(path: string): Promise<FsBrowseResponse> {
    return firstValueFrom(this.#http.get<FsBrowseResponse>('/api/fs/browse', { params: { path } }));
  }

  scan(path: string): Promise<ProjectScanResponse> {
    return firstValueFrom(this.#http.post<ProjectScanResponse>('/api/projects/scan', { path }));
  }

  /** Open with the mapping saved last time; `needsSetup` sends the caller to the wizard. */
  resume(path: string): Promise<ProjectResumeResponse> {
    return firstValueFrom(this.#http.post<ProjectResumeResponse>('/api/projects/resume', { path }));
  }

  open(body: {
    path: string;
    sourceLocale: string;
    mapping: ReadonlyArray<{
      path: string;
      fileIndex: number;
      locale: string;
      fixTargetLanguage: boolean;
    }>;
  }): Promise<Project> {
    return firstValueFrom(this.#http.post<Project>('/api/projects/open', body));
  }

  /** Rejects with a 404 when nothing is open — the caller treats that as "none". */
  current(): Promise<Project> {
    return firstValueFrom(this.#http.get<Project>('/api/project'));
  }

  patch(patch: ProjectPatch): Promise<Project> {
    return firstValueFrom(this.#http.patch<Project>('/api/project', patch));
  }

  /**
   * Start a locale that has no file yet (FR-1.9).
   *
   * A separate, explicit call because it puts a new `.xlf` in the user's
   * repository. Inserting a missing `<trans-unit>` into a file that exists
   * needs no such ceremony and happens as part of an ordinary edit.
   */
  createLocaleFile(group: string, locale: string): Promise<CreateLocaleFileResponse> {
    return firstValueFrom(
      this.#http.post<CreateLocaleFileResponse>('/api/locales/file', { group, locale }),
    );
  }

  /**
   * Re-read files that changed on disk (FR-1.5). Absolute paths, matching the
   * `file-changed` event they came from; an empty list means every document.
   */
  reloadFiles(paths: readonly string[]): Promise<FilesReloadResponse> {
    return firstValueFrom(
      this.#http.post<FilesReloadResponse>('/api/files/reload', { paths: [...paths] }),
    );
  }

  /** Put the server back to having nothing open. 204 whatever the state. */
  close(): Promise<void> {
    return firstValueFrom(this.#http.post<void>('/api/project/close', {}));
  }

  recents(): Promise<RecentsResponse> {
    return firstValueFrom(this.#http.get<RecentsResponse>('/api/recents'));
  }

  forgetRecent(id: string): Promise<void> {
    return firstValueFrom(this.#http.delete<void>(`/api/recents/${id}`));
  }

  /** "Clear recent projects" — the whole list, not the projects. */
  clearRecents(): Promise<void> {
    return firstValueFrom(this.#http.delete<void>('/api/recents'));
  }

  /** The folder moved: point the entry at its new place. Answers the whole list. */
  locateRecent(id: string, path: string): Promise<RecentsResponse> {
    return firstValueFrom(
      this.#http.post<RecentsResponse>(`/api/recents/${encodeURIComponent(id)}/locate`, { path }),
    );
  }
}
