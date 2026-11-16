// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { lexiTokenInterceptor } from './core/token-interceptor.js';
import { routes } from './app.routes.js';

/**
 * No provideZonelessChangeDetection(): zoneless is the default in Angular 21+,
 * and provideZoneChangeDetection() must never be added, since that would
 * override it.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([lexiTokenInterceptor])),
  ],
};
