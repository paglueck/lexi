// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { UpdateMode, UpdateState } from '@lexi/shared';

/**
 * The desktop shell's updater, as the server sees it.
 *
 * Deliberately narrow, and deliberately not Electron: the shell builds it on
 * electron-updater and hands it to `startServer`, and the server only forwards
 * calls and state. That keeps the renderer an ordinary web client — no
 * preload, no IPC — and lets the routes be tested with a fake.
 *
 * None of the methods is expected to throw. A failed check or download is a
 * state (`error`), reported through `onChange` like every other.
 */
export interface Updater {
  readonly mode: UpdateMode;
  state(): UpdateState;
  /** Resolves once the check has settled into `none`, `available` or `error`. */
  check(): Promise<void>;
  /** Starts the download. Progress arrives through `onChange`. */
  download(): Promise<void>;
  /** Quits Lexi into the installer (`auto`) or opens the downloaded DMG and quits (`dmg`). */
  install(): void;
  /** Returns the unsubscribe function. */
  onChange(listener: (state: UpdateState) => void): () => void;
}
