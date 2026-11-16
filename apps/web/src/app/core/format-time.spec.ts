// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';

import { clock, span, stamp } from './format-time.js';

/**
 * Both take an explicit `now` so the today/not-today boundary is assertable
 * without faking a clock — the one thing about this pair that is easy to get
 * wrong and invisible until somebody looks at a queue the morning after.
 */

const NOW = new Date('2026-09-21T12:00:00');

describe('stamp', () => {
  // A relationship again, for the same locale reason as `clock` below.
  const AT = '2026-09-20T18:02:00';
  const time = new Date(AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = new Date(AT).toLocaleDateString([], { day: 'numeric', month: 'short' });

  it('shows the date even for something that happened today', () => {
    expect(stamp(AT, new Date('2026-09-20T23:00:00'))).toBe(`${day}, ${time}`);
  });

  it('adds the year once it is not this one', () => {
    const withYear = new Date(AT).toLocaleDateString([], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    expect(stamp(AT, new Date('2027-01-02T10:00:00'))).toBe(`${withYear}, ${time}`);
  });

  it('is empty for a missing or broken timestamp', () => {
    expect(stamp(null)).toBe('');
    expect(stamp('not a date')).toBe('');
  });
});

describe('clock', () => {
  // Asserted as a RELATIONSHIP rather than against literal strings: the output
  // goes through `toLocaleTimeString`, so it is "11:34" here and "11:34 AM" on
  // a machine set to en-US. Pinning either spelling would make this a test of
  // the CI box's locale.
  const AT = '2026-09-20T18:02:00';
  const sameDay = new Date('2026-09-20T23:00:00');

  it('shows the time alone for something that happened today', () => {
    expect(clock(AT, sameDay)).toBe(
      new Date(AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('adds the date once it is not today, keeping the time it already showed', () => {
    // A job queue outlives a session when the server does; "18:02" with no date
    // reads as "a few minutes ago", which is a lie by omission.
    const today = clock(AT, sameDay);
    const earlier = clock(AT, NOW);
    expect(earlier).toContain(today);
    expect(earlier).not.toBe(today);
    expect(earlier).toMatch(/20/);
  });

  it('is empty for a timestamp that is not there', () => {
    expect(clock(null, NOW)).toBe('');
  });

  it('is empty rather than "Invalid Date" for a value it cannot parse', () => {
    expect(clock('not a date', NOW)).toBe('');
  });
});

describe('span', () => {
  it('reads in seconds under a minute', () => {
    expect(span('2026-09-21T11:34:00Z', '2026-09-21T11:34:51Z')).toBe('51 s');
  });

  it('reads in minutes and seconds under an hour', () => {
    expect(span('2026-09-21T11:34:00Z', '2026-09-21T11:36:14Z')).toBe('2 min 14 s');
  });

  it('drops the seconds when they are zero, rather than saying "2 min 0 s"', () => {
    expect(span('2026-09-21T11:34:00Z', '2026-09-21T11:36:00Z')).toBe('2 min');
  });

  it('steps down to hours and minutes for a long run', () => {
    // Nobody reads "3,847 s", and seconds stop being interesting once there are
    // hours of them.
    expect(span('2026-09-21T09:00:00Z', '2026-09-21T10:04:07Z')).toBe('1 h 4 min');
  });

  it('is empty when either bound is missing', () => {
    // A job cancelled before it ever started has no span, and inventing "0 s"
    // would claim it ran.
    expect(span(null, '2026-09-21T11:36:00Z')).toBe('');
    expect(span('2026-09-21T11:34:00Z', null)).toBe('');
  });

  it('is empty rather than negative when the bounds are the wrong way round', () => {
    expect(span('2026-09-21T11:36:00Z', '2026-09-21T11:34:00Z')).toBe('');
  });
});
