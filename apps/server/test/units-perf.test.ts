// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project, UnitRowsResponse, UnitsQueryResponse } from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';
// Typed by scripts/make-large-corpus.d.mts since M13: an untyped import is an
// unsafe call to type-checked lint, which is no longer ceremony to satisfy.
import { generateLargeCorpus } from '../../../scripts/make-large-corpus.mjs';

/**
 * NFR-3, asserted rather than hoped for.
 *
 * The plan has carried "performance assertions — not yet asserted" since M3 for
 * one reason: there was no project big enough to measure against. There is now,
 * and it is generated rather than committed, so CI runs this without 114 MB of
 * synthetic XML living in the repository.
 *
 * The budgets are the requirements' (NFR-3), with the margin stated: these run on developer
 * laptops and in CI containers of varying generosity, so each assertion is set
 * at the documented budget and the measured value is printed. A number that
 * creeps toward its ceiling should be visible before it breaks the build.
 */

const UNITS = 20_000;
const LOCALES = 10;

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;
let openMs = 0;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-perf-')));
  root = join(base, 'big');
  stateDir = join(base, 'state');
  await generateLargeCorpus({ units: UNITS, outDir: root, quiet: true });

  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });

  const started = performance.now();
  const scan = await app.inject({
    method: 'POST',
    url: '/api/projects/scan',
    headers: goodHeaders(),
    payload: { path: root },
  });
  const files = scan.json<{
    files: Array<{ path: string; fileIndex: number; locale: string | null }>;
  }>().files;
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: 'en-GB',
      mapping: files
        .filter((f) => f.locale !== null)
        .map((f) => ({
          path: f.path,
          fileIndex: f.fileIndex,
          locale: f.locale,
          fixTargetLanguage: false,
        })),
    },
  });
  openMs = performance.now() - started;
  expect(res.statusCode).toBe(200);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('NFR-3 at 20,000 units x 10 locales', () => {
  it('opens the whole project — scan, parse, index and validate — in under 10 s', () => {
    const project = projects.current;
    const index = projects.index;
    expect(project).not.toBeNull();
    expect(index).not.toBeNull();

    console.log(
      `open ${Math.round(openMs)}ms · index ${index?.stats.buildMs}ms ` +
        `(validate ${index?.stats.validateMs}ms) · ${index?.stats.rows} rows · ` +
        `${index?.stats.cells} cells · ${index?.stats.customIdShare}% custom ids`,
    );

    expect(index?.stats.rows).toBe(UNITS);
    expect(index?.locales).toHaveLength(LOCALES);
    expect(openMs).toBeLessThan(10_000);
  });

  it('answers an unfiltered query in well under the 200 ms search budget', async () => {
    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: {},
    });
    const ms = performance.now() - started;
    expect(res.statusCode).toBe(200);

    const body = res.json<UnitsQueryResponse>();
    expect(body.total).toBe(UNITS);
    expect(body.ids).toHaveLength(UNITS);

    console.log(`query (all ${UNITS}) ${Math.round(ms)}ms`);
    // The server's share of FR-3.5's budget is ~30 ms; 200 is the whole budget,
    // so a query alone exceeding it leaves nothing for transfer and render.
    expect(ms).toBeLessThan(200);
  });

  it('answers a full-text search across every haystack inside the budget', async () => {
    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: { search: 'invoice', scope: 'all' },
    });
    const ms = performance.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.json<UnitsQueryResponse>().total).toBeGreaterThan(0);

    console.log(`search "invoice" over id+source+notes+10 targets ${Math.round(ms)}ms`);
    expect(ms).toBeLessThan(200);
  });

  it('segments a 200-row window fast enough to keep a fling fed', async () => {
    const all = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: {},
    });
    const ids = all.json<UnitsQueryResponse>().ids.slice(5_000, 5_200);

    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/rows',
      headers: goodHeaders(),
      payload: { ids, locales: [] },
    });
    const ms = performance.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.json<UnitRowsResponse>().rows).toHaveLength(200);

    console.log(`rows (200 x visible locales, segmented) ${Math.round(ms)}ms`);
    // A window has to land well inside a scroll gesture, not merely eventually.
    expect(ms).toBeLessThan(150);
  });

  it('reports the six FR-2.2 counters for every locale without re-walking', async () => {
    const started = performance.now();
    const res = await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() });
    const ms = performance.now() - started;

    const project = res.json<Project>();
    expect(project.locales).toHaveLength(LOCALES);
    expect(project.unitCount).toBe(UNITS);
    for (const locale of project.locales) {
      expect(locale.translated + locale.needsReview + locale.untranslated).toBe(locale.unitCount);
    }

    console.log(`GET /api/project (all six counters x ${LOCALES} locales) ${Math.round(ms)}ms`);
    expect(ms).toBeLessThan(1_000);
  });
});
