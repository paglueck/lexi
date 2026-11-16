// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time token comparison.
 *
 * The early length check does leak the token's length, which is not a finding:
 * it is a fixed 43-character base64url string, so the length is public by
 * construction. What must not leak is where two same-length tokens diverge.
 */
export function tokenEquals(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
