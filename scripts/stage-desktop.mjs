#!/usr/bin/env node
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prepare apps/desktop/.stage/ for electron-builder:
 *
 *   .stage/app/      → the asar: Electron main process, updater, port helpers,
 *                      package.json, and electron-updater in node_modules
 *   .stage/legal/    → resources/legal/: LICENSE, NOTICE.txt, third-party notices
 *   .stage/server/   → resources/server/: server bundle, built SPA, and the one
 *                      external dependency the bundle leaves out (Copilot SDK)
 *
 * Usage: node scripts/stage-desktop.mjs <darwin|win32|linux> <arm64|x64>
 *
 * The Copilot SDK is installed fresh for the *target* platform rather than
 * copied out of the repo's node_modules, which only holds the prebuild for
 * the machine that ran `npm install`. That is what lets a Mac stage a Windows
 * build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const STAGE = join(DESKTOP, '.stage');
const SERVER = join(ROOT, 'apps', 'server');

const [platform, arch] = process.argv.slice(2);
if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  process.stderr.write('Usage: node scripts/stage-desktop.mjs <darwin|win32|linux> <arm64|x64>\n');
  process.exit(2);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd = ROOT) =>
  execFileSync(npm, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

const { version } = readJson(join(ROOT, 'package.json'));
const sdkVersion = readJson(
  join(ROOT, 'node_modules', '@github', 'copilot-sdk', 'package.json'),
).version;
const updaterVersion = readJson(
  join(ROOT, 'node_modules', 'electron-updater', 'package.json'),
).version;

log('Building web and server');
run(['run', 'build']);

rmSync(STAGE, { recursive: true, force: true });

log('Staging app');
const app = join(STAGE, 'app');
mkdirSync(app, { recursive: true });
cpSync(join(DESKTOP, 'main.mjs'), join(app, 'main.mjs'));
cpSync(join(DESKTOP, 'updater.mjs'), join(app, 'updater.mjs'));
cpSync(join(ROOT, 'bin', 'ports.mjs'), join(app, 'ports.mjs'));
writeJson(join(app, 'package.json'), {
  name: 'lexi',
  productName: 'Lexi',
  version,
  description: 'Local translation manager',
  author: 'Patrick Glück',
  license: 'GPL-3.0-or-later',
  type: 'module',
  main: 'main.mjs',
  dependencies: { 'electron-updater': updaterVersion },
});

// The main process's one runtime dependency. Pure JavaScript, so unlike the
// Copilot SDK below it needs no --os/--cpu: the same files serve every target.
log(`Installing electron-updater@${updaterVersion}`);
run(['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], app);

log('Staging license files');
const legal = join(STAGE, 'legal');
mkdirSync(legal, { recursive: true });
for (const name of ['LICENSE', 'NOTICE.txt', 'THIRD_PARTY_NOTICES.md', 'licenses']) {
  cpSync(join(ROOT, name), join(legal, name), { recursive: true });
}

log('Staging server');
const server = join(STAGE, 'server');
mkdirSync(join(server, 'dist'), { recursive: true });
cpSync(join(SERVER, 'dist', 'main.js'), join(server, 'dist', 'main.js'));
cpSync(join(SERVER, 'dist', 'main.js.map'), join(server, 'dist', 'main.js.map'));
cpSync(join(SERVER, 'public'), join(server, 'public'), { recursive: true });
// The bundle is ESM, and resolveConfig() finds public/ relative to dist/.
writeJson(join(server, 'package.json'), {
  name: 'lexi-server',
  private: true,
  type: 'module',
  dependencies: { '@github/copilot-sdk': sdkVersion },
});

log(`Installing @github/copilot-sdk@${sdkVersion} for ${platform}-${arch}`);
run(
  [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    `--os=${platform}`,
    `--cpu=${arch}`,
    // The Linux platform packages are split by libc (glibc, musl); npm only
    // detects it by itself when it runs on Linux. AppImages target glibc.
    ...(platform === 'linux' ? ['--libc=glibc'] : []),
  ],
  server,
);

log(`Staged in ${STAGE}`);

function log(msg) {
  process.stdout.write(`\n▸ ${msg}\n`);
}
