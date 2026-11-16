// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ErrorCode } from '@lexi/shared';

/** An error that carries the status and error code it should be reported as. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string, d?: unknown): HttpError =>
  new HttpError(400, 'bad_request', m, d);
export const forbidden = (m: string): HttpError => new HttpError(403, 'forbidden', m);
export const notFound = (m: string): HttpError => new HttpError(404, 'not_found', m);
export const conflict = (m: string): HttpError => new HttpError(409, 'conflict', m);
/** A remote service lexi called for the user failed; the message says how. */
export const upstream = (m: string): HttpError => new HttpError(502, 'upstream', m);
