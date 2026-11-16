// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The updater the desktop shell hands to startServer({ updater }).
 *
 * The server forwards it as /api/update and as `update` events on the SSE
 * stream, so the window stays a plain web client with no preload and no IPC.
 * The shape it has to satisfy is apps/server/src/lib/updater.ts.
 *
 * electron-updater does the checking on both platforms: it reads latest.yml or
 * latest-mac.yml from FEED_URL and compares versions. What happens after that
 * depends on MAC_MODE:
 *
 * - Windows, always 'auto': electron-updater downloads the NSIS installer, and
 *   install() quits Lexi into it.
 * - Linux, always 'auto': electron-updater replaces the AppImage it runs from.
 *   An AppImage that was unpacked or moved into a package has nothing to
 *   replace, and the check then reports an error.
 * - macOS, 'dmg' for now: the build is only ad-hoc signed, and Squirrel.Mac,
 *   which electron-updater installs through, refuses an update into an app
 *   without a Developer ID signature. So this downloads the DMG itself,
 *   checks it against the sha512 in latest-mac.yml, opens it and quits; the
 *   user drags Lexi into Applications.
 *
 * Once the Mac build is Developer ID signed and notarized, set MAC_MODE to
 * 'auto'. latest-mac.yml already lists the .zip Squirrel needs. A Lexi still on
 * an ad-hoc build keeps taking the DMG path once, which is what moves it onto
 * the signed one.
 */
import { app, net, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

/**
 * GitHub redirects releases/latest/download/<file> to that file in the newest
 * release that is not a draft or prerelease (.github/workflows/release.yml).
 * The DMG URL in downloadDmg() resolves against this too.
 */
const FEED_URL = 'https://github.com/paglueck/lexi/releases/latest/download/';
/** 'dmg' until the Mac build has a Developer ID signature; see above. */
const MAC_MODE = 'dmg';
/** A start-up dialog that hangs on a dead network is worse than no check at all. */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * Returns undefined where there is nothing to update: an unpackaged build
 * (`npm run desktop:dev`), unless LEXI_UPDATE_URL points it at a test feed.
 * LEXI_UPDATE_URL also overrides the feed of a packaged build, which is how a
 * release is tried against a local server before it is uploaded.
 */
export function createUpdater() {
  const override = process.env['LEXI_UPDATE_URL'];
  if (!app.isPackaged && !override) return undefined;

  const feedUrl = withSlash(override || FEED_URL);
  const mode = process.platform === 'darwin' ? MAC_MODE : 'auto';

  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  // The user decides. Nothing downloads or installs behind their back.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  // electron-updater logs to the console by default; the server's own log is
  // the warn level, so keep it in step and only hear about problems.
  autoUpdater.logger = { info() {}, debug() {}, warn: console.warn, error: console.error };

  /** @type {import('@lexi/shared').UpdateState} */
  let state = { phase: 'idle' };
  /** @type {import('electron-updater').UpdateInfo | undefined} */
  let info;
  /** The downloaded DMG, in 'dmg' mode. */
  let dmgPath;
  const listeners = new Set();

  const set = (next) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const fail = (err) =>
    set({ phase: 'error', message: err instanceof Error ? err.message : String(err) });

  autoUpdater.on('error', (err) => {
    // A check that failed is reported by check() itself; this catches the
    // download, which runs on after its promise was handed back.
    if (state.phase === 'downloading') fail(err);
  });
  autoUpdater.on('download-progress', (p) => {
    if (info !== undefined)
      set({ phase: 'downloading', version: info.version, percent: p.percent });
  });
  autoUpdater.on('update-downloaded', () => {
    if (info !== undefined)
      set({ phase: 'ready', version: info.version, releaseNotes: notesOf(info) });
  });

  return {
    mode,
    state: () => state,

    async check() {
      set({ phase: 'checking' });
      try {
        const result = await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS);
        if (result?.isUpdateAvailable) {
          info = result.updateInfo;
          set({ phase: 'available', version: info.version, releaseNotes: notesOf(info) });
        } else {
          info = undefined;
          set({ phase: 'none' });
        }
      } catch (err) {
        fail(err);
      }
    },

    async download() {
      if (info === undefined) return;
      set({ phase: 'downloading', version: info.version, percent: 0 });
      try {
        if (mode === 'auto') {
          // 'update-downloaded' moves the state on to 'ready'.
          await autoUpdater.downloadUpdate();
        } else {
          dmgPath = await downloadDmg(feedUrl, info, (percent) =>
            set({ phase: 'downloading', version: info.version, percent }),
          );
          set({ phase: 'ready', version: info.version, releaseNotes: notesOf(info) });
        }
      } catch (err) {
        fail(err);
      }
    },

    install() {
      if (mode === 'auto') {
        // Starts the installer, which waits for this process to end, then
        // quits — through main.mjs's before-quit, so the server still closes.
        // Silent, and relaunching Lexi after: the user already said yes, and
        // the assisted installer would otherwise walk them through its pages
        // again. It installs into the folder the first install chose.
        autoUpdater.quitAndInstall(true, true);
        return;
      }
      if (dmgPath === undefined) return;
      void shell.openPath(dmgPath).then((error) => {
        if (error)
          fail(
            new Error(`The update was downloaded to ${dmgPath} but could not be opened: ${error}`),
          );
        else app.quit();
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Downloads the arm64 DMG named in latest-mac.yml into userData/updates/ and
 * checks it against the sha512 there before anything opens it.
 */
async function downloadDmg(feedUrl, info, onProgress) {
  const file = info.files.find((f) => f.url.endsWith('.dmg'));
  if (file === undefined)
    throw new Error(`Release ${info.version} has no DMG among its downloads.`);

  const url = new URL(file.url, feedUrl);
  const dir = join(app.getPath('userData'), 'updates');
  // One pending update at a time; an older DMG left behind is of no use.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const target = join(dir, decodeURIComponent(url.pathname.split('/').pop() ?? 'Lexi.dmg'));

  const res = await net.fetch(url.href, { cache: 'no-store' });
  if (!res.ok || res.body === null) {
    throw new Error(`Downloading ${url.href} failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || file.size || 0;
  const hash = createHash('sha512');
  let received = 0;
  let reported = -1;
  const meter = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      // Whole percents only: every chunk would flood the SSE stream.
      if (percent !== reported) {
        reported = percent;
        onProgress(percent);
      }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(target));

  if (file.sha512 && hash.digest('base64') !== file.sha512) {
    await rm(target, { force: true });
    throw new Error('The downloaded update does not match its checksum. Try again.');
  }
  return target;
}

/** electron-builder writes release-notes.md as a string; other providers send a list. */
function notesOf(info) {
  const notes = info.releaseNotes;
  if (notes == null) return null;
  if (typeof notes === 'string') return notes.trim() || null;
  const text = notes
    .map((n) => (n.note ? `${n.version}\n${n.note}` : n.version))
    .join('\n\n')
    .trim();
  return text || null;
}

function withSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('The update server did not answer in time.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
