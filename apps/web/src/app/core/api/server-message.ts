// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The server's own sentence, dug out of the error envelope.
 *
 * Every failing endpoint answers with the same shape (`ErrorEnvelopeSchema`),
 * and on a settings-like screen the message IS the feature: "missing its
 * scheme" is what tells the user what to type, where "Http failure response
 * for /api/settings: 400" tells them to file a bug.
 *
 * Written three times before it was extracted — settings, the prompt preview,
 * and then M10 twice more — which is one time too many for a function whose
 * whole job is that every screen reports failure the same way.
 */
export function messageOf(error: unknown, fallback = 'The change could not be saved.'): string {
  const body = (error as { error?: unknown } | null)?.error;
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message !== '' ? message : fallback;
}
