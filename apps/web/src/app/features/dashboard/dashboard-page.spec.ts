// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocaleSummary, Project, ProjectHealth } from '@lexi/shared';

import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SaveStore } from '../../core/stores/save-store.js';
import { DashboardPage } from './dashboard-page.js';

/**
 * S3's job is G2 — "what is missing in locale X" in under five seconds — and
 * the things that can quietly break it are not visual.
 *
 * What is asserted here: that the coverage bar's four segments come from four
 * different counters (the split that M7 made in `LocaleSummary`, and the one a
 * later refactor is most likely to re-merge), that the rail is built from real
 * findings rather than from the mock's prose, and that the quick action sets up
 * the grid to answer the question the button just asked. What is left to the
 * eye: geometry and colour.
 */

const health = (over: Partial<ProjectHealth> = {}): ProjectHealth => ({
  units: 4000,
  unitsWithNote: 2600,
  noteCoverage: 65,
  customIdUnits: 720,
  customIdShare: 18,
  errorCells: 9,
  warningCells: 30,
  staleUnits: 0,
  issues: [],
  ...over,
});

const locale = (over: Partial<LocaleSummary> = {}): LocaleSummary => ({
  locale: 'de',
  isRtl: false,
  fileCount: 1,
  unitCount: 100,
  translated: 60,
  untranslated: 20,
  draftMachine: 12,
  needsReview: 8,
  missing: 5,
  orphans: 3,
  ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  path: '/Users/x/northwind',
  name: 'northwind',
  sourceLocale: 'en-GB',
  files: [],
  locales: [locale()],
  unitCount: 4000,
  customIdShare: 18,
  health: health(),
  editRate: [],
  visibleLocales: ['de'],
  filters: [],
  groups: ['messages'],
  openedAt: new Date().toISOString(),
  writeState: 'auto',
  escapePolicy: 'angular',
  severities: {},
  ...over,
});

const mount = (dto: Project = project()) => {
  TestBed.inject(ProjectStore).set(dto);
  const fixture = TestBed.createComponent(DashboardPage);
  fixture.detectChanges();
  return fixture;
};

const text = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      // A real route, so the quick action's navigation resolves instead of
      // rejecting in the background and poisoning an unrelated test.
      provideRouter([
        { path: 'grid', children: [] },
        { path: 'review', children: [] },
      ]),
    ],
  });
});

