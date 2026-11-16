// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Routes } from '@angular/router';

import { projectGuard, startGuard } from './core/project-guard.js';

/**
 * `data.chrome` drives the three title-bar variants: the full tab strip, the
 * wizard's step indicator, or the minimal bar on the start screen.
 *
 * `projectGuard` keeps the working screens out of reach until something is
 * open, and `startGuard` does the reverse so a user with a project already open
 * is not asked to open one again. /settings, /phrase/checkout and
 * /dev/kitchen-sink are ungated.
 *
 * /dev/kitchen-sink stays in production builds on purpose: this is a localhost
 * tool, and a design reviewer should be able to open it against any build. It
 * is lazy, so the cost is one extra chunk.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'start' },
  {
    path: 'dashboard',
    canActivate: [projectGuard],
    title: 'Dashboard · Lexi',
    loadComponent: () =>
      import('./features/dashboard/dashboard-page.js').then((m) => m.DashboardPage),
  },
  {
    path: 'grid',
    canActivate: [projectGuard],
    title: 'Grid · Lexi',
    loadComponent: () => import('./features/grid/grid-page.js').then((m) => m.GridPage),
  },
  {
    path: 'review',
    canActivate: [projectGuard],
    title: 'Review · Lexi',
    loadComponent: () => import('./features/review/review-page.js').then((m) => m.ReviewPage),
  },
  {
    path: 'styleguides',
    canActivate: [projectGuard],
    title: 'Style guides · Lexi',
    loadComponent: () =>
      import('./features/styleguides/styleguides-page.js').then((m) => m.StyleguidesPage),
  },
  {
    path: 'termbase',
    canActivate: [projectGuard],
    title: 'Term Base · Lexi',
    loadComponent: () => import('./features/termbase/termbase-page.js').then((m) => m.TermBasePage),
  },
  {
    path: 'issues',
    canActivate: [projectGuard],
    title: 'Issues · Lexi',
    loadComponent: () => import('./features/issues/issues-page.js').then((m) => m.IssuesPage),
  },
  {
    path: 'jobs',
    canActivate: [projectGuard],
    title: 'Jobs · Lexi',
    loadComponent: () => import('./features/jobs/jobs-page.js').then((m) => m.JobsPage),
  },
  {
    path: 'jobs/:id/import',
    canActivate: [projectGuard],
    title: 'Import CSV · Lexi',
    loadComponent: () =>
      import('./features/csv-import/csv-import-page.js').then((m) => m.CsvImportPage),
  },
  {
    path: 'import',
    canActivate: [projectGuard],
    title: 'Import CSV · Lexi',
    loadComponent: () =>
      import('./features/csv-import/csv-import-page.js').then((m) => m.CsvImportPage),
  },
  {
    path: 'settings',
    title: 'Settings · Lexi',
    loadComponent: () => import('./features/settings/settings-page.js').then((m) => m.SettingsPage),
  },
  {
    path: 'start',
    canActivate: [startGuard],
    title: 'Lexi',
    data: { chrome: 'minimal' },
    loadComponent: () => import('./features/start/start-page.js').then((m) => m.StartPage),
  },
  {
    // S18. Ungated: a checkout needs no open project, and one may be open.
    path: 'phrase/checkout',
    title: 'Check out from Phrase · Lexi',
    data: { chrome: 'minimal', chromeLabel: 'Check out from Phrase' },
    loadComponent: () =>
      import('./features/phrase-checkout/checkout-page.js').then((m) => m.CheckoutPage),
  },
  {
    path: 'setup',
    title: 'New project · Lexi',
    data: { chrome: 'wizard' },
    loadComponent: () => import('./features/setup/setup-page.js').then((m) => m.SetupPage),
  },
  {
    path: 'dev/kitchen-sink',
    title: 'Kitchen sink · Lexi',
    loadComponent: () =>
      import('./dev/kitchen-sink/kitchen-sink-page.js').then((m) => m.KitchenSinkPage),
  },
  { path: '**', redirectTo: '' },
];
