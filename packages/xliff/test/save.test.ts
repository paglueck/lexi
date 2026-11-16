// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDocument, saveDocument, StaleFileError, atomicWrite } from '../src/save.js';
import { writeTarget } from '../src/edits.js';
import { CORPUS } from './corpus.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lexi-save-')); });
afterEach(async () => { /* the OS reclaims the temp dir */ });

const write = async (name: string, content: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
};

describe('loadDocument', () => {
  it('reads a file and keeps its bytes verbatim', async () => {
    const raw = CORPUS['de/messages.de.xlf']!;
    const doc = await loadDocument(await write('messages.de.xlf', raw));
    expect(doc.raw).toBe(raw);
  });

  it('preserves a BOM', async () => {
    const doc = await loadDocument(await write('bom.xlf', CORPUS['edge/bom.xlf']!));
    expect(doc.bom).toBe(true);
  });
});

describe('saveDocument — never rewrite an unchanged file (FR-1.6)', () => {
  it('writes nothing and leaves the modification time untouched', async () => {
    const path = await write('messages.de.xlf', CORPUS['de/messages.de.xlf']!);
    const doc = await loadDocument(path);
    const before = await stat(path);

    await new Promise((r) => setTimeout(r, 15));
    const result = await saveDocument(doc, []);

    expect(result.written).toBe(false);
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('treats an edit that changes nothing as no change at all', async () => {
    const path = await write('messages.de.xlf', CORPUS['de/messages.de.xlf']!);
    const doc = await loadDocument(path);
    const unit = doc.files[0]!.units[1]!;
    const unchanged = doc.raw.slice(unit.target!.innerSpan.start, unit.target!.innerSpan.end);

    const result = await saveDocument(doc, writeTarget(doc, unit, unchanged));
    expect(result.written).toBe(false);
  });

  it('writes when something really changed', async () => {
    const path = await write('messages.de.xlf', CORPUS['de/messages.de.xlf']!);
    const doc = await loadDocument(path);
    const result = await saveDocument(doc, writeTarget(doc, doc.files[0]!.units[1]!, 'Sofort bezahlen'));

    expect(result.written).toBe(true);
    expect(await readFile(path, 'utf8')).toContain('Sofort bezahlen');
  });
});

describe('saveDocument — external changes (FR-1.5)', () => {
  it('refuses to write over a file that changed on disk', async () => {
    const path = await write('messages.de.xlf', CORPUS['de/messages.de.xlf']!);
    const doc = await loadDocument(path);

    await writeFile(path, CORPUS['de/messages.de.xlf']! + '\n<!-- someone pulled -->\n', 'utf8');
    const before = await readFile(path, 'utf8');

    await expect(saveDocument(doc, writeTarget(doc, doc.files[0]!.units[1]!, 'x')))
      .rejects.toBeInstanceOf(StaleFileError);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('names the file in the error so the user knows which one to reload', async () => {
    const path = await write('messages.de.xlf', CORPUS['de/messages.de.xlf']!);
    const doc = await loadDocument(path);
    await writeFile(path, 'changed', 'utf8');
    await expect(saveDocument(doc, writeTarget(doc, doc.files[0]!.units[1]!, 'x')))
      .rejects.toThrow(/messages\.de\.xlf/);
  });
});

describe('atomicWrite (NFR-4)', () => {
  it('replaces the file contents', async () => {
    const path = await write('a.txt', 'before');
    await atomicWrite(path, 'after');
    expect(await readFile(path, 'utf8')).toBe('after');
  });

  it('leaves no temporary files behind on success', async () => {
    const path = await write('a.txt', 'before');
    await atomicWrite(path, 'after');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('leaves the original intact and no debris when the write fails', async () => {
    const path = await write('a.txt', 'before');
    // A directory in place of the temp file makes the open fail.
    await expect(atomicWrite(path, 'after', { onBeforeRename: () => { throw new Error('disk full'); } }))
      .rejects.toThrow('disk full');

    expect(await readFile(path, 'utf8')).toBe('before');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('preserves the original file mode, so a repo file does not become private', async () => {
    const path = await write('a.txt', 'before');
    await chmod(path, 0o644);
    await atomicWrite(path, 'after');
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it('creates a file that does not exist yet', async () => {
    const path = join(dir, 'new.xlf');
    await atomicWrite(path, 'content');
    expect(await readFile(path, 'utf8')).toBe('content');
  });

  it('writes UTF-8 bytes, including a BOM when the text has one', async () => {
    const path = join(dir, 'bom.xlf');
    await atomicWrite(path, '﻿hello');
    const bytes = await readFile(path);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
