// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  EditRateLocaleStats,
  Health,
  LocaleSummary,
  Project,
  ScannedFile,
} from '@lexi/shared';

import { ProjectApi } from '../api/project-api.js';

/**
 * The open project, as the whole app sees it.
 *
 * Fed from `GET /api/project` since M4. `applyHealth` remains only because the
 * shell probes health at boot and needs to clear a stale project when the
 * server restarted without one.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStore {
  readonly #api = inject(ProjectApi);

  readonly #project = signal<Project | null>(null);
  readonly #version = signal<string>('');
  /** Distinguishes "not loaded yet" from "loaded, and there is none". */
  readonly #loaded = signal(false);

  readonly project = this.#project.asReadonly();
  readonly version = this.#version.asReadonly();
  readonly loaded = this.#loaded.asReadonly();

  readonly name = computed<string | null>(() => this.#project()?.name ?? null);
  readonly sourceLocale = computed<string | null>(() => this.#project()?.sourceLocale ?? null);
  readonly isOpen = computed(() => this.#project() !== null);
  readonly files = computed<readonly ScannedFile[]>(() => this.#project()?.files ?? []);
  readonly locales = computed<readonly LocaleSummary[]>(() => this.#project()?.locales ?? []);

  /** The source locale is not a target; the dashboard and grid count the rest. */
  readonly targetLocales = computed<readonly LocaleSummary[]>(() => {
    const source = this.sourceLocale();
    return this.locales().filter((l) => l.locale !== source);
  });

  readonly unitCount = computed(() =>
    this.locales().reduce((total, l) => Math.max(total, l.unitCount), 0),
  );

  /** FR-7.4's edit rate, one entry per target locale. */
  readonly editRate = computed<readonly EditRateLocaleStats[]>(
    () => this.#project()?.editRate ?? [],
  );

  applyHealth(health: Health): void {
    this.#version.set(health.version);
    if (!health.projectOpen) {
      this.#project.set(null);
      this.#loaded.set(true);
    }
  }

  set(project: Project): void {
    this.#project.set(project);
    this.#loaded.set(true);
  }

  /**
   * Forget the open project without asking the server.
   *
   * `loaded` stays true: the store HAS an answer — "nothing is open" — and
   * resetting it would send the next guard back for a probe whose result is
   * already known, which on the way to /start means a redirect loop's worth of
   * round trips.
   */
  clear(): void {
    this.#project.set(null);
    this.#loaded.set(true);
  }

  /**
   * Load the open project, if there is one. A 404 is the normal answer before
   * anything has been opened, so it resolves to null rather than throwing.
   */
  async refresh(): Promise<Project | null> {
    try {
      const project = await this.#api.current();
      this.#project.set(project);
      return project;
    } catch {
      this.#project.set(null);
      return null;
    } finally {
      this.#loaded.set(true);
    }
  }

  /**
   * Start a locale that has no file in this group yet (FR-1.9).
   *
   * The server answers with the project as it now is, so nothing has to be
   * re-fetched — the new file is in `files()` and the locale in `locales()` by
   * the time this resolves.
   */
  async createLocaleFile(group: string, locale: string): Promise<string | null> {
    try {
      const result = await this.#api.createLocaleFile(group, locale);
      this.#project.set(result.project);
      return result.created;
    } catch {
      return null;
    }
  }

  /** Dev fixtures (?fixtures=1), so the chrome can be reviewed populated. */
  seedFixture(name: string, sourceLocale: string): void {
    this.#project.set({
      path: `~/dev/${name}`,
      name,
      sourceLocale,
      files: [],
      locales: [],
      groups: [],
      unitCount: 0,
      customIdShare: 0,
      health: {
        units: 0,
        unitsWithNote: 0,
        noteCoverage: 0,
        customIdUnits: 0,
        customIdShare: 0,
        errorCells: 0,
        warningCells: 0,
        staleUnits: 0,
        issues: [],
      },
      editRate: [],
      visibleLocales: [],
      filters: [],
      openedAt: new Date().toISOString(),
      writeState: 'auto',
      escapePolicy: 'angular',
      severities: {},
    });
    this.#loaded.set(true);
  }
}
