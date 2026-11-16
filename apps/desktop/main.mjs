// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Desktop shell: Lexi in its own window, with no Node, npm or terminal needed.
 *
 * This does what bin/lexi.mjs does, but in-process: pick a port, start the
 * server, then point a BrowserWindow at it instead of the system browser.
 *
 * The window loads plain http://127.0.0.1:<port>/ on purpose, not a custom
 * app:// scheme. The server's security plugin accepts loopback origins only,
 * and the per-process token arrives inside index.html. Over loopback HTTP both
 * keep working with no server changes, and the page stays an ordinary web
 * client: no preload and no Node in the renderer. The updater follows the
 * same rule: it is handed to the server, which offers it as /api/update.
 */
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createUpdater } from './updater.mjs';

// Packaged, the server sits in resources/server/ (outside the asar, so that the
// Copilot SDK can spawn its native runtime from real disk). Unpackaged
// (`npm run desktop:dev`), it is the repo's own build output.
const HERE = import.meta.dirname;
const SERVER_DIR = app.isPackaged
  ? join(process.resourcesPath, 'server')
  : join(HERE, '..', 'server');
const SERVER_BUNDLE = join(SERVER_DIR, 'dist', 'main.js');
const PUBLIC_DIR = join(SERVER_DIR, 'public');
const PORTS = app.isPackaged ? join(HERE, 'ports.mjs') : join(HERE, '..', '..', 'bin', 'ports.mjs');
// Served from public/ by the server; scripts/collect-licenses.mjs puts them there.
const LEGAL_FILES = new Set([
  '/LICENSE.txt',
  '/NOTICE.txt',
  '/THIRD_PARTY_NOTICES.md',
  '/third-party-licenses.txt',
]);

let server;
let origin;
let mainWindow;

// One Lexi per user: a second launch focuses the first window instead of
// starting a second server on the next port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot, fail);
}

async function boot() {
  Menu.setApplicationMenu(buildMenu());
  app.setAboutPanelOptions({
    applicationName: 'Lexi',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Patrick Glück',
    credits:
      'Originally developed by Patrick Glück. Free software under the GNU GPL v3 or later. Source: https://github.com/paglueck/lexi',
  });
  // Packaged, the .icns/.ico baked into the bundle is the icon. Unpackaged, the
  // process is the stock Electron binary, so lend it Lexi's.
  if (!app.isPackaged && process.platform === 'darwin')
    app.dock?.setIcon(join(HERE, 'build', 'icon.png'));

  // startServer() runs the same check but answers with process.exit(1), which
  // in a GUI app means the window simply never appears. Ask first, so a
  // broken Electron upgrade surfaces as a dialog.
  if (new Intl.PluralRules('pl').resolvedOptions().pluralCategories.length !== 4) {
    throw new Error('This build lacks full ICU data, so plural rules would be wrong.');
  }

  const { choosePort, DEFAULT_PORT } = await import(pathToFileURL(PORTS).href);
  // attach: false — a Lexi started from the CLI holds a token this process
  // cannot learn, so take the next free port and run our own.
  const { port } = await choosePort(DEFAULT_PORT, { attach: false });

  const { startServer } = await import(pathToFileURL(SERVER_BUNDLE).href);
  server = await startServer({
    port,
    version: app.getVersion(),
    publicDir: PUBLIC_DIR,
    // Absent when unpackaged (unless LEXI_UPDATE_URL is set), which hides
    // everything update-related in the UI.
    updater: createUpdater(),
  });
  origin = new URL(server.url).origin;

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Lexi',
    ...(app.isPackaged ? {} : { icon: join(HERE, 'build', 'icon-window.png') }),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Anything that leaves Lexi's own origin (style guide links, docs) opens in
  // the user's browser, never inside the app window. The license files that
  // Settings → About links are Lexi's own and get a window of their own.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isOwnOrigin(url) && LEGAL_FILES.has(new URL(url).pathname)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 800, height: 700 } };
    }
    if (!isOwnOrigin(url)) void openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isOwnOrigin(url)) return;
    event.preventDefault();
    void openExternal(url);
  });

  void mainWindow.loadURL(server.url);
}

function isOwnOrigin(url) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

async function openExternal(url) {
  // Only web links: shell.openExternal on file: or a custom scheme would hand
  // the page a way to launch arbitrary local programs.
  if (!/^https?:/i.test(url)) return;
  await shell.openExternal(url);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    // macOS routes Cmd-C/V/X/Z through the Edit menu; without it the segment
    // editor loses copy and paste.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

function fail(err) {
  dialog.showErrorBox('Lexi could not start', err instanceof Error ? err.message : String(err));
  app.exit(1);
}

// macOS convention: closing the window keeps the app (and its server) alive in
// the Dock; everywhere else it quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Let the server flush and close its watchers before the process goes.
//
// This ends in app.exit(), not a second app.quit(): once a quit has been
// prevented, calling quit again closes the windows but never reaches
// will-quit, so the process stays alive holding the single-instance lock and
// every later launch silently exits.
const CLOSE_TIMEOUT_MS = 3000;
let closing = false;
app.on('before-quit', (event) => {
  if (server === undefined) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  const timeout = new Promise((res) => setTimeout(res, CLOSE_TIMEOUT_MS));
  void Promise.race([server.close(), timeout])
    .catch(() => {})
    .finally(() => app.exit(0));
});
