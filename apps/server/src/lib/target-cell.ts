// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { basename, dirname, join } from 'node:path';
import type { LoadedDocument, TransUnit, XlfFile } from '@lexi/xliff';
import { stripLocaleToken } from '@lexi/xliff';
import type { ScannedFile } from '@lexi/shared';

import { badRequest, notFound } from './http-error.js';
import type { OpenProject } from '../services/project-service.js';
import type { IndexedRow, UnitIndex } from '../services/unit-index.js';

/**
 * Which file a target belongs in, and what has to exist before it can be written
 * there (FR-1.9).
 *
 * Until M9 this was one refusal — "this string is not present in the de file, so
 * it cannot be edited yet" — and that is exactly the string the drafting feature
 * exists to write. Without `ng-extract-i18n-merge` (which this project does not
 * use) a new English string lands only in `messages.xlf`; the
 * translation files are hand-maintained copies and simply do not have it. So
 * "translate this into Polish" routinely means "put it into the Polish file
 * first", and that is an ordinary edit, not a separate feature.
 *
 * The two cases are genuinely different, and only the first can be implicit:
 *
 *  - the file exists and the unit does not → **insert the unit**, as part of the
 *    same pending edit and the same save. Writing a translation into a file
 *    plainly means the unit has to be there; asking would be ceremony.
 *  - the locale has no file in this group at all → **refuse, and say what would
 *    fix it**. Creating a file in somebody's repository is a decision about the
 *    project's shape, so FR-1.9 says to offer it. `POST /api/locales/file` is
 *    that offer.
 */

export type TargetCell =
  | {
      readonly kind: 'existing';
      readonly unit: TransUnit;
      readonly doc: LoadedDocument;
      readonly relPath: string;
    }
  | {
      readonly kind: 'create';
      /** The document the unit will be inserted into. */
      readonly doc: LoadedDocument;
      readonly file: XlfFile;
      readonly relPath: string;
      /** The unit to copy: its `<source>`, notes and context groups. */
      readonly sourceUnit: TransUnit;
      readonly sourceDoc: LoadedDocument;
      /** Insert after this unit, so the file keeps the source file's order. */
      readonly after: TransUnit | undefined;
    };

/** The scanned file holding `locale` for this row's group, if there is one. */
export function localeFileOf(
  project: OpenProject,
  group: string,
  locale: string,
): ScannedFile | undefined {
  return project.files.find((f) => f.group === group && f.locale === locale);
}

/**
 * Resolve where this row's `locale` target lives, creating nothing.
 *
 * Throws with a sentence a user can act on, which on this path is the whole
 * point: "the unit is missing" and "the file is missing" need different
 * answers, and conflating them is what made the old message misleading.
 */
export function resolveTargetCell(
  project: OpenProject,
  index: UnitIndex,
  row: IndexedRow,
  locale: string,
): TargetCell {
  const cell = row.cells.get(locale);
  if (cell?.unit && cell.doc && cell.relPath) {
    return { kind: 'existing', unit: cell.unit, doc: cell.doc, relPath: cell.relPath };
  }

  // The file check comes before the cell check on purpose: a locale the project
  // has no file for at all has no cell either, and "this unit has no pl column"
  // is true but useless. Both cases have the same fix, so both get it.
  const scanned = localeFileOf(project, row.group, locale);
  if (scanned === undefined) {
    throw badRequest(
      `There is no ${locale} file for "${row.group}" yet, so this string has nowhere to go. ` +
        `Create one from the source file first.`,
      { reason: 'no-locale-file', group: row.group, locale },
    );
  }

  if (!cell) throw notFound(`this unit has no ${locale} column`);

  const doc = project.documents.get(scanned.path);
  const file = doc?.files[scanned.fileIndex];
  if (!doc || !file) throw notFound(`the ${locale} file for "${row.group}" is not loaded`);

  // Copied from the project's source unit. An orphan has no source unit — and
  // an orphan is by definition a unit the source file does not have, so there
  // is nothing to carry into another locale either.
  const sourceUnit = row.sourceUnit;
  const sourceDoc = row.sourceDoc;
  if (!sourceUnit || !sourceDoc) {
    throw badRequest(
      `"${row.unitId}" is not in the source file, so there is nothing to copy into ${locale}.`,
    );
  }

  return {
    kind: 'create',
    doc,
    file,
    relPath: scanned.relPath,
    sourceUnit,
    sourceDoc,
    after: anchorFor(index, row, locale),
  };
}

/**
 * The unit the new one should follow: the nearest earlier row of the same group
 * that this locale already has.
 *
 * Insertion order would otherwise be the file's order, and a translation file
 * that grows in the order somebody happened to click is unreviewable. Walking
 * backwards from the row is cheap — `index.rows` is already in group-then-source
 * order — and human-paced, since it runs once per created unit.
 */
function anchorFor(index: UnitIndex, row: IndexedRow, locale: string): TransUnit | undefined {
  const at = index.rows.indexOf(row);
  if (at <= 0) return undefined;
  for (let i = at - 1; i >= 0; i--) {
    const previous = index.rows[i];
    if (previous === undefined || previous.group !== row.group) return undefined;
    const unit = previous.cells.get(locale)?.unit;
    if (unit !== undefined) return unit;
  }
  return undefined;
}

/**
 * Where a new locale file for this group would go, following the convention the
 * project already uses (FR-1.9).
 *
 * Derived from a sibling rather than chosen: a project that writes
 * `messages.de.xlf` gets `messages.pl.xlf`, and one that writes `de/messages.xlf`
 * gets `pl/messages.xlf`. Guessing the other convention would put the file
 * somewhere the next `ng extract-i18n` does not look, and the mistake would
 * survive as a file nobody notices is unused.
 */
export function newLocaleFilePath(
  sibling: ScannedFile,
  locale: string,
): { path: string; relPath: string } {
  const dir = dirname(sibling.path);
  const name = basename(sibling.path);

  if (sibling.localeSource === 'directory') {
    // `…/de/messages.xlf` → `…/pl/messages.xlf`.
    const path = join(dirname(dir), locale, name);
    return { path, relPath: relative(sibling, path) };
  }

  const ext = /\.(xlf|xliff)$/i.exec(name)?.[0] ?? '.xlf';
  const { stem, locale: token } = stripLocaleToken(name);

  // `en-GB.xlf` → `pl.xlf`. The filename IS the locale in this convention, so
  // appending one would produce `en-GB.pl.xlf` — a file the build never reads
  // and nobody notices is unused.
  if (
    token === undefined &&
    sibling.locale !== null &&
    stem.toLowerCase() === sibling.locale.toLowerCase()
  ) {
    const path = join(dir, `${locale}${ext}`);
    return { path, relPath: relative(sibling, path) };
  }

  // `messages.xlf` → `messages.pl.xlf`, and `messages.de.xlf` → `messages.pl.xlf`.
  const path = join(dir, `${stem}.${locale}${ext}`);
  return { path, relPath: relative(sibling, path) };
}

/**
 * The new file's path relative to the project root, derived from the sibling's
 * own pair rather than from the root — which this module does not have and does
 * not need.
 */
function relative(sibling: ScannedFile, path: string): string {
  const root = sibling.path.slice(0, sibling.path.length - sibling.relPath.length);
  return path.startsWith(root) ? path.slice(root.length).split('\\').join('/') : path;
}
