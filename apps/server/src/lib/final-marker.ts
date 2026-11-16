// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { splitRowId, rowIdOf } from '@lexi/shared';

import { readLexiJson, writeLexiJson } from './lexi-dir.js';
import { originKey } from './machine-origin.js';
import type { ServerConfig } from '../config.js';

/**
 * `.lexi/final.json` — which targets were imported as `final` into a file that
 * carries no `state` attributes.
 *
 * A project with `writeState` off has nowhere in the XLIFF to say "final", so
 * without this an imported `final` would read back as `reviewed` the moment the
 * file is reloaded. It is a file of its own, not a record kind inside
 * `state.json`: `originsOf` accepts any `{hash, at}` record, so a final marker
 * stored there would read back as a machine draft.
 *
 * Like `state.json` it is committed and nested by group (a unit id is only
 * unique within a file group), and like it the marker is hash-guarded: it is
 * believed only while the target still holds the bytes the import wrote, so
 * any later edit, in Lexi or in an editor, retires it without bookkeeping.
 */
export interface FinalMarker {
  /** sha256 of the target's inner XML as the import wrote it. */
  readonly hash: string;
  readonly at: string;
  /** The import that set it, so a marker can be traced to its CSV. */
  readonly importId: string;
}

/** Keyed with `originKey`: every lookup is by (row, locale). */
export type FinalMarkers = Map<string, FinalMarker>;

interface FinalFile {
  readonly version: 1;
  readonly groups: Record<string, Record<string, Record<string, FinalMarker>>>;
}

const FILE = 'final.json';

const isMarker = (value: unknown): value is FinalMarker =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as FinalMarker).hash === 'string' &&
  typeof (value as FinalMarker).at === 'string' &&
  typeof (value as FinalMarker).importId === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse the file into the flat lookup. Anything unreadable yields no markers.
 *
 * Every level is guarded, because the file is committed and hand-editable and
 * this runs inside project open: a damaged branch is skipped, its siblings kept,
 * and the project still opens.
 */
export function finalMarkersOf(raw: unknown): FinalMarkers {
  const out: FinalMarkers = new Map();
  if (!isRecord(raw) || !isRecord(raw.groups)) return out;

  for (const [group, units] of Object.entries(raw.groups)) {
    if (!isRecord(units)) continue;
    for (const [unitId, locales] of Object.entries(units)) {
      if (!isRecord(locales)) continue;
      for (const [locale, record] of Object.entries(locales)) {
        if (isMarker(record)) out.set(originKey(rowIdOf(group, unitId), locale), record);
      }
    }
  }
  return out;
}

/** The flat lookup back into the committed, group-nested shape. */
export function toFinalFile(markers: FinalMarkers): FinalFile {
  const groups: FinalFile['groups'] = {};
  for (const [key, record] of markers) {
    const [rowId = '', locale = ''] = key.split('\0');
    const { group, unitId } = splitRowId(rowId);
    const units = (groups[group] ??= {});
    const locales = (units[unitId] ??= {});
    locales[locale] = record;
  }
  return { version: 1, groups };
}

export const readFinalMarkers = async (projectPath: string): Promise<FinalMarkers> =>
  finalMarkersOf(await readLexiJson<unknown>(projectPath, FILE));

export const writeFinalMarkers = (
  cfg: ServerConfig,
  projectPath: string,
  markers: FinalMarkers,
): Promise<void> => writeLexiJson(cfg, projectPath, FILE, toFinalFile(markers));
