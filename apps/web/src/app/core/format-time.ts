// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Clock times and durations, in one place (M15).
 *
 * The app had formatted dates three times in three components before this —
 * `job-card`, `dashboard-page` and `start-page` — each with its own idea of
 * what to show. Two of them wanted the same thing; this is that thing.
 *
 * `start-page`'s `when()` deliberately stays where it is: it is a RELATIVE
 * formatter ("2 hours ago", "3 weeks ago") for a recents list, which is a
 * different question from "when did this run".
 *
 * Both functions are pure and take an explicit `now`, so the tests do not have
 * to fake a clock to assert the today/not-today boundary.
 */

/**
 * `11:34` for something that happened today, `20 Sep, 18:02` otherwise.
 *
 * The date is omitted for today because that is the overwhelming case — a job
 * queue is a record of the current session — and a date on every row would be
 * noise that buries the part that varies.
 */
export function clock(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return isSameDay(at, now)
    ? time
    : `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/**
 * `16 Oct, 11:34` — the date always, even today, and the year too once it is
 * not this one. For S14's job cards, which outlive the session that ran them
 * and sit in a list where "11:34" alone cannot say which day.
 */
export function stamp(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = at.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/**
 * How long something took: `51 s`, `2 min 14 s`, `1 h 4 min`.
 *
 * The unit steps down as the magnitude goes up — nobody reads "3,847 s", and
 * seconds stop being interesting once there are hours of them. Empty when
 * either bound is missing, which is the honest answer for a job that never
 * started.
 */
export function span(from: string | null, to: string | null): string {
  if (from === null || to === null) return '';
  const ms = Date.parse(to) - Date.parse(from);
  if (Number.isNaN(ms) || ms < 0) return '';

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const isSameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * "2 hours ago" / "Tuesday" / "3 weeks ago" — S1's and S17's recent rows, and
 * the "checked …" times of S18/S19. Empty for a missing or unreadable time.
 */
export function relative(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  // Inside a week a weekday name is more useful than a count.
  if (days < 7) return new Date(then).toLocaleDateString(undefined, { weekday: 'long' });

  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString();
}

/** `/Users/x/dev/app` -> `~/dev/app`, which is what the handoff displays. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** `4812` -> `4,812`, the handoff's grouping regardless of the browser's locale. */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}
