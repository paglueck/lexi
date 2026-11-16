// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Finding } from '@lexi/shared';

import { checksFor } from './review-checks.js';

/**
 * The Checks card reports what PASSED as well as what failed, which is the
 * whole reason it is not just a list of findings: an empty findings array looks
 * identical to "nothing ran", and a reviewer needs to know the placeholders
 * were actually checked before they accept.
 */

const finding = (over: Partial<Finding>): Finding => ({
  rule: 'placeholder.mismatch',
  severity: 'error',
  message: 'target is missing INTERPOLATION',
  ...over,
});

const outcomeOf = (rows: ReturnType<typeof checksFor>, rule: string) =>
  rows.find((r) => r.rule === rule)?.outcome;

describe('checksFor', () => {
  it('reports a rule with no finding against it as passed', () => {
    expect(outcomeOf(checksFor([], false), 'placeholder.mismatch')).toBe('pass');
  });

  it('names a passing rule by what HOLDS, not by the failure it did not have', () => {
    // A tick beside "Placeholders do not match the source" says the opposite of
    // what the tick means, which is the phrasing the dashboard's issue rail
    // wants and this card must not borrow.
    const row = checksFor([], false).find((r) => r.rule === 'placeholder.mismatch');
    expect(row?.label).toBe('Placeholder ids match the source');
  });

  it("carries a finding's own message rather than the rule's generic title", () => {
    const rows = checksFor([finding({})], false);
    expect(rows.find((r) => r.rule === 'placeholder.mismatch')?.label).toBe(
      'target is missing INTERPOLATION',
    );
  });

  it('never claims an ICU check passed on a string with no ICU in it', () => {
    // Saying "plural categories complete" about "Pay now" would be a check that
    // never ran reporting a result.
    const rows = checksFor([], false);
    expect(outcomeOf(rows, 'icu.pluralCoverage')).toBe('skipped');
    expect(outcomeOf(rows, 'icu.structure')).toBe('skipped');
  });

  it('runs the ICU checks on an ICU string', () => {
    expect(outcomeOf(checksFor([], true), 'icu.pluralCoverage')).toBe('pass');
  });

  it('separates a warning from a blocking error', () => {
    const rows = checksFor(
      [finding({ rule: 'whitespace.edges', severity: 'warning', message: 'trailing space' })],
      false,
    );
    expect(outcomeOf(rows, 'whitespace.edges')).toBe('warning');
    expect(outcomeOf(rows, 'placeholder.mismatch')).toBe('pass');
  });

  it('shows a finding for a rule the card does not normally list', () => {
    // A finding nobody sees is worse than an untidy card.
    const rows = checksFor(
      [finding({ rule: 'target.empty', severity: 'error', message: 'empty' })],
      false,
    );
    expect(outcomeOf(rows, 'target.empty')).toBe('error');
  });

  it('keeps one row per rule even when a rule fires twice', () => {
    const rows = checksFor([finding({ message: 'first' }), finding({ message: 'second' })], false);
    expect(rows.filter((r) => r.rule === 'placeholder.mismatch')).toHaveLength(1);
  });
});
