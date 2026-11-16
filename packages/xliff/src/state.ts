// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { TransUnit, XlfFile } from './scan.js';

/**
 * The normalized lifecycle states the app works in.
 *
 * `draftMachine` has no XLIFF 1.2 representation of its own: the format has no
 * `subState`, so "a model wrote this" and "a human wrote this and it needs review"
 * serialize identically. The distinction is kept in `.lexi/state.json`, keyed by
 * file path and unit id, which leaves the XLIFF files clean.
 */
export const UNIT_STATES = ['untranslated', 'draftMachine', 'needsReview', 'reviewed', 'final'] as const;
export type UnitState = (typeof UNIT_STATES)[number];

const READ_MAP: Readonly<Record<string, UnitState>> = {
  'new': 'untranslated',
  'needs-translation': 'untranslated',
  'needs-review-translation': 'needsReview',
  'needs-review-l10n': 'needsReview',
  'needs-l10n': 'needsReview',
  'needs-adaptation': 'needsReview',
  'needs-review-adaptation': 'needsReview',
  'translated': 'reviewed',
  'final': 'final',
  'signed-off': 'final',
};

const WRITE_MAP: Readonly<Record<UnitState, string>> = {
  untranslated: 'new',
  draftMachine: 'needs-review-translation',
  needsReview: 'needs-review-translation',
  reviewed: 'translated',
  final: 'final',
};

/** Whether the unit has target content worth calling a translation. */
export function hasTargetContent(unit: TransUnit): boolean {
  const target = unit.target;
  if (target === undefined || target.selfClosing) return false;
  if ((unit.targetPhIds?.length ?? 0) > 0) return true;
  return (unit.targetPlain ?? '').trim() !== '';
}

/**
 * The state of a unit's target, read from the file alone.
 *
 * An absent or empty `<target>` is authoritative and outranks any `state`
 * attribute: Angular's own tooling never writes `state`, so correctness must
 * never depend on it (requirements §4.2).
 */
export function readUnitState(unit: TransUnit): UnitState {
  if (!hasTargetContent(unit)) return 'untranslated';

  const attr = unit.target?.attrs['state'];
  if (attr === undefined) return 'reviewed';

  const mapped = READ_MAP[attr];
  // Unknown vocabulary: assume it needs a look rather than silently trusting it.
  if (mapped === undefined) return 'needsReview';
  // `state="new"` with content is not a contradiction: ng-extract-i18n-merge copies
  // the source text into a new target by default, so the content is a placeholder
  // and the state is the truthful signal.
  return mapped;
}

export const xliffStateFor = (state: UnitState): string => WRITE_MAP[state];

export const WRITE_STATE_MODES = ['auto', 'always', 'never'] as const;
export type WriteStateMode = (typeof WRITE_STATE_MODES)[number];

/**
 * Whether to write `state` attributes into a given file.
 *
 * `auto` writes them only into files that already use them. Angular's own
 * serializer emits no `state`, while `ng-extract-i18n-merge` does; defaulting to
 * "always on" would spray `state="translated"` across every touched target on the
 * first save in a repo that does not use the merge tool, turning a one-word change
 * into two changes per line. `auto` makes the tool invisible in one kind of repo
 * and compatible with the other, without asking anyone to configure it.
 */
export const shouldWriteState = (mode: WriteStateMode, file: XlfFile): boolean =>
  mode === 'always' ? true : mode === 'never' ? false : file.hasAnyStateAttr;
