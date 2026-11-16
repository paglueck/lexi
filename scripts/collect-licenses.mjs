#!/usr/bin/env node
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Put the license files into apps/server/public/, which the CLI serves and the
 * desktop build ships:
 *
 *   LICENSE.txt               the root LICENSE (GPLv3), with an extension so
 *                             the server sends it as text, not as a download
 *   NOTICE.txt, THIRD_PARTY_NOTICES.md, licenses/  copied from the root
 *   third-party-licenses.txt  the license text of every production dependency
 *                             in package-lock.json, in one file
 *
 * The server bundle (esbuild) inlines fastify, zod, yaml and friends, which
 * drops their LICENSE files on the floor; Angular's 3rdpartylicenses.txt only
 * covers what the browser bundle imports. Most of these licenses (MIT, BSD,
 * ISC) require the notice to travel with every copy, so the build collects
 * them into one file.
 *
 * Runs after build:web, because the Angular build empties public/ (and refuses
 * assets from outside apps/web, so angular.json cannot copy the root files).
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'apps', 'server', 'public');
const OUT = join(PUBLIC, 'third-party-licenses.txt');

cpSync(join(ROOT, 'LICENSE'), join(PUBLIC, 'LICENSE.txt'));
for (const name of ['NOTICE.txt', 'THIRD_PARTY_NOTICES.md', 'licenses']) {
  cpSync(join(ROOT, name), join(PUBLIC, name), { recursive: true });
}

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

const sections = [];
const missing = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || meta.dev || meta.link) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const dir = join(ROOT, path);
  // Optional platform packages (other OS/CPU) are in the lockfile but not on disk.
  if (!existsSync(dir)) continue;
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  const header = `${name}@${meta.version} — ${meta.license ?? 'license not declared'}`;
  if (!file) {
    missing.push(header);
    continue;
  }
  const text = readFileSync(join(dir, file), 'utf8').trim();
  sections.push(`${'='.repeat(78)}\n${header}\n${'='.repeat(78)}\n\n${text}\n`);
}

const intro = [
  'Third-party licenses for Lexi',
  '',
  'Generated from package-lock.json by scripts/collect-licenses.mjs. Lexi itself is',
  'licensed under the GNU GPL v3 or later (LICENSE.txt, NOTICE.txt); see also',
  'THIRD_PARTY_NOTICES.md for fonts, icons and other non-npm material.',
  '',
  ...(missing.length
    ? ['Packages without a license file of their own (declared license shown):', ...missing, '']
    : []),
].join('\n');

writeFileSync(OUT, `${intro}\n${sections.join('\n')}`);
process.stdout.write(`Wrote ${sections.length} license texts to ${OUT}\n`);
