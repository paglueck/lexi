// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Types for the corpus generator, which stays plain JavaScript so it runs with
 * `node` and no build step. Without this, the one TypeScript caller
 * (`apps/server/test/units-perf.test.ts`) sees an untyped import, and
 * type-checked lint rightly calls it an unsafe call.
 */
export declare const DEFAULT_LOCALES: readonly string[];

export declare function generateLargeCorpus(options?: {
  readonly units?: number;
  readonly locales?: readonly string[];
  readonly outDir?: string;
  readonly quiet?: boolean;
}): Promise<string[]>;
