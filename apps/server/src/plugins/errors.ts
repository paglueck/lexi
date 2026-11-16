// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { StaleFileError } from '@lexi/xliff';
import type { ErrorCode, ErrorEnvelope } from '@lexi/shared';

import { HttpError } from '../lib/http-error.js';
import { PartialSaveError } from '../lib/save.js';
import type { ServerConfig } from '../config.js';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ErrorEnvelope = {
    error: details === undefined ? { code, message } : { code, message, details },
  };
  return reply.status(status).send(body);
}

/**
 * The single place an exception becomes a response.
 *
 * Note the 500 branch: the real message is logged, never sent. A stack trace in
 * a response body is how absolute local paths leak out of a tool that promises
 * nothing leaves the machine.
 */
export function registerErrors(app: FastifyInstance, _cfg: ServerConfig): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Read these before the instanceof chain: narrowing by exclusion leaves the
    // parameter as `unknown` further down.
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const message = err.message;

    if (err instanceof HttpError) {
      return sendError(reply, err.status, err.code, err.message, err.details);
    }
    if (err instanceof ZodError) {
      return sendError(reply, 400, 'bad_request', 'Request did not match the schema', err.issues);
    }
    if (err instanceof StaleFileError) {
      return sendError(reply, 409, 'stale_file', err.message);
    }
    // A stale file is refused before a save writes anything, so one here lost
    // a race after that check; say so as the 409 it is, with what was written.
    if (err instanceof PartialSaveError && err.cause instanceof StaleFileError) {
      return sendError(reply, 409, 'stale_file', err.message, { written: err.written });
    }
    // Fastify's own validation and payload errors arrive with a statusCode.
    if (statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, 'bad_request', message);
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, 500, 'internal', 'Internal server error');
  });
}
