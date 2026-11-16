// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Injector,
} from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';

import { ToastStore } from '../../core/stores/toast-store.js';
import { UpdateStore } from '../../core/stores/update-store.js';
import { LxButton } from '../../ui/button.js';
import { LxModalService, LxModalShell } from '../../ui/modal.js';

export interface UpdateDialogData {
  /**
   * `startup` checks first and closes by itself when there is nothing to
   * offer. `download` is Settings → Updates' "Update now": the user has seen
   * the notes there already, so it goes straight to the download.
   */
  readonly start: 'startup' | 'download';
}

/**
 * How long the start-up check stays on screen at least, and how long "up to
 * date" stays after it. A check usually answers in a few hundred milliseconds;
 * without these the dialog only flickers, and nobody can tell what it was.
 */
export const MIN_CHECK_MS = 1200;
export const UP_TO_DATE_MS = 1500;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The update dialog: the check at start-up, the offer, the download, the
 * install.
 *
 * Opened with `disableClose` and `closeOnNavigation: false`, so it holds the
 * app until it is answered: nothing can be edited behind a check, and nothing
 * behind a download that is about to quit the app. The shell's close button
 * only appears where leaving is a real answer — the offer ("Skip for now")
 * and a failure.
 *
 * Skipping is not stored. The next start asks again.
 */
@Component({
  selector: 'lx-update-dialog',
  imports: [LxButton, LxModalShell],
  template: `
    @let s = view();
    <lx-modal-shell [title]="title()" [subtitle]="subtitle()" size="sm" [closable]="closable()">
      @switch (s.phase) {
        @case ('available') {
          <p class="body">
            Lexi {{ s.version }} is available. You are using {{ store.currentVersion() }}.
          </p>
          @if (s.releaseNotes) {
            <h3 class="caption">What's new</h3>
            <pre class="notes">{{ s.releaseNotes }}</pre>
          }
          @if (mac()) {
            <p class="hint">
              Lexi downloads the new version and opens it. Drag Lexi into Applications to finish.
            </p>
          }
        }
        @case ('downloading') {
          <p class="body" role="status">Downloading Lexi {{ s.version }}… {{ percent() }} %</p>
          <div
            class="track"
            role="progressbar"
            aria-label="Download progress"
            [attr.aria-valuenow]="percent()"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span class="fill" [style.width.%]="percent()"></span>
          </div>
        }
        @case ('ready') {
          @if (mac()) {
            <p class="body">
              Lexi {{ s.version }} has been downloaded. Lexi opens the disk image and quits.
            </p>
            <p class="body">
              Drag Lexi into the Applications folder and replace the old version, then start it
              again.
            </p>
          } @else {
            <p class="body" role="status">
              Installing Lexi {{ s.version }}. Lexi restarts by itself.
            </p>
          }
        }
        @case ('none') {
          <p class="body" role="status">
            You are using the latest version, Lexi {{ store.currentVersion() }}.
          </p>
        }
        @case ('error') {
          <p class="body" role="alert">{{ s.message }}</p>
        }
        @default {
          <p class="body" role="status">Checking for updates…</p>
          <div class="track track--busy" aria-hidden="true"><span class="fill"></span></div>
        }
      }

      <!-- One projected container: a node inside @switch cannot reach the
           footer slot on its own. -->
      <ng-container modal-footer>
        @switch (s.phase) {
          @case ('available') {
            <button type="button" lx-button size="field" (click)="ref.close()">Skip for now</button>
            <button type="button" lx-button variant="primary" size="field" (click)="download()">
              Update now
            </button>
          }
          @case ('ready') {
            @if (mac()) {
              <button type="button" lx-button variant="primary" size="field" (click)="install()">
                Open and quit
              </button>
            }
          }
          @case ('error') {
            <button type="button" lx-button size="field" (click)="ref.close()">Close</button>
            <button type="button" lx-button variant="primary" size="field" (click)="retry()">
              Try again
            </button>
          }
        }
      </ng-container>
    </lx-modal-shell>
  `,
  styles: `
    .body,
    .hint {
      margin: 0 0 var(--lx-sp-10);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
    }
    .hint {
      margin: var(--lx-sp-12) 0 0;
      color: var(--lx-text-subtle);
    }
    .caption {
      margin: var(--lx-sp-14) 0 var(--lx-sp-6);
      font-size: var(--lx-fs-12);
      font-weight: var(--lx-fw-600);
      color: var(--lx-text-primary);
    }
    /* Text, never HTML: the notes come from the update server, and this keeps
       them from being anything but words on the page. */
    .notes {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      padding: var(--lx-sp-10) var(--lx-sp-12);
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-6);
      font-family: var(--lx-font-ui);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
      color: var(--lx-text-secondary);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .track {
      position: relative;
      height: 6px;
      border-radius: var(--lx-r-3);
      overflow: hidden;
      background: var(--lx-neutral-track-soft);
    }
    .fill {
      display: block;
      height: 100%;
      background: var(--lx-accent-bar);
      transition: width 0.2s ease-out;
    }
    .track--busy .fill {
      position: absolute;
      width: 30%;
      animation: lx-update-busy 1.2s ease-in-out infinite alternate;
    }
    @keyframes lx-update-busy {
      from {
        left: 0;
      }
      to {
        left: 70%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .track--busy .fill {
        animation: none;
        left: 35%;
      }
    }
  `,
})
export class LxUpdateDialog {
  protected readonly ref = inject<DialogRef<void, LxUpdateDialog>>(DialogRef);
  protected readonly data = inject<UpdateDialogData>(DIALOG_DATA);
  protected readonly store = inject(UpdateStore);
  readonly #toasts = inject(ToastStore);

