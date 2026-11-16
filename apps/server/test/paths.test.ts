// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The jail. Each case here corresponds to one of the four ways a naive
 * implementation leaks: string-prefix containment, symlinks, un-realpath'd
 * roots, and relative input.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { contains, JailError, resolveForCreate, resolveWithinRoots } from '../src/lib/paths.js';
import { goodHeaders, testConfig } from './helpers.js';

let root: string;
let outside: string;
let app: FastifyInstance;

beforeAll(async () => {
  // realpath the fixture root: on macOS tmpdir() is /var/... which is really
  // /private/var. An un-realpath'd root would reject its own children.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-jail-')));
  root = join(base, 'project');
  outside = join(base, 'secrets');
  await mkdir(join(root, 'locale'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(`${root}EVIL`, { recursive: true });
  await writeFile(join(root, 'locale', 'messages.de.xlf'), '<xliff/>');
  await writeFile(join(root, 'locale', 'notes.txt'), 'hi');
  await writeFile(join(outside, 'passwords.txt'), 'hunter2');
  await symlink(outside, join(root, 'jailbreak'), 'dir');

  app = await buildApp(testConfig({ roots: [root] }), { logger: false });
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('contains()', () => {
  it('is not fooled by a sibling that shares a string prefix', () => {
    // The single most common jail bug: startsWith() says true here.
    expect('/Users/patrickEVIL'.startsWith('/Users/patrick')).toBe(true);
    expect(contains('/Users/patrick', '/Users/patrickEVIL')).toBe(false);
  });

  it('accepts the root itself and its descendants', () => {
    expect(contains('/Users/patrick', '/Users/patrick')).toBe(true);
    expect(contains('/Users/patrick', '/Users/patrick/dev/x')).toBe(true);
  });

  it('rejects an ancestor', () => {
    expect(contains('/Users/patrick', '/Users')).toBe(false);
  });
});

describe('resolveWithinRoots()', () => {
  const cfg = () => testConfig({ roots: [root] });

  it('accepts a path inside the root', async () => {
    await expect(resolveWithinRoots(join(root, 'locale'), cfg())).resolves.toBe(
      join(root, 'locale'),
    );
  });

  it('rejects traversal out of the root', async () => {
    await expect(resolveWithinRoots(join(root, '..', 'secrets'), cfg())).rejects.toBeInstanceOf(
      JailError,
    );
  });

  it('rejects a symlink that points outside — realpath, not lexical resolution', async () => {
    await expect(resolveWithinRoots(join(root, 'jailbreak'), cfg())).rejects.toBeInstanceOf(
      JailError,
    );
  });

  it('rejects a sibling directory sharing the root as a string prefix', async () => {
    await expect(resolveWithinRoots(`${root}EVIL`, cfg())).rejects.toBeInstanceOf(JailError);
  });

  it('rejects a relative path', async () => {
    await expect(resolveWithinRoots('locale', cfg())).rejects.toThrow(/absolute/);
  });

  it('rejects an embedded NUL', async () => {
    await expect(resolveWithinRoots(`${root}\0/etc`, cfg())).rejects.toThrow(/invalid/);
  });

  it('reports a missing path as 404, not 403', async () => {
    await expect(resolveWithinRoots(join(root, 'nope'), cfg())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('grants nothing when no root was configured', async () => {
    await expect(
      resolveWithinRoots(join(root, 'locale'), testConfig({ roots: [] })),
    ).rejects.toBeInstanceOf(JailError);
  });
});

describe('GET /api/fs/browse', () => {
  const browse = (path: string) =>
    app.inject({
      method: 'GET',
      url: `/api/fs/browse?path=${encodeURIComponent(path)}`,
      headers: goodHeaders(),
    });

  it('lists a directory, folders first, and flags XLIFF files', async () => {
    const res = await browse(join(root, 'locale'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { path: string; parent: string | null; entries: unknown[] };
    expect(body.path).toBe(join(root, 'locale'));
    expect(body.entries).toEqual([
      expect.objectContaining({ name: 'messages.de.xlf', kind: 'file', isXliff: true }),
      expect.objectContaining({ name: 'notes.txt', kind: 'file', isXliff: false }),
    ]);
  });

  it('lists a symlink as a symlink without following it', async () => {
    const res = await browse(root);
    const body = res.json() as { entries: Array<{ name: string; kind: string }> };
    expect(body.entries).toContainEqual(
      expect.objectContaining({ name: 'jailbreak', kind: 'symlink' }),
    );
  });

  it('refuses to open that symlink', async () => {
    const res = await browse(join(root, 'jailbreak'));
    expect(res.statusCode).toBe(403);
  });

  it('reports no parent at the root, so the UI cannot walk up out of the jail', async () => {
    const res = await browse(root);
    expect((res.json() as { parent: string | null }).parent).toBeNull();
  });

  it.each([['/etc'], ['relative/path']])('rejects %s', async (bad) => {
    expect((await browse(bad)).statusCode).toBe(403);
  });

  it('rejects a missing path parameter with a 400 envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/fs/browse',
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });
});

/**
 * `.lexi/project.json` does not exist the first time we write it, and
 * `resolveWithinRoots` realpaths — which throws on a missing file. These cases
 * are what keep the create path as jailed as the browse path.
 */
describe('resolveForCreate — jailing a path that does not exist yet', () => {
  const cfg = () => testConfig({ roots: [root] });

  it('resolves a file inside an existing directory', async () => {
    const target = join(root, '.lexi', 'project.json');
    expect(await resolveForCreate(target, cfg())).toBe(target);
  });

  it('resolves through several directories that do not exist yet', async () => {
    const target = join(root, 'a', 'b', 'c', 'project.json');
    expect(await resolveForCreate(target, cfg())).toBe(target);
  });

  it('still refuses a target outside the roots', async () => {
    await expect(resolveForCreate(join(outside, 'x.json'), cfg())).rejects.toBeInstanceOf(
      JailError,
    );
  });

  it('refuses a traversal that climbs out, because resolve() collapses it first', async () => {
    const escape = join(root, '..', 'secrets', 'x.json');
    await expect(resolveForCreate(escape, cfg())).rejects.toBeInstanceOf(JailError);
  });

  it('refuses the prefix-collision sibling', async () => {
    await expect(resolveForCreate(`${root}EVIL/x.json`, cfg())).rejects.toBeInstanceOf(JailError);
  });

  it('refuses relative input and NUL bytes, as the browse path does', async () => {
    await expect(resolveForCreate('relative/x.json', cfg())).rejects.toBeInstanceOf(JailError);
    await expect(resolveForCreate(`${root}/\0x.json`, cfg())).rejects.toBeInstanceOf(JailError);
  });

  it('grants nothing when no roots were granted at all', async () => {
    await expect(
      resolveForCreate(join(root, 'x.json'), testConfig({ roots: [] })),
    ).rejects.toBeInstanceOf(JailError);
  });
});
