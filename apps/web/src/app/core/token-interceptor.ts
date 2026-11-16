// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { HttpInterceptorFn } from '@angular/common/http';

import { LEXI_TOKEN_HEADER, readLexiToken } from './lexi-token.js';

/**
 * Attaches the boot token to every same-origin /api request.
 *
 * EventSource cannot set headers, so the SSE stream passes the token as a query
 * parameter instead — see SseProbePage.
 */
export const lexiTokenInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  return next(req.clone({ setHeaders: { [LEXI_TOKEN_HEADER]: readLexiToken() } }));
};
