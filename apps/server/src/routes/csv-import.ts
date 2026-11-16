// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  CsvImportApplyRequestSchema,
  CsvImportPreviewRequestSchema,
  type CsvImportApplyResponse,
  type CsvImportPreviewResponse,
  type CsvImportUndoResponse,
  type JobImportsResponse,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import type { EventBus } from '../lib/event-bus.js';
import { notFound } from '../lib/http-error.js';
import { listImportRecords, summaryOf } from '../lib/import-record.js';
import { applyCsvImport, previewCsvImport, undoCsvImport } from '../services/csv-import.js';
import type { ProjectService } from '../services/project-service.js';

/**
 * How big a CSV import request may be. The files travel as text inside the
 * JSON body, and a multi-locale export of a few thousand units — or two
 * picked files — is well past the server's global 1 MiB. Preview and Apply
 * both re-send the files, so both routes take this limit.
 */
export const CSV_IMPORT_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * The CSV re-import. Thin: the files arrive as text in the body and
 * `services/csv-import.ts` does the comparing. The preview writes nothing, so
 * it is a POST only because the files do not fit in a query string.
 *
 * Apply and Undo write into the user's XLIFF files, through `lib/save.ts` —
 * the same save path `routes/edit.ts` uses, narrowed to the imported cells.
 */
export function registerCsvImport(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  bus: EventBus,
): void {
  const projectPath = (): string => {
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    return project.path;
  };

  app.post(
    '/api/csv-import/preview',
    { bodyLimit: CSV_IMPORT_BODY_LIMIT },
    async (req): Promise<CsvImportPreviewResponse> => {
      const body = CsvImportPreviewRequestSchema.parse(req.body ?? {});
      return previewCsvImport(projects, projectPath(), body);
    },
  );

  app.post(
    '/api/csv-import/apply',
    { bodyLimit: CSV_IMPORT_BODY_LIMIT },
    async (req): Promise<CsvImportApplyResponse> => {
      const body = CsvImportApplyRequestSchema.parse(req.body ?? {});
      return applyCsvImport(cfg, projects, bus, projectPath(), body);
    },
  );

  /** The id is checked to be a UUID before it names a file (`isImportId`). */
  app.post<{ Params: { id: string } }>(
    '/api/csv-import/:id/undo',
    async (req): Promise<CsvImportUndoResponse> =>
      undoCsvImport(cfg, projects, bus, projectPath(), req.params.id),
  );

  /**
   * The imports of one job, newest first, for the job's Import history. Only
   * compared with each record's `jobId`, never made into a path.
   */
  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id/imports',
    async (req): Promise<JobImportsResponse> => ({
      imports: (await listImportRecords(projectPath(), req.params.id)).map(summaryOf),
    }),
  );
}
