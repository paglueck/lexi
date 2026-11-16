// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * True while an event's target is a text-editing surface — the segment
 * editor's `contenteditable` region, its `mode="text"` textarea, or an
 * ordinary `<input>`.
 *
 * Extracted from the grid page's Focus-mode guard (M12) once a second
 * consumer — the app-level `⌘K`/`⌘,` handler — needed the same check. Bare
 * single-letter shortcuts (Focus mode's `a`/`r`/`s`) must be gated by this or
 * they hijack ordinary typing; modifier-chord shortcuts should NOT be gated
 * by it, since those are expected to work while editing text.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT';
}
