// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { splitRowId, rowIdOf } from '@lexi/shared';

import { readLexiJson, writeLexiJson } from './lexi-dir.js';
import type { ServerConfig } from '../config.js';

/**
 * `.lexi/review-notes.json` — why a reviewer rejected a draft (S11, M14).
 *
 * S11's reject-reason chips are described as "stored with the unit and fed back
 * into the re-draft prompt", which is two different lifetimes in one sentence:
 * the prompt wants them for the next few seconds, the next person wants them
 * next week. Only the second needs a file, so this is that file and nothing
 * more — the re-draft path reads the chips straight off the screen.
 *
 * COMMITTED, like `state.json` and unlike `review-stats.json`. A reason is a
 * note to a colleague ("we do not say Kostenloser Versand here"), and it merges
 * cleanly for the same structural reason: the shape is a map nested by group,
 * unit and locale, so two branches rejecting two different units never touch
 * the same line. `review-stats.json` is a scalar counter and therefore is not.
 *
 * There is DELIBERATELY no hash gate here, which is the one place this file
 * differs from `machine-origin.ts`. A machine-origin marker makes a claim about
 * the bytes currently in the file, so it has to expire when they change. A
 * rejection reason makes a claim about a draft that no longer exists at all —
 * it is history, and history does not expire. It is cleared when a reviewer
 * accepts something for that cell, because that is the moment the complaint
 * stops being true.
 */

interface ReviewNotesFile {
  readonly version: 1;
  readonly groups: Record<string, Record<string, Record<string, readonly string[]>>>;
}

const FILE = 'review-notes.json';

/** The in-memory key, flat: every lookup is by (row, locale). Same as `originKey`. */
export const noteKey = (rowId: string, locale: string): string => `${rowId} ${locale}`;

export type ReviewNotes = Map<string, readonly string[]>;

const isReasons = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Parse the file into the flat lookup. Anything unreadable yields no notes. */
export function reviewNotesOf(raw: unknown): ReviewNotes {
  const out: ReviewNotes = new Map();
  const file = raw as Partial<ReviewNotesFile> | null;
  if (file === null || typeof file !== 'object' || typeof file.groups !== 'object') return out;

  for (const [group, units] of Object.entries(file.groups ?? {})) {
    for (const [unitId, locales] of Object.entries(units)) {
      for (const [locale, reasons] of Object.entries(locales)) {
        // An empty array is the same fact as no entry at all, and keeping it
        // would let the file grow a row for every reason ever cleared.
        if (isReasons(reasons) && reasons.length > 0) {
          out.set(noteKey(rowIdOf(group, unitId), locale), [...reasons]);
        }
      }
    }
  }
  return out;
}

/** The flat lookup back into the committed, group-nested shape. */
export function toReviewNotesFile(notes: ReviewNotes): ReviewNotesFile {
  const groups: ReviewNotesFile['groups'] = {};
  for (const [key, reasons] of notes) {
    if (reasons.length === 0) continue;
    const [rowId = '', locale = ''] = key.split(' ');
    const { group, unitId } = splitRowId(rowId);
    const units = (groups[group] ??= {});
    const locales = (units[unitId] ??= {});
    locales[locale] = [...reasons];
  }
  return { version: 1, groups };
}

export const readReviewNotes = async (projectPath: string): Promise<ReviewNotes> =>
  reviewNotesOf(await readLexiJson<unknown>(projectPath, FILE));

export const writeReviewNotes = (
  cfg: ServerConfig,
  projectPath: string,
  notes: ReviewNotes,
): Promise<void> => writeLexiJson(cfg, projectPath, FILE, toReviewNotesFile(notes));
