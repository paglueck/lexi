// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { RULE_IDS, rowIdOf, splitRowId, type RuleId } from '@lexi/shared';

import { readLexiJson, writeLexiJson } from './lexi-dir.js';
import type { ServerConfig } from '../config.js';

/**
 * `.lexi/ignored-findings.json`: findings somebody has looked at and decided
 * are fine for this unit (S12's `i`, FR-8.3).
 *
 * COMMITTED, like `review-notes.json`. "Yes, *OK* is the same in German" is a
 * judgement the next person should not have to make again. It is nested by
 * group, unit and locale for the same reason too: two branches ignoring two
 * different units never touch the same line.
 *
 * HASH-GATED, like `state.json` and unlike `review-notes.json`. An ignore is a
 * claim about one source text. Once the English changes, the translation has
 * to be looked at again anyway, and the finding may now be right. So every
 * entry carries the source hash it was made against. An entry whose hash no
 * longer matches is simply not believed, and it is dropped the next time the
 * file is written.
 *
 * An ignore hides a finding from every count (Issues, the dashboard, the grid's
 * error filter), because three screens disagreeing is worse than any of them
 * being strict. It does NOT make an error go away where it matters: the detail
 * panel and FR-8.4's "cannot reach Final" still see it.
 */

interface IgnoredFindingsFile {
  readonly version: 1;
  readonly groups: Record<string, Record<string, Record<string, Record<string, string>>>>;
}

const FILE = 'ignored-findings.json';

export interface IgnoredEntry {
  readonly rowId: string;
  readonly locale: string;
  readonly rule: RuleId;
  /** `sourceHash` of the unit's source text when it was ignored. */
  readonly sourceHash: string;
}

const cellKey = (rowId: string, locale: string): string => `${rowId} ${locale}`;
const isRule = (value: string): value is RuleId => (RULE_IDS as readonly string[]).includes(value);

const NONE: ReadonlySet<RuleId> = new Set();

export class IgnoredFindings {
  /** cell -> rule -> source hash */
  readonly #cells = new Map<string, Map<RuleId, string>>();

  get size(): number {
    let n = 0;
    for (const rules of this.#cells.values()) n += rules.size;
    return n;
  }

  /** Whether any entry exists for this cell, before the hash is checked. Cheap. */
  hasAny(rowId: string, locale: string): boolean {
    return this.#cells.has(cellKey(rowId, locale));
  }

  /**
   * The rules ignored for this cell whose entry still matches the source.
   *
   * `currentHash` is a thunk so a cell with no entries (nearly all of them)
   * costs one map lookup and no sha256.
   */
  rulesFor(rowId: string, locale: string, currentHash: () => string): ReadonlySet<RuleId> {
    const rules = this.#cells.get(cellKey(rowId, locale));
    if (rules === undefined) return NONE;
    const hash = currentHash();
    const out = new Set<RuleId>();
    for (const [rule, stored] of rules) if (stored === hash) out.add(rule);
    return out;
  }

  add(entry: IgnoredEntry): void {
    const key = cellKey(entry.rowId, entry.locale);
    let rules = this.#cells.get(key);
    if (rules === undefined) {
      rules = new Map();
      this.#cells.set(key, rules);
    }
    rules.set(entry.rule, entry.sourceHash);
  }

  /** True when an entry was actually removed. */
  remove(rowId: string, locale: string, rule: RuleId): boolean {
    const key = cellKey(rowId, locale);
    const rules = this.#cells.get(key);
    if (rules === undefined) return false;
    const removed = rules.delete(rule);
    if (rules.size === 0) this.#cells.delete(key);
    return removed;
  }

  entries(): IgnoredEntry[] {
    const out: IgnoredEntry[] = [];
    for (const [key, rules] of this.#cells) {
      const [rowId = '', locale = ''] = key.split(' ');
      for (const [rule, sourceHash] of rules) out.push({ rowId, locale, rule, sourceHash });
    }
    return out;
  }

  /** Drop every entry `keep` rejects, e.g. one whose source has since changed. */
  prune(keep: (entry: IgnoredEntry) => boolean): boolean {
    let changed = false;
    for (const entry of this.entries()) {
      if (!keep(entry)) changed = this.remove(entry.rowId, entry.locale, entry.rule) || changed;
    }
    return changed;
  }

  clear(): void {
    this.#cells.clear();
  }
}

/** Parse the file. Anything unreadable, or naming a rule we do not know, yields nothing. */
export function ignoredFindingsOf(raw: unknown): IgnoredFindings {
  const out = new IgnoredFindings();
  const file = raw as Partial<IgnoredFindingsFile> | null;
  if (file === null || typeof file !== 'object' || typeof file.groups !== 'object') return out;

  for (const [group, units] of Object.entries(file.groups ?? {})) {
    if (typeof units !== 'object' || units === null) continue;
    for (const [unitId, locales] of Object.entries(units)) {
      if (typeof locales !== 'object' || locales === null) continue;
      for (const [locale, rules] of Object.entries(locales)) {
        if (typeof rules !== 'object' || rules === null) continue;
        for (const [rule, sourceHash] of Object.entries(rules)) {
          if (isRule(rule) && typeof sourceHash === 'string') {
            out.add({ rowId: rowIdOf(group, unitId), locale, rule, sourceHash });
          }
        }
      }
    }
  }
  return out;
}

export function toIgnoredFindingsFile(ignored: IgnoredFindings): IgnoredFindingsFile {
  const groups: IgnoredFindingsFile['groups'] = {};
  const entries = ignored
    .entries()
    .sort(
      (a, b) =>
        a.rowId.localeCompare(b.rowId) ||
        a.locale.localeCompare(b.locale) ||
        a.rule.localeCompare(b.rule),
    );
  for (const entry of entries) {
    const { group, unitId } = splitRowId(entry.rowId);
    const units = (groups[group] ??= {});
    const locales = (units[unitId] ??= {});
    const rules = (locales[entry.locale] ??= {});
    rules[entry.rule] = entry.sourceHash;
  }
  return { version: 1, groups };
}

export const readIgnoredFindings = async (projectPath: string): Promise<IgnoredFindings> =>
  ignoredFindingsOf(await readLexiJson<unknown>(projectPath, FILE));

export const writeIgnoredFindings = (
  cfg: ServerConfig,
  projectPath: string,
  ignored: IgnoredFindings,
): Promise<void> => writeLexiJson(cfg, projectPath, FILE, toIgnoredFindingsFile(ignored));