  protected readonly state = this.store.state;
  /** Set while the start-up check is held on screen; see `MIN_CHECK_MS`. */
  readonly #holding = signal(false);
  /** What the dialog shows: the state, except that a quick answer waits its turn. */
  protected readonly view = computed(() => {
    const s = this.state();
    return this.#holding() && (s.phase === 'none' || s.phase === 'error')
      ? ({ phase: 'checking' } as const)
      : s;
  });
  protected readonly mac = computed(() => this.store.mode() === 'dmg');
  protected readonly percent = computed(() => {
    const s = this.state();
    return s.phase === 'downloading' ? Math.round(s.percent) : 0;
  });
  protected readonly closable = computed(() => {
    const phase = this.view().phase;
    return phase === 'available' || phase === 'none' || phase === 'error';
  });
  protected readonly title = computed(() => {
    switch (this.view().phase) {
      case 'none':
        return 'Lexi is up to date';
      case 'available':
        return 'Update available';
      case 'downloading':
        return 'Downloading update';
      case 'ready':
        return this.mac() ? 'Update downloaded' : 'Installing update';
      case 'error':
        return 'Update failed';
      default:
        return 'Checking for updates';
    }
  });
  protected readonly subtitle = computed(() => {
    const s = this.view();
    return 'version' in s ? `${this.store.currentVersion()} → ${s.version}` : '';
  });

  constructor() {
    // Windows installs as soon as the download is in: "Update now" already
    // was the user's yes. The Mac waits for a click, because what happens next
    // — a disk image, a drag into Applications — needs reading first.
    effect(() => {
      if (this.state().phase === 'ready' && !this.mac()) untracked(() => void this.store.install());
    });

    if (this.data.start === 'startup') void this.#startupCheck();
    else void this.store.download();
  }

  protected download(): void {
    void this.store.download();
  }

  protected install(): void {
    void this.store.install();
  }

  protected retry(): void {
    // A failed download is retried through a fresh check as well: the server
    // only downloads what a check has just offered.
    void this.store.check().then((state) => {
      if (state.phase === 'none') void this.#closeWhenRead();
    });
  }

  /**
   * Nothing to offer: say so briefly, then get out of the way. No answer: get
   * out of the way, with a short word in a toast.
   */
  async #startupCheck(): Promise<void> {
    this.#holding.set(true);
    const [state] = await Promise.all([this.store.check(), wait(MIN_CHECK_MS)]);
    this.#holding.set(false);
    if (state.phase === 'none') {
      await this.#closeWhenRead();
    } else if (state.phase === 'error') {
      this.ref.close();
      this.#toasts.show({
        tone: 'warn',
        title: 'Could not check for updates',
        detail: state.message,
        action: { label: 'Try again', route: '/settings', queryParams: { section: 'updates' } },
      });
    }
  }

  /** Leaves "up to date" up long enough to be read; the close button can be quicker. */
  async #closeWhenRead(): Promise<void> {
    await wait(UP_TO_DATE_MS);
    this.ref.close();
  }
}

/** Opens the dialog with the settings it depends on; see `LxUpdateDialog`. */
export function openUpdateDialog(
  modal: LxModalService,
  start: UpdateDialogData['start'],
): DialogRef<void, LxUpdateDialog> {
  return modal.open<LxUpdateDialog, void>(LxUpdateDialog, {
    data: { start } satisfies UpdateDialogData,
    disableClose: true,
    closeOnNavigation: false,
  });
}

/**
 * Per window session: a reload (⌘R, View → Reload) keeps it, a new start of
 * the app does not. A reload is not a start, so it does not ask again.
 */
const CHECKED_KEY = 'lexi.update.checkedAtStartup';

/**
 * App's start-up check: ask the server whether there is an updater at all,
 * and if there is, open the dialog, which runs the check itself.
 */
export async function checkForUpdatesAtStartup(injector: Injector): Promise<void> {
  const status = await injector.get(UpdateStore).load();
  if (!status?.supported || alreadyChecked()) return;
  openUpdateDialog(injector.get(LxModalService), 'startup');
}

function alreadyChecked(): boolean {
  try {
    if (sessionStorage.getItem(CHECKED_KEY) !== null) return true;
    sessionStorage.setItem(CHECKED_KEY, '1');
  } catch {
    // Storage refused: asking once per reload is the harmless fallback.
  }
  return false;
}
