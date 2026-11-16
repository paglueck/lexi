// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, effect, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import type {
  PhraseBranchesResponse,
  PhrasePushFileResult,
  PhrasePushResponse,
  PhraseStatus,
  PhraseStatusFile,
} from '@lexi/shared';

import { PhraseApi } from '../../core/api/phrase-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { EventsStore } from '../../core/stores/events-store.js';
import { LxButton } from '../../ui/button.js';
import { LxField } from '../../ui/field.js';
import { LxModalShell } from '../../ui/modal.js';
import { LxPhraseConnect } from './phrase-connect.js';

/** Phrase's upload summary keys, in the words the result list uses. */
const SUMMARY_LABEL: ReadonlyArray<readonly [key: string, one: string, many: string]> = [
  ['translation_keys_created', 'key created', 'keys created'],
  ['translation_keys_updated', 'key updated', 'keys updated'],
  ['translations_created', 'translation created', 'translations created'],
  ['translations_updated', 'translation updated', 'translations updated'],
  ['translation_keys_unmentioned', 'key not in the file', 'keys not in the file'],
];

/**
 * The Phrase locale a file goes to, as a person reads it: "de → Developer-German (de)",
 * or just the locale when the config already names it by id.
 */
export function targetLabel(file: PhraseStatusFile): string {
  const t = file.target;
  if (t === null) return file.localeId;
  const name = t.name === t.code ? t.name : `${t.name} (${t.code})`;
  return file.localeId === t.id ? name : `${file.localeId} → ${name}`;
}

/** `.phrase.yml` already uploads every file with `verify_mentioned_translations: true`. */
export function configVerifies(status: PhraseStatus): boolean {
  return (
    status.files.length > 0 &&
    status.files.every((f) => f.params['verify_mentioned_translations'] === true)
  );
}

