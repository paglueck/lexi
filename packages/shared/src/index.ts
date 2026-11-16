// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `@lexi/shared` — the wire contract between `apps/server` and `apps/web`.
 *
 * One definition per payload, validated by the server and imported as types by
 * the client, so the two cannot drift.
 *
 * This package depends on `zod` and nothing else. In particular it must never
 * import `@lexi/xliff`, whose barrel reaches `node:crypto` and `node:fs/promises`
 * and therefore cannot be bundled into the browser.
 */
export * from './constants.js';
export * from './common.js';
export * from './csv-import.js';
export * from './events.js';
export * from './fs.js';
export * from './health.js';
export * from './jobs.js';
export * from './project.js';
export * from './prompt.js';
export * from './review-csv.js';
export * from './settings.js';
export * from './shared-sources.js';
export * from './styleguides.js';
export * from './termbase.js';
export * from './termbase-csv.js';
export * from './token-text.js';
export * from './units.js';
export * from './update.js';
export * from './xliff-enums.js';
export * from './issues.js';
export * from './phrase.js';
