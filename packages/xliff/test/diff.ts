// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { diffLines } from 'diff';

export interface LineDiff {
  readonly added: number;
  readonly removed: number;
}

/**
 * Count added and removed lines between two documents.
 *
 * A modification shows as one removed plus one added line, which is how git
 * reports it too — so "a one-word change produces a one-line diff" (NFR-8) is
 * `{ added: 1, removed: 1 }`, and a pure insertion is `{ added: n, removed: 0 }`.
 */
export function lineDiff(before: string, after: string): LineDiff {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? 0;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}
