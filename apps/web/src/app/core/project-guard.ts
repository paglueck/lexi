// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';

import { ProjectStore } from './stores/project-store.js';

/**
 * Keep the working screens out of reach until a project is open.
 *
 * Without this the grid and dashboard render their empty frames and look
 * broken, when what the user actually needs is the start screen. `/settings`
 * and `/dev/*` stay ungated on purpose: settings is reachable before a project
 * exists, and the kitchen sink is the design review's entry point into any
 * build.
 */
export const projectGuard: CanActivateFn = async () => {
  const store = inject(ProjectStore);
  const router = inject(Router);

  // One probe per session: the store caches, so tab switching costs nothing.
  if (!store.loaded()) await store.refresh();

  return store.isOpen() ? true : router.createUrlTree(['/start']);
};

/**
 * The reverse, for `/` and `/start`: someone with a project already open should
 * land in it rather than being asked to open one again.
 */
export const startGuard: CanActivateFn = async () => {
  const store = inject(ProjectStore);
  const router = inject(Router);

  if (!store.loaded()) await store.refresh();

  return store.isOpen() ? router.createUrlTree(['/dashboard']) : true;
};
