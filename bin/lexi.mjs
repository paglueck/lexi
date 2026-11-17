#!/usr/bin/env node
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Production entry point: lexi [path] [--port 4317] [--no-open]
 *
 * Runs the esbuild bundle, never tsx — shipping a TypeScript loader as a
 * runtime dependency of a user-facing CLI would cost ~30 MB and a slow boot for
 * nothing.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

import { choosePort, DEFAULT_PORT } from './ports.mjs';

const HERE = new URL('.', import.meta.url);
const BUNDLE = new URL('../apps/server/dist/main.js', HERE);
const PUBLIC_INDEX = new URL('../apps/server/public/index.html', HERE);

const USAGE = `lexi — local translation manager

  lexi [path] [options]

  path            project folder to grant access to (in addition to your home directory)

  --port <n>      port to listen on (default ${DEFAULT_PORT})
  --no-open       do not open a browser
  -h, --help      show this message
  -v, --version   print the version
`;

// node:util's parseArgs has no --no-x negation; it rejects `--no-open` outright
// with ERR_PARSE_ARGS_UNKNOWN_OPTION. Strip it first. Do not "fix" this back.
const rawArgs = process.argv.slice(2);
const noOpen = rawArgs.includes('--no-open');
const argv = rawArgs.filter((a) => a !== '--no-open');

let parsed;
try {
  parsed = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
  });
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

const { values, positionals } = parsed;
const version = JSON.parse(readFileSync(new URL('../package.json', HERE), 'utf8')).version;

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (!existsSync(PUBLIC_INDEX)) {
  process.stderr.write('The web app has not been built yet. Run `npm run build` first.\n');
  process.exit(1);
}

const explicitPort = values.port !== undefined;
const wantedPort = explicitPort ? Number.parseInt(values.port, 10) : DEFAULT_PORT;
if (!Number.isInteger(wantedPort) || wantedPort < 1 || wantedPort > 65535) {
  process.stderr.write(`Not a valid port: ${values.port}\n`);
  process.exit(2);
}

const projectPath = positionals[0] === undefined ? undefined : await safeRealpath(positionals[0]);

const port = await pickPort(wantedPort, explicitPort);
const { startServer } = await import(BUNDLE);
const server = await startServer({
  port,
  version,
  ...(projectPath === undefined ? {} : { projectPath }),
});

announce(server.url);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------

async function safeRealpath(p) {
  try {
    return await realpath(resolve(p));
  } catch {
    process.stderr.write(`No such folder: ${p}\n`);
    process.exit(2);
  }
}

async function pickPort(wanted, explicit) {
  let choice;
  try {
    choice = await choosePort(wanted, { explicit });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  if (choice.running !== undefined) {
    const url = `http://127.0.0.1:${choice.running}/`;
    process.stdout.write(`Lexi is already running at ${url}\n`);
    openBrowser(url);
    process.exit(0);
  }
  return choice.port;
}

function openBrowser(url) {
  // Never launch a browser out of a CI job or a piped invocation.
  if (noOpen || !process.stdout.isTTY) return;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser is not an error; the URL is on stdout either way.
  }
}

function announce(url) {
  // Printed regardless of --no-open, so the flag stays usable.
  // The URL carries NO token: it arrives inside index.html. In the URL it would
  // end up in shell history and browser autocomplete.
  process.stdout.write(`\n  Lexi ${version}\n  ${url}\n`);
  if (projectPath !== undefined) process.stdout.write(`  project: ${projectPath}\n`);
  process.stdout.write('\n  Ctrl-C to stop.\n\n');
}
