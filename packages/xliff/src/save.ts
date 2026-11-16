// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, stat, unlink, chmod } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { scan, type XlfDocument } from './scan.js';
import { serialize } from './edits.js';
import type { Edit } from './splice.js';

/** A document together with the path it came from. */
export interface LoadedDocument extends XlfDocument {
  readonly path: string;
}

export class StaleFileError extends Error {
  constructor(readonly path: string) {
    super(`${basename(path)} changed on disk since it was opened. Reload it before saving.`);
    this.name = 'StaleFileError';
  }
}

export async function loadDocument(path: string): Promise<LoadedDocument> {
  const raw = await readFile(path, 'utf8');
  return { ...scan(raw), path };
}

export interface AtomicWriteOptions {
  /** Test seam for exercising the failure path. */
  readonly onBeforeRename?: () => void;
}

/**
 * Write a file by replacing it wholesale, or not at all.
 *
 * The temporary file lives in the same directory because `rename` is only atomic
 * within one filesystem and a project may sit on a mounted volume. It is opened
 * with `wx` so a concurrent writer is never clobbered, the original mode is
 * carried over so a `0644` file in a repository does not quietly become private,
 * and the cleanup path removes the temporary file on any failure — a crashed save
 * should not leave `.messages.xlf.lexi-*.tmp` next to the real file for somebody
 * to commit by accident.
 */
export async function atomicWrite(path: string, text: string, options: AtomicWriteOptions = {}): Promise<void> {
  const directory = dirname(path);
  const existing = await stat(path).catch(() => null);
  const temporary = join(directory, `.${basename(path)}.lexi-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', existing?.mode ?? 0o644);
    await handle.writeFile(Buffer.from(text, 'utf8'));
    await handle.sync(); // the contents must be durable before the rename
    await handle.close();
    handle = undefined;

    if (existing) await chmod(temporary, existing.mode);
    options.onBeforeRename?.();
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }

  // Make the directory entry durable too. Not supported on Windows.
  if (process.platform !== 'win32') {
    const directoryHandle = await open(directory, 'r').catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => {});
      await directoryHandle.close();
    }
  }
}

export interface SaveResult {
  readonly written: boolean;
  readonly path: string;
}

/**
 * Apply edits and write the file, unless nothing actually changed.
 *
 * The no-change test compares the resulting text rather than counting edits,
 * which also catches the edit that happens to be a no-op — a translator typing a
 * character and deleting it again should not produce a commit (FR-1.6).
 *
 * The on-disk contents are re-checked against the hash taken at load time, so a
 * `git pull` between opening and saving is refused rather than overwritten
 * (FR-1.5). The cheap `mtime`/`size` comparison comes first so saving twenty
 * files does not hash a hundred megabytes for nothing.
 */
export async function saveDocument(
  doc: LoadedDocument,
  edits: readonly Edit[],
  options: AtomicWriteOptions = {},
): Promise<SaveResult> {
  const next = serialize(doc, edits);
  if (next === doc.raw) return { written: false, path: doc.path };

  await assertNotStale(doc);

  await atomicWrite(doc.path, next, options);
  return { written: true, path: doc.path };
}

/**
 * Refuse a document whose file no longer holds the bytes it was loaded from
 * (FR-1.5) — `saveDocument`'s own check, exported so a save that writes
 * several files can check them all before it writes the first. Otherwise a
 * stale second file is found only after the first has been written.
 */
export async function assertNotStale(doc: LoadedDocument): Promise<void> {
  const current = await readFile(doc.path, 'utf8');
  if (current !== doc.raw) throw new StaleFileError(doc.path);
}
