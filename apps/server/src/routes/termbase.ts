// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import {
  TERMBASE_FILE,
  TermCreateRequestSchema,
  TermImportRequestSchema,
  TermPatchRequestSchema,
  applyImport,
  type Term,
  type TermBaseResponse,
  type TermImportResponse,
} from '@lexi/shared';

import { notFound } from '../lib/http-error.js';
import { LEXI_DIR } from '../lib/lexi-dir.js';
import { readSharedSources, sourceState, termBaseFileOf } from '../lib/shared-sources.js';
import { loadTermBase, newTerm, saveTermBase } from '../services/termbase.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';

/**
 * The Term Base tab (FR-5.8), formerly S6's glossary pane.
 *
 * The file is the state: every call reads `.lexi/termbase.csv` (or the linked
 * shared one, `lib/shared-sources.ts`) and every write replaces it, so a user who edits the file by hand sees their change on the
 * next request rather than after a restart.
 *
 * There IS an in-memory copy — the row model validates every cell
 * synchronously and cannot await the file — so each route hands what it read
 * or wrote to `projects.setGlossary`, which rebuilds the index only when the
 * terms actually differ. That keeps the one invalidation path in one place.
 */
export function registerTermBase(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
): void {
  const open = () => {
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    return project;
  };

  /** Keep the validator's copy in step with the file, rebuilding only on a real change. */
  const sync = (terms: readonly Term[]): void => {
    const current = projects.current?.glossary ?? [];
    if (JSON.stringify(current) !== JSON.stringify(terms)) projects.setGlossary(terms);
  };

  const save = async (path: string, terms: readonly Term[]): Promise<void> => {
    await saveTermBase(cfg, path, terms, projects.targetLocales());
    sync(terms);
  };

  /**
   * The path label is project-relative for `.lexi/termbase.csv` and absolute
   * for a linked file, which is outside the project by design.
   */
  const respond = async (path: string, terms: readonly Term[]): Promise<TermBaseResponse> => {
    const { termbase } = await readSharedSources(path);
    return {
      terms: [...terms],
      total: terms.length,
      path: termbase === null ? `${LEXI_DIR}/${TERMBASE_FILE}` : await termBaseFileOf(path),
      linked: termbase !== null,
      available: (await sourceState(termbase)).available,
    };
  };

  app.get('/api/termbase', async (): Promise<TermBaseResponse> => {
    const project = open();
    const terms = await loadTermBase(cfg, project.path);
    sync(terms);
    return respond(project.path, terms);
  });

  /** "Add term" inserts at the top, usually untitled — the editor names it next. */
  app.post('/api/termbase', async (req): Promise<Term> => {
    const project = open();
    const body = TermCreateRequestSchema.parse(req.body ?? {});
    const terms = await loadTermBase(cfg, project.path);
    const given = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    ) as Partial<Term>;
    const created = newTerm(given);
    await save(project.path, [created, ...terms]);
    return created;
  });

  app.patch('/api/termbase/:id', async (req): Promise<Term> => {
    const project = open();
    const { id } = req.params as { id: string };
    const body = TermPatchRequestSchema.parse(req.body ?? {});

    const terms = await loadTermBase(cfg, project.path);
    const at = terms.findIndex((t) => t.id === id);
    if (at === -1) throw notFound(`no term with id "${id}"`);

    // Only the keys the request actually carried. Spreading `body` directly
    // would merge in the ones zod left as `undefined`, which is how a PATCH of
    // `{dnt:true}` erases a note nobody mentioned.
    const given = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const updated: Term = { ...(terms[at] as Term), ...given };
    terms[at] = updated;
    await save(project.path, terms);
    return updated;
  });

  app.delete('/api/termbase/:id', async (req): Promise<TermBaseResponse> => {
    const project = open();
    const { id } = req.params as { id: string };
    const terms = await loadTermBase(cfg, project.path);
    const remaining = terms.filter((t) => t.id !== id);
    if (remaining.length !== terms.length) await save(project.path, remaining);
    return respond(project.path, remaining);
  });

  /**
   * CSV import. The client parsed and previewed the file; the merge itself is
   * re-run here, on the file as it is now, with the same `applyImport` the
   * preview used — so an edit made while the dialog was open is not lost.
   */
  app.post('/api/termbase/import', async (req): Promise<TermImportResponse> => {
    const project = open();
    const body = TermImportRequestSchema.parse(req.body ?? {});
    const projectLocales = projects.targetLocales();
    const locales = projectLocales.filter((c) => body.locales?.includes(c) ?? true);
    const rows = body.rows.map((r) => ({
      ...r,
      translations: Object.fromEntries(
        Object.entries(r.translations).filter(([c]) => locales.includes(c)),
      ),
    }));
    const terms = await loadTermBase(cfg, project.path);
    const result = applyImport(terms, rows, locales, body.mode, randomUUID);
    if (result.added + result.updated > 0) await save(project.path, result.terms);
    return {
      ...(await respond(project.path, result.terms)),
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
    };
  });
}
