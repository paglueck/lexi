// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';

import {
  ESCAPE_POLICIES,
  RULE_IDS,
  SEVERITIES,
  UNIT_STATES,
  WRITE_STATE_MODES,
} from './constants.js';

/**
 * Schemas over the mirrored vocabularies in `./constants.ts`.
 *
 * The vocabularies are deliberately *copies* of the engine's, not re-exports:
 * `@lexi/xliff`'s barrel reaches `node:crypto` (scan.ts) and `node:fs/promises`
 * (save.ts), so a single value import from the browser bundle would break the
 * Angular build. A rule of "shared imports nothing but zod" cannot be violated
 * by accident; a rule of "always write `import type`" can.
 *
 * `test/xliff-compat.test.ts` asserts the copies stay identical to the engine's.
 */
export const UnitStateSchema = z.enum(UNIT_STATES);
export const WriteStateModeSchema = z.enum(WRITE_STATE_MODES);
export const EscapePolicySchema = z.enum(ESCAPE_POLICIES);
export const RuleIdSchema = z.enum(RULE_IDS);
export const SeveritySchema = z.enum(SEVERITIES);

/**
 * Mirrors `Finding`. Note the narrowing: a *reported* finding is never `off`,
 * even though a rule's configured severity can be.
 */
export const FindingSchema = z.object({
  rule: RuleIdSchema,
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  /** Mirrors `FindingPlaceholders`: only on the two placeholder rules. */
  placeholders: z
    .object({ missing: z.array(z.string()).readonly(), unexpected: z.array(z.string()).readonly() })
    .optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