describe('DashboardPage', () => {
  it('draws the coverage bar from four separate counters, not two', () => {
    // The whole reason `draftMachine` was split out of `needsReview`: a bar
    // that lumps them shows the same picture whether the machine has been run
    // or not, which is the one thing the MVP exists to measure.
    const el = mount().nativeElement as HTMLElement;
    const segments = el.querySelectorAll('lx-stacked-bar .seg');

    expect(segments).toHaveLength(3);
    expect((segments[0] as HTMLElement).style.width).toBe('60%');
    expect((segments[1] as HTMLElement).style.width).toBe('12%');
    expect((segments[2] as HTMLElement).style.width).toBe('8%');
    // The untranslated remainder is the track, so it has no segment of its own.
    expect(el.querySelector('lx-stacked-bar')?.getAttribute('aria-label')).toContain(
      '60% Reviewed & final',
    );
  });

  it('states every figure in words as well as colour', () => {
    const el = mount().nativeElement as HTMLElement;
    const strip = text(el.querySelector('.stats') as HTMLElement);

    // `textContent` runs the caption straight into its value, so these read as
    // one word — the point is that the number is spelled out beside a label,
    // not carried by the colour alone.
    expect(strip).toContain('Note coverage65%');
    expect(strip).toContain('2,600 of 4,000');
    expect(strip).toContain('Custom ids18%');
    expect(strip).toContain('Open issues9');
  });

  it('colours the two health metrics by how bad they are, not by their presence', () => {
    const at = (dto: Project, selector: string) =>
      (mount(dto).nativeElement as HTMLElement).querySelector(selector)?.getAttribute('data-tone');

    const note = '.stats .stat:nth-child(3) .stat__value';
    expect(at(project({ health: health({ noteCoverage: 92 }) }), note)).toBeNull();
    expect(at(project({ health: health({ noteCoverage: 65 }) }), note)).toBe('warn');
    expect(at(project({ health: health({ noteCoverage: 22 }) }), note)).toBe('danger');
  });

  it('builds the rail from real findings, naming the rule and the locale', () => {
    const el = mount(
      project({
        health: health({
          issues: [
            {
              rule: 'icu.pluralCoverage',
              severity: 'error',
              cells: 9,
              units: 9,
              locales: [
                { locale: 'pl', cells: 6 },
                { locale: 'ar', cells: 3 },
              ],
            },
            {
              rule: 'punctuation.terminal',
              severity: 'warning',
              cells: 400,
              units: 400,
              locales: [{ locale: 'de', cells: 400 }],
            },
          ],
        }),
      }),
    ).nativeElement as HTMLElement;

    const items = [...el.querySelectorAll('.issue')].map((i) => text(i as HTMLElement));
    expect(items[0]).toContain('Plural categories incomplete');
    expect(items[0]).toContain('pl on 6, ar on 3');
    expect(items[0]).toContain('9 units in total');

    // Warnings are not rail material: 400 missing full stops would bury the
    // nine strings that are actually broken.
    expect(items.join(' ')).not.toContain('Terminal punctuation');
  });

  it('points at the template, not at itself, for missing context (FR-4.3c)', () => {
    const el = mount(project({ health: health({ units: 4000, unitsWithNote: 2600 }) }))
      .nativeElement as HTMLElement;
    const rail = text(el.querySelector('.rail') as HTMLElement);

    expect(rail).toContain('1,400 units have no note');
    expect(rail).toContain('i18n attribute in the template');
  });

  it('says so plainly when there is nothing to do', () => {
    const el = mount(
      project({
        health: health({ units: 100, unitsWithNote: 100, errorCells: 0, issues: [] }),
      }),
    ).nativeElement as HTMLElement;

    expect(text(el.querySelector('.rail') as HTMLElement)).toContain('Nothing needs attention');
  });

  it('sets the grid up to answer the question the quick action asked', () => {
    const fixture = mount(
      project({ locales: [locale({ locale: 'de', untranslated: 140 })], visibleLocales: ['de'] }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector('.td--action button') as HTMLButtonElement;

    expect(text(button)).toBe('140 untranslated →');

    button.click();
    const grid = TestBed.inject(GridStore);
    // One column and one filter — anything left over from a previous visit
    // would make the grid's count disagree with the button that was pressed.
    expect(grid.visibleLocales()).toEqual(['de']);
    expect(grid.filters()).toEqual(['untranslated']);
    expect(grid.editLocale()).toBe('de');
  });

  it('offers no quick action for a locale that is finished', () => {
    const el = mount(
      project({ locales: [locale({ untranslated: 0, needsReview: 0, draftMachine: 0 })] }),
    ).nativeElement as HTMLElement;
    expect(el.querySelector('.td--action button')).toBeNull();
    expect(text(el.querySelector('.td--action') as HTMLElement)).toBe('complete');
  });

  it('offers a Review action once nothing is untranslated but something still needs a look', async () => {
    const el = mount(
      project({ locales: [locale({ untranslated: 0, needsReview: 3, draftMachine: 5 })] }),
    ).nativeElement as HTMLElement;
    const button = el.querySelector('.td--action button') as HTMLButtonElement;
    expect(text(button)).toBe('Review 8 →');

    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');
    button.click();
    // A link with a scope, not a mutation of the grid. M12 entered review by
    // rewriting the grid's visible columns and filters — and persisting both —
    // so opening it quietly changed the screen the user had left behind.
    expect(navigate).toHaveBeenCalledWith(['/review'], { queryParams: { locale: 'de' } });
    const grid = TestBed.inject(GridStore);
    expect(grid.filters()).toEqual([]);
  });

  it('reports the last save as files REWRITTEN, which is the FR-1.6 promise', () => {
    TestBed.inject(SaveStore).markSaved('2026-09-16T12:34:00Z');
    TestBed.inject(SaveStore).setWritten(4);
    const el = mount(
      project({
        files: Array.from({ length: 11 }, () => ({
          path: '/x.xlf',
          relPath: 'x.xlf',
          fileIndex: 0,
          group: 'messages',
          locale: 'de',
          localeSource: 'filename' as const,
          conflictingTargetLanguage: null,
          sourceLanguage: 'en-GB',
          targetLanguage: 'de',
          unitCount: 1,
          isTemplate: false,
          isRtl: false,
        })),
      }),
    ).nativeElement as HTMLElement;

    const footer = text(el.querySelector('.last-save') as HTMLElement);
    expect(footer).toContain('4 of 11 files rewritten');
    expect(footer).toContain('Unchanged files were left untouched.');
  });
});
