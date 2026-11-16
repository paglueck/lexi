// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import {
  defaultJobTitle,
  etaText,
  jobDisplayName,
  jobTitle,
  jobTotals,
  lockedLocales,
} from './job-math.js';
import { jobFixture, jobLocale } from './testing/job-fixture.js';

describe('etaText', () => {
  it('uses the design rate of 2.1 s per unit before anything has run', () => {
    expect(etaText(140)).toBe('~5 min');
  });

  it('never says less than a minute', () => {
    expect(etaText(1)).toBe('~1 min');
  });

  it('switches to hours from an hour up', () => {
    expect(etaText(2000)).toBe('~1 h 10 min');
  });

  it('uses the measured rate once there is one', () => {
    expect(etaText(60, 1000)).toBe('~1 min');
  });

  it('is empty when nothing is left', () => {
    expect(etaText(0)).toBe('');
  });
});

describe('jobTotals', () => {
  it('adds up every locale but the skipped ones', () => {
    const job = jobFixture({
      locales: [
        jobLocale({ locale: 'fr', total: 24, currentIndex: 24, rejected: 3, skipped: 1 }),
        jobLocale({ locale: 'de', total: 140, currentIndex: 86, failed: 2 }),
        jobLocale({ locale: 'pl', status: 'skipped', total: 1148 }),
      ],
    });
    expect(jobTotals(job)).toEqual({ total: 164, done: 110, flagged: 6 });
  });
});

describe('jobTitle', () => {
  it('lists up to three locales, then counts them', () => {
    const of = (codes: string[]) =>
      jobFixture({ locales: codes.map((locale) => jobLocale({ locale })) });
    expect(jobTitle(of(['de', 'fr', 'pl']))).toBe('Draft untranslated units · de, fr, pl');
    expect(jobTitle(of(['de', 'fr', 'pl', 'it']))).toBe('Draft untranslated units · 4 locales');
  });
});

describe('defaultJobTitle', () => {
  it('follows the same rule as jobTitle, and is just the task with no locales', () => {
    expect(defaultJobTitle('draft', ['de', 'fr'])).toBe('Draft untranslated units · de, fr');
    expect(defaultJobTitle('draft', ['de', 'fr', 'pl', 'it'])).toBe(
      'Draft untranslated units · 4 locales',
    );
    expect(defaultJobTitle('draft', [])).toBe('Draft untranslated units');
  });
});

describe('jobDisplayName', () => {
  it('is the name the job was given', () => {
    expect(jobDisplayName(jobFixture({ name: 'Release 4.2' }))).toBe('Release 4.2');
  });

  it('falls back to the generated title without one', () => {
    expect(jobDisplayName(jobFixture({ name: null }))).toBe('Draft untranslated units · de');
  });
});

describe('lockedLocales', () => {
  it('locks every locale an active job of the same task holds, except the ones it skipped', () => {
    const jobs = [
      jobFixture({
        id: 'a',
        number: 14,
        status: 'running',
        locales: [jobLocale({ locale: 'de' }), jobLocale({ locale: 'pl', status: 'skipped' })],
      }),
      jobFixture({
        id: 'b',
        number: 15,
        status: 'queued',
        locales: [jobLocale({ locale: 'ar', status: 'queued' })],
      }),
      jobFixture({
        id: 'c',
        number: 13,
        status: 'done',
        locales: [jobLocale({ locale: 'nl', status: 'done' })],
      }),
    ];
    expect([...lockedLocales(jobs, 'draft')]).toEqual([
      ['de', 14],
      ['ar', 15],
    ]);
  });
});
