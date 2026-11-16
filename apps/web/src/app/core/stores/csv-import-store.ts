// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  parseReviewCsv,
  type CsvImportPreviewRequest,
  type CsvImportPreviewResponse,
} from '@lexi/shared';

import { CsvImportApi } from '../api/csv-import-api.js';
import { messageOf } from '../api/server-message.js';
import { ProjectStore } from './project-store.js';

/** Where the import was started from, which is also where Cancel returns to. */
export type CsvImportOrigin = { jobId: string } | { grid: true };

/** A picked file as it was read for the preview: its name and its text. */
export type CsvImportFile = CsvImportPreviewRequest['files'][number];

/**
 * What the import screen shows: the picked files and the server's preview.
 *
 * The files are parsed here first, so a CSV that is not a review file (a
 * missing column) is reported next to the button that picked it, instead of
 * after a navigation to a screen with nothing on it. Only a file that parses
 * costs a server round trip.
 */
@Injectable({ providedIn: 'root' })
export class CsvImportStore {
  readonly #api = inject(CsvImportApi);
  readonly #router = inject(Router);
  readonly #project = inject(ProjectStore);

  /**
   * The texts the preview was made from, not the `File`s. Apply sends these
   * again; reading the files a second time would pick up a CSV re-saved in
   * between and write rows the user never saw.
   */
  readonly #files = signal<readonly CsvImportFile[]>([]);
  readonly #origin = signal<CsvImportOrigin | null>(null);
  readonly #preview = signal<CsvImportPreviewResponse | null>(null);
  readonly #error = signal<string | null>(null);
  readonly #busy = signal(false);

  readonly files = this.#files.asReadonly();
  readonly origin = this.#origin.asReadonly();
  readonly preview = this.#preview.asReadonly();
  readonly error = this.#error.asReadonly();
  readonly busy = this.#busy.asReadonly();

  /**
   * Reads, checks and previews `files`, then goes to the import screen; on any
   * failure stays put with `error` set.
   *
   * The previous import is dropped first, so a failed second pick can never
   * leave the first file's preview on screen under the second file's name. A
   * start while one is running is ignored: two previews racing would end on
   * whichever answered last, not on the file picked last.
   */
  async start(files: File[], origin: CsvImportOrigin): Promise<void> {
    if (files.length === 0 || this.#busy()) return;
    this.clear();
    this.#busy.set(true);
    try {
      const texts = await Promise.all(
        files.map(async (file) => ({ name: file.name, text: await file.text() })),
      );
      for (const { name, text } of texts) {
        const parsed = parseReviewCsv(
          name,
          text,
          this.#project.targetLocales().map((l) => l.locale),
        );
        if ('error' in parsed) {
          this.#error.set(`${name}: ${parsed.error}`);
          return;
        }
      }
      const jobId = 'jobId' in origin ? origin.jobId : null;
      const preview = await this.#api.preview({ files: texts, jobId });
      this.#files.set(texts);
      this.#origin.set(origin);
      this.#preview.set(preview);
      await this.#router.navigateByUrl(jobId === null ? '/import' : `/jobs/${jobId}/import`);
    } catch (error) {
      this.#error.set(messageOf(error, 'The CSV could not be previewed.'));
    } finally {
      this.#busy.set(false);
    }
  }

  clear(): void {
    this.#files.set([]);
    this.#origin.set(null);
    this.#preview.set(null);
    this.#error.set(null);
  }
}
