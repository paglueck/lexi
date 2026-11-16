// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { detectLocale, fileGroupOf, isTemplateFile, scan, type LoadedDocument } from '@lexi/xliff';
import { isRtlLocale, type ScannedFile } from '@lexi/shared';

/**
 * Walk a directory for `.xlf` files and report what each one is (FR-1.1, FR-1.2).
 *
 * Reports rather than decides: the wizard confirms the mapping before anything
 * is treated as authoritative (FR-1.3), and a disagreement between the filename
 * and `target-language` is surfaced as a row, never resolved silently (FR-1.2b).
 */

const XLIFF_EXT = /\.(xlf|xliff)$/i;

/** Directories that never hold translations and can be very large. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.angular', 'out-tsc']);

/**
 * Bounded parallelism. NFR-3 wants 20 locales x 20k units opened in under ten
 * seconds; unbounded `Promise.all` over a large tree exhausts the file handle
 * limit long before it helps, and fully serial reads waste the wait.
 */
const CONCURRENCY = 8;

export interface ScanOutcome {
  readonly files: readonly ScannedFile[];
  readonly skipped: ReadonlyArray<{ relPath: string; reason: string }>;
  /** Parsed once, kept so `open` need not re-read the whole project. */
  readonly documents: ReadonlyMap<string, LoadedDocument>;
}

async function collectPaths(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // Dotfiles are skipped wholesale, which is also what keeps our own
      // `.lexi/` out of the results.
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      // Symlinked directories are not followed: a link pointing back up the
      // tree would loop, and one pointing outside would leave the project.
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && XLIFF_EXT.test(entry.name)) {
        found.push(full);
      }
    }
  };

  await walk(root);
  return found.sort();
}

/** `a/b/c.xlf` with forward slashes on every platform, so the wire is stable. */
const relPathOf = (root: string, path: string): string => relative(root, path).split(sep).join('/');

export async function scanProject(root: string): Promise<ScanOutcome> {
  const paths = await collectPaths(root);

  const files: ScannedFile[] = [];
  const skipped: Array<{ relPath: string; reason: string }> = [];
  const documents = new Map<string, LoadedDocument>();

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const path = paths[index];
      if (path === undefined) return;

      const relPath = relPathOf(root, path);
      let doc: LoadedDocument;
      try {
        const raw = await readFile(path, 'utf8');
        doc = { ...scan(raw), path };
      } catch (error) {
        // A file we cannot parse is reported, never dropped: an unreadable
        // locale file is exactly the thing a user needs to be told about.
        skipped.push({ relPath, reason: error instanceof Error ? error.message : 'unreadable' });
        continue;
      }

      documents.set(path, doc);
      for (const [fileIndex, file] of doc.files.entries()) {
        const detection = detectLocale(relPath, file);
        files.push({
          path,
          relPath,
          fileIndex,
          // The detected locale, so a filename that is NOTHING but a locale
          // tag (`en-GB.xlf` beside `de-DE.xlf`) still correlates as one group.
          group: fileGroupOf(relPath, detection.locale),
          locale: detection.locale ?? null,
          localeSource: detection.source,
          conflictingTargetLanguage: detection.conflictingAttr ?? null,
          sourceLanguage: file.attrs['source-language'] ?? null,
          targetLanguage: file.attrs['target-language'] ?? null,
          unitCount: file.units.length,
          isTemplate: isTemplateFile(file),
          isRtl: detection.locale === undefined ? false : isRtlLocale(detection.locale),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Workers finish out of order; sort so the wizard's table is deterministic.
  files.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.fileIndex - b.fileIndex);
  skipped.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { files, skipped, documents };
}

/**
 * The locale to propose as the source (FR-1.2a).
 *
 * The extraction template's own language, because that is the file Angular
 * regenerates and therefore the one that defines which keys should exist.
 */
export function suggestSourceLocale(files: readonly ScannedFile[]): string | null {
  const template = files.find((f) => f.isTemplate);
  if (template) return template.sourceLanguage ?? template.locale;
  return files.find((f) => f.sourceLanguage !== null)?.sourceLanguage ?? null;
}