/** "1 key created · 5 translations updated", leaving out the zeros. */
export function summarise(result: PhrasePushFileResult): string {
  const parts = SUMMARY_LABEL.flatMap(([key, one, many]) => {
    const n = result.summary[key] ?? 0;
    return n > 0 ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  return parts.length > 0 ? parts.join(' · ') : 'no changes';
}

type Stage = 'pending' | 'uploading' | 'processing' | 'done' | 'failed';

const MARK: Record<Stage, string> = {
  pending: '·',
  uploading: '↑',
  processing: '…',
  done: '✓',
  failed: '×',
};

/**
 * "Push to Phrase" — upload what `.phrase.yml` names, as `phrase push` would.
 *
 * The push is of the FILES, so unsaved drafts are not in it. Rather than let
 * the server's refusal be the first the user hears of that, the dialog says so
 * up front and offers "Save & push". Progress comes over SSE per file; the
 * result list stays open afterwards so a failure can be read, not just seen.
 *
 * Each file shows the Phrase locale it goes to. The push is refused (by the
 * server, and the button here) unless every file resolves to exactly one
 * existing locale — a push must never create one. Locale ids given as codes
 * can be pinned to Phrase ids in `.phrase.yml` with one click.
 *
 * When the Phrase project has branches, a picker chooses where the push goes:
 * the main project or one of the open branches (creating one is Phrase's job).
 * It starts on the branch `.phrase.yml` names, if any.
 *
 * "Mark as verified" sends `verify_mentioned_translations` with every upload,
 * so the uploaded translations land verified in Phrase. It starts checked when
 * `.phrase.yml` already sets that on every source.
 *
 * While a push runs the dialog cannot be dismissed — not by the backdrop,
 * Escape or the close button. The footer's button cancels the push instead:
 * the server uploads no further file, and the result says which got through.
 *
 * Without a config the dialog is the connect step first.
 */
@Component({
  selector: 'lx-phrase-push-dialog',
  imports: [LxButton, LxField, LxModalShell, LxPhraseConnect],
  styleUrl: './phrase.css',
  template: `
    <lx-modal-shell title="Push to Phrase" [subtitle]="subtitle()" [closable]="!busy()">
      @if (loading()) {
        <p class="lead">Checking the Phrase configuration…</p>
      } @else if (status(); as s) {
        @if (s.configFile === null) {
          <lx-phrase-connect continueLabel="Continue to push" (finished)="onConnected($event)" />
        } @else {
          @if (unsaved() > 0 && result() === null) {
            <p class="callout" data-tone="warn" role="status">
              {{ unsaved() }} unsaved {{ unsaved() === 1 ? 'change is' : 'changes are' }} not in the
              files yet. A push uploads the files, so save first.
            </p>
          }

          @if (s.problems.length > 0) {
            <div class="callout" data-tone="warn" role="status">
              <ul class="problems">
                @for (problem of s.problems; track problem) {
                  <li>{{ problem }}</li>
                }
              </ul>
            </div>
          }

          @if (s.unpinned > 0 && result() === null) {
            <div class="callout" role="status">
              {{ s.unpinned }}
              {{ s.unpinned === 1 ? 'source names its' : 'sources name their' }} Phrase locale by
              code or name. Pin the locale ids in {{ s.configFile }} so the Phrase CLI and CI use
              exactly these locales too.
              <button
                type="button"
                lx-button
                size="field"
                [disabled]="pinning() || busy()"
                (click)="pin()"
              >
                {{ pinning() ? 'Pinning…' : 'Pin locale ids' }}
              </button>
            </div>
          }

          @if (branches(); as b) {
            @if (b.branches.length > 0) {
              <lx-field label="Phrase branch">
                <select
                  class="lx-input picker"
                  aria-label="Phrase branch"
                  [disabled]="busy() || result() !== null"
                  (change)="pickBranch($any($event.target).value)"
                >
                  <!-- [selected] per option: a [value] on the select lands before @for renders them -->
                  <option value="" [selected]="branch() === ''">Main project (no branch)</option>
                  @for (row of b.branches; track row.name) {
                    <option [value]="row.name" [selected]="branch() === row.name">
                      {{ row.name }}
                    </option>
                  }
                </select>
              </lx-field>
            }
            @if (missingConfigured(); as name) {
              <p class="callout" data-tone="warn" role="status">
                .phrase.yml pushes to the branch "{{ name }}", which Phrase does not list as open.
                Pick a branch, or push to the main project.
              </p>
            }
          } @else if (branchesFailed(); as message) {
            <p class="lead">
              Could not list the Phrase branches ({{ message }}). The push goes where
              {{ s.configFile }} says.
            </p>
          }

          @if (s.files.length > 0) {
            <label class="check">
              <input
                type="checkbox"
                [checked]="verify()"
                [disabled]="busy() || result() !== null"
                (change)="verify.set($any($event.target).checked)"
              />
              <span>
                Mark uploaded translations as verified
                <span class="check__hint">
                  Phrase otherwise leaves updated translations unverified.
                </span>
              </span>
            </label>
          }

          @if (checking()) {
            <p class="lead" role="status">
              Checking the locales on {{ branch() ? 'branch ' + branch() : 'the main project' }}…
            </p>
          }

          @if (s.files.length > 0) {
            <ul class="files" aria-label="Files to push">
              @for (file of s.files; track $index) {
                @let stage = stageOf($index);
                @let done = resultOf($index);
                <li class="file" [attr.data-state]="stage">
                  <span class="file__mark" aria-hidden="true">{{ MARK[stage] }}</span>
                  <span class="file__path lx-mono">{{ file.relPath }}</span>
                  <span class="file__meta lx-mono">
                    {{ targetLabel(file) }}
                    @if (done?.ok) {
                      · {{ summarise(done!) }}
                    }
                  </span>
                  @if (done?.error; as message) {
                    <span class="file__error">{{ message }}</span>
                  }
                </li>
              }
            </ul>
          }

          @if (result(); as r) {
            <p class="callout" [attr.data-tone]="r.ok ? 'ok' : 'bad'" role="status">
              @if (r.cancelled) {
                Push cancelled. {{ r.results.length - failedCount() }} of {{ r.results.length }}
                {{ r.results.length === 1 ? 'file' : 'files' }} pushed.
              } @else if (r.ok) {
                Pushed {{ r.results.length }} {{ r.results.length === 1 ? 'file' : 'files' }} to
                {{ s.projectName ?? s.projectId }}{{ r.branch ? ' · branch ' + r.branch : '' }}.
              } @else {
                {{ failedCount() }} of {{ r.results.length }} files failed. The others were pushed.
              }
            </p>
            @if (r.createdLocales.length > 0) {
              <div class="callout" data-tone="bad" role="alert">
                <ul class="problems">
                  @for (line of r.createdLocales; track line) {
                    <li>{{ line }}</li>
                  }
                </ul>
              </div>
            }
          }
        }
      }

      @if (error(); as message) {
        <p class="callout" data-tone="bad" role="alert">{{ message }}</p>
      }

      <span modal-footer class="lx-spacer"></span>
      @if (busy()) {
        <button
          type="button"
          modal-footer
          lx-button
          size="field"
          [disabled]="cancelling()"
          (click)="cancel()"
        >
          {{ cancelling() ? 'Cancelling…' : 'Cancel push' }}
        </button>
      } @else {
        <button type="button" modal-footer lx-button size="field" (click)="ref.close()">
          {{ result() === null ? 'Cancel' : 'Close' }}
        </button>
      }
      @if (status()?.configFile && result() === null) {
        <button
          type="button"
          modal-footer
          lx-button
          variant="primary"
          size="field"
          [disabled]="!canPush()"
          (click)="push()"
        >
          {{ busy() ? 'Pushing…' : unsaved() > 0 ? 'Save & push' : 'Push' }}
        </button>
      }
    </lx-modal-shell>
  `,
})
export class LxPhrasePushDialog {
  protected readonly ref = inject<DialogRef<PhrasePushResponse, LxPhrasePushDialog>>(DialogRef);
  readonly #api = inject(PhraseApi);
  readonly #drafts = inject(DraftStore);
  readonly #events = inject(EventsStore);

  protected readonly MARK = MARK;
  protected readonly summarise = summarise;
  protected readonly targetLabel = targetLabel;
  protected readonly pinning = signal(false);
  /** The status is being read again for the picked branch. */
  protected readonly checking = signal(false);
  /** Only the answer to the latest status request is kept. */
  #statusTicket = 0;

  protected readonly status = signal<PhraseStatus | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  /** Cancel was asked for; the push request answers once the server has stopped. */
  protected readonly cancelling = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<PhrasePushResponse | null>(null);
  /** Null until listed; stays null when listing failed. */
  protected readonly branches = signal<PhraseBranchesResponse | null>(null);
  protected readonly branchesFailed = signal<string | null>(null);
  /** The picked branch; '' is the main project. */
  protected readonly branch = signal('');
  /** Upload with `verify_mentioned_translations`; starts as the config says. */
  protected readonly verify = signal(false);

  protected readonly unsaved = this.#drafts.count;

  protected readonly subtitle = computed(() => {
    const s = this.status();
    if (s?.configFile == null) return '';
    const branch = this.branch();
    return `${s.configFile} · ${s.projectName ?? s.projectId ?? ''}${branch ? ` · ${branch}` : ''}`;
  });

  /** The config's branch when Phrase does not list it as open. */
  protected readonly missingConfigured = computed(() => {
    const b = this.branches();
    if (b?.configured == null) return null;
    return b.branches.some((row) => row.name === b.configured) ? null : b.configured;
  });

  /** Every file has exactly one Phrase locale to go to — otherwise the server refuses anyway. */
  protected readonly canPush = computed(() => {
    const s = this.status();
    return (
      !this.busy() &&
      !this.pinning() &&
      !this.checking() &&
      s !== null &&
      s.files.length > 0 &&
      s.tokenSource != null &&
      s.files.every((f) => f.target !== null)
    );
  });

  protected readonly failedCount = computed(
    () => this.result()?.results.filter((r) => !r.ok).length ?? 0,
  );

  constructor() {
    // Backdrop and Escape: CDK reads this on every attempt, so it can follow the push.
    effect(() => {
      this.ref.disableClose = this.busy();
    });
    void this.#load();
  }

  protected stageOf(index: number): Stage {
    const done = this.result()?.results[index];
    if (done !== undefined) return done.ok ? 'done' : 'failed';
    if (!this.busy()) return 'pending';
    return this.#events.phrasePush().get(index)?.stage ?? 'pending';
  }

  protected resultOf(index: number): PhrasePushFileResult | undefined {
    return this.result()?.results[index];
  }

  protected async onConnected(connected: boolean): Promise<void> {
    if (!connected) {
      this.ref.close();
      return;
    }
    this.loading.set(true);
    await this.#load();
  }

  protected async push(): Promise<void> {
    if (!this.canPush()) return;
    this.busy.set(true);
    this.cancelling.set(false);
    this.error.set(null);
    this.#events.clearPhrasePush();
    try {
      if (this.unsaved() > 0 && !(await this.#drafts.saveAll())) {
        this.error.set(this.#drafts.error() ?? 'Saving failed, so nothing was pushed.');
        return;
      }
      // Cancelled while saving: the push never started.
      if (this.cancelling()) return;
      // Before the branches are listed nothing was picked, so the config decides.
      const branch = this.branches() === null ? undefined : this.branch() || null;
      this.result.set(await this.#api.push(branch, this.verify()));
    } catch (error) {
      this.error.set(messageOf(error, 'The push failed.'));
    } finally {
      this.busy.set(false);
      this.cancelling.set(false);
    }
  }

  /** Asks the server to stop; the push's own answer then ends the busy state. */
  protected async cancel(): Promise<void> {
    if (!this.busy() || this.cancelling()) return;
    this.cancelling.set(true);
    try {
      await this.#api.cancelPush();
    } catch (error) {
      this.cancelling.set(false);
      this.error.set(messageOf(error, 'Could not cancel the push.'));
    }
  }

  protected async pin(): Promise<void> {
    this.pinning.set(true);
    this.error.set(null);
    try {
      const answer = await this.#api.pinLocales();
      if (answer.problems.length > 0) {
        this.error.set(`Nothing was pinned. ${answer.problems.join(' ')}`);
        return;
      }
      await this.#refreshStatus();
    } catch (error) {
      this.error.set(messageOf(error, 'Pinning the locale ids failed.'));
    } finally {
      this.pinning.set(false);
    }
  }

  /** A branch was picked: its locales decide what the files go to, and whether a push may start. */
  protected async pickBranch(name: string): Promise<void> {
    this.branch.set(name);
    await this.#refreshStatus();
  }

  /**
   * The status again, checked where the push will go: the picked branch (or
   * the main project) once the branches are listed, else the config's say.
   */
  async #refreshStatus(): Promise<void> {
    const ticket = ++this.#statusTicket;
    this.checking.set(true);
    try {
      const status = await this.#api.status(
        this.branches() === null ? undefined : this.branch() || null,
      );
      if (ticket === this.#statusTicket) this.status.set(status);
    } catch (error) {
      if (ticket === this.#statusTicket) {
        this.error.set(messageOf(error, 'Could not check the Phrase locales.'));
      }
    } finally {
      if (ticket === this.#statusTicket) this.checking.set(false);
    }
  }

  async #load(): Promise<void> {
    try {
      const status = await this.#api.status();
      this.status.set(status);
      this.verify.set(configVerifies(status));
      if (status.configFile !== null && status.projectId !== null && status.tokenSource !== null) {
        void this.#loadBranches();
      }
    } catch (error) {
      this.error.set(messageOf(error, 'Could not read the Phrase configuration.'));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * In the background: until the list is in, the push goes where the config
   * says. A config branch Phrase no longer lists is not preselected — the warning says so.
   */
  async #loadBranches(): Promise<void> {
    this.branchesFailed.set(null);
    try {
      const listed = await this.#api.branches();
      this.branches.set(listed);
      const configured = listed.configured;
      if (configured !== null && listed.branches.some((b) => b.name === configured)) {
        if (!this.busy() && this.result() === null) this.branch.set(configured);
      }
      // Checked again where the push will now go, which may not be where the config said.
      if (listed.branches.length > 0 || configured !== null) await this.#refreshStatus();
    } catch (error) {
      this.branchesFailed.set(messageOf(error, 'unknown error'));
    }
  }
}

/** "Connect to Phrase…" from the project menu: the wizard step, in a modal. */
@Component({
  selector: 'lx-phrase-connect-modal',
  imports: [LxModalShell, LxPhraseConnect],
  template: `
    <lx-modal-shell title="Connect to Phrase">
      <lx-phrase-connect continueLabel="Done" (finished)="ref.close($event)" />
    </lx-modal-shell>
  `,
})
export class LxPhraseConnectModal {
  protected readonly ref = inject<DialogRef<boolean, LxPhraseConnectModal>>(DialogRef);
}
