// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { UnitState } from '@lexi/shared';

/**
 * The handoff's Unicode marks, for what STATES rather than what ACTS: state
 * badges, severity marks, the ⌘/↩ key hints. The design ships no images, icon
 * fonts or SVG, and inside a badge a glyph works — the sr-only label beside it
 * carries the meaning.
 *
 * Buttons moved to SVG in M13 (`icon.ts`), as the handoff allows "if the target
 * codebase has an icon set": a lone `×` or `⚙` on a control renders at the
 * fallback font's whim, and U+2699 (the gear) can render as a colour emoji.
 */
export const GLYPH = {
  state: {
    untranslated: '—',
    draftMachine: 'AI',
    needsReview: 'R',
    reviewed: '✓',
    final: '✓✓',
  } satisfies Record<UnitState, string>,
  error: '!',
  info: 'i',
  retry: '↻',
  caretDown: '▾',
  caretRight: '▸',
  close: '×',
  cmd: '⌘',
  enter: '↩',
} as const;

/**
 * The accessible name behind every state badge (FR-3.7: never colour alone).
 *
 * These are the only user-visible strings in TypeScript in the whole kit. If
 * the app's own UI is ever localised, they move into a template `@switch`.
 */
export const STATE_LABEL = {
  untranslated: 'Untranslated',
  draftMachine: 'Machine draft',
  needsReview: 'Needs review',
  reviewed: 'Reviewed',
  final: 'Final',
} satisfies Record<UnitState, string>;
