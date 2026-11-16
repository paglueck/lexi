// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { crc32, zipStore } from '../src/lib/zip.js';

const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

describe('zipStore', () => {
  it('computes the standard CRC32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it.skipIf(!hasUnzip)('writes an archive that unzip lists and extracts byte-exactly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lexi-zip-'));
    try {
      const a = new TextEncoder().encode('x;y\r\n');
      const b = new TextEncoder().encode('ä;ö\r\n');
      const file = join(dir, 'out.zip');
      await writeFile(file, zipStore([{ name: 'a.csv', data: a }, { name: 'b.csv', data: b }]));

      const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
      expect(listing).toContain('a.csv');
      expect(listing).toContain('b.csv');
      expect(execFileSync('unzip', ['-p', file, 'a.csv'])).toEqual(Buffer.from(a));
      expect(execFileSync('unzip', ['-p', file, 'b.csv'])).toEqual(Buffer.from(b));
      expect(spawnSync('unzip', ['-t', file]).status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
