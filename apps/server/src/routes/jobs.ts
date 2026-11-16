// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  JobCreateRequestSchema,
  ReportQuerySchema,
  type Job,
  type JobLogResponse,
  type JobsClearResponse,
} from '@lexi/shared';

import type { ServerConfig } from '../config.js';
import { badRequest } from '../lib/http-error.js';
import { writeExportSnapshot } from '../lib/export-snapshot.js';
import { zipStore } from '../lib/zip.js';
import type { JobQueue } from '../services/job-queue.js';
import { buildJobReport } from '../services/job-report.js';
import { renderJobReportCsv, snapshotOf } from '../services/job-report-csv.js';
import { renderJobReportHtml } from '../services/job-report-html.js';
import type { ProjectService } from '../services/project-service.js';

/**
 * S14 — the job queue (M11). Thin: every route reads or mutates `JobQueue`,
 * which owns the state machine, the worker pool and the log file. Nothing here
 * talks to the LLM or the project index directly.
 *
 * EVERY route hands its job through `withReview`, which is where
 * `pendingReview` is filled in (M15). The queue's own live records carry a
 * stale zero on purpose — the count is a question about the unit index, asked
 * at the moment somebody looks, not state the queue could keep current.
 */
export function registerJobs(
  app: FastifyInstance,
  cfg: ServerConfig,
  jobQueue: JobQueue,
  projects: ProjectService,
): void {
  app.post('/api/jobs', async (req): Promise<Job> => {
    const body = JobCreateRequestSchema.parse(req.body ?? {});
    return jobQueue.withReview(jobQueue.create(body));
  });

  app.get('/api/jobs', async (): Promise<Job[]> =>
    jobQueue.list().map((j) => jobQueue.withReview(j)),
  );

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req): Promise<Job> => {
    return jobQueue.withReview(jobQueue.get(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/pause', async (req): Promise<Job> => {
    return jobQueue.withReview(jobQueue.pause(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/resume', async (req): Promise<Job> => {
    return jobQueue.withReview(jobQueue.resume(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req): Promise<Job> => {
    return jobQueue.withReview(jobQueue.cancel(req.params.id));
  });

  app.post('/api/jobs/clear-finished', async (): Promise<JobsClearResponse> => ({
    removed: jobQueue.clearFinished(),
  }));

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    jobQueue.remove(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string; locale: string } }>(
    '/api/jobs/:id/locales/:locale/skip',
    async (req): Promise<Job> =>
      jobQueue.withReview(jobQueue.skipLocale(req.params.id, req.params.locale)),
  );

  app.post<{ Params: { id: string; locale: string } }>(
    '/api/jobs/:id/locales/:locale/unskip',
    async (req): Promise<Job> =>
      jobQueue.withReview(jobQueue.unskipLocale(req.params.id, req.params.locale)),
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/jobs/:id/log',
    async (req): Promise<JobLogResponse> => {
      // `-1` is "everything" — seq starts at 0, so a default of 0 would drop
      // the very first entry from a client that never supplied `after` at all.
      const after = req.query.after !== undefined ? Number(req.query.after) : -1;
      if (!Number.isInteger(after) || after < -1)
        throw badRequest('after must be a non-negative integer');
      return { entries: await jobQueue.log(req.params.id, after) };
    },
  );

  /**
   * The review report (one self-contained HTML file) a native speaker checks
   * the job's drafts against, or with `?format=csv` the translations alone for
   * a market reviewer to edit in Excel. Read from the job's files on disk, so
   * it still works for a job the queue forgot when the server restarted — as
   * long as its project is the open one.
   *
   * A CSV export also writes a snapshot of what it said to
   * `.lexi/exports/<id>.json`, and puts the id in its `Export` column: the
   * baseline the import compares a returned file against. `split=perLocale`
   * makes one CSV per locale in a ZIP, so each market gets only its own rows;
   * all of them share the one id, because they are one export.
   */
  app.get<{ Params: { id: string } }>('/api/jobs/:id/report', async (req, reply) => {
    const { format, delimiter, split } = ReportQuerySchema.parse(req.query ?? {});
    const report = await buildJobReport(
      { projects, projectPathOf: (id) => jobQueue.projectPathOf(id) },
      req.params.id,
    );
    const { job } = report.record;
    const day = (job.finishedAt ?? job.createdAt).slice(0, 10);
    const safe = (name: string): string => name.replace(/[^\w.-]/g, '_');
    // The CSV's first line is the column header the import reads back, so a
    // job's name goes into the file name instead of the file.
    const named = job.name === null ? '' : `${safe(job.name)}-`;
    const base = `lexi-review-${day}-${named}${job.id.slice(0, 8)}`;
    const attach = (name: string): string => `attachment; filename="${safe(name)}"`;

    if (format === 'html') {
      return reply
        .type('text/html; charset=utf-8')
        .header('content-disposition', attach(`${base}.html`))
        .send(renderJobReportHtml(report));
    }

    const exportId = randomUUID();
    // buildJobReport found the job's record there, so the path is known.
    const projectPath = jobQueue.projectPathOf(job.id) ?? projects.current?.path;
    if (projectPath !== undefined) {
      await writeExportSnapshot(
        cfg,
        projectPath,
        snapshotOf(report, exportId, new Date().toISOString()),
      );
    }

    const locales = [...new Set(report.units.map((u) => u.locale))];
    if (split === 'perLocale' && locales.length > 1) {
      const zip = zipStore(
        locales.map((locale) => ({
          name: safe(`${base}-${locale}.csv`),
          data: Buffer.from(renderJobReportCsv(report, delimiter, exportId, locale), 'utf8'),
        })),
      );
      return reply
        .type('application/zip')
        .header('content-disposition', attach(`${base}.zip`))
        .send(Buffer.from(zip));
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', attach(`${base}.csv`))
      .send(renderJobReportCsv(report, delimiter, exportId));
  });
}
