// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PhraseProjectSummary, PhraseStatus } from '@lexi/shared';

import { PhraseApi } from '../../core/api/phrase-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { LxButton } from '../../ui/button.js';
import { LxField } from '../../ui/field.js';

/**
 * Connect the open project to a Phrase project — optional, and offered once:
 * as the last step of the first-open wizard, and later from the project menu.
 *
 * Two cases, because a repository either already has a `.phrase.yml` or it
 * does not:
 *
 * - **It has one.** Nothing is written. The step shows what the config resolves
 *   to — which files go to which locale — and anything that would make a push
 *   fail, so the problem surfaces here rather than at the first push.
 * - **It has none.** With a token, the user picks a Phrase project and lexi
 *   writes a `.phrase.yml` from the confirmed locale mapping, without the token.
 *
 * "Skip" is always there: Phrase is optional, and lexi works without it.
 */
@Component({
  selector: 'lx-phrase-connect',
  imports: [LxButton, LxField, RouterLink],
  styleUrl: './phrase.css',
  template: `
    @if (loading()) {
      <p class="lead">Checking the Phrase configuration…</p>
    } @else if (status(); as s) {
      @if (s.configFile !== null) {
        <p class="lead">
          This project already has a <code class="lx-mono">{{ s.configFile }}</code
          >. Lexi pushes with it exactly as <code class="lx-mono">phrase push</code> would.
        </p>
        <dl class="meta">
          <dt>Phrase project</dt>
          <dd>
            {{ s.projectName ?? s.projectId ?? '—' }}
            @if (s.projectName !== null) {
              <span class="file__meta lx-mono">{{ s.projectId }}</span>
            }
          </dd>
          <dt>Host</dt>
          <dd class="lx-mono">{{ s.host }}</dd>
        </dl>
        @if (s.files.length > 0) {
          <ul class="files" aria-label="Files a push uploads">
            @for (file of s.files; track file.relPath + file.localeId) {
              <li class="file">
                <span class="file__mark" aria-hidden="true">↑</span>
                <span class="file__path lx-mono">{{ file.relPath }}</span>
                <span class="file__meta lx-mono">{{ file.localeId }}</span>
              </li>
            }
          </ul>
        }
      } @else {
        <p class="lead">
          Pick the Phrase project this repository belongs to. Lexi writes a
          <code class="lx-mono">.phrase.yml</code> next to your files with one push source per
          locale file — commit it, and the Phrase CLI can use it too. The token is not written into
          it.
        </p>
      }

      @if (s.tokenSource === null) {
        <p class="lead">
          Lexi needs a Phrase access token. Add one in
          <a routerLink="/settings" [queryParams]="{ section: 'phrase' }">Settings › Phrase</a>,
          then come back here.
        </p>
      } @else if (s.tokenSource !== 'settings') {
        <p class="lead">
          Using the token from
          {{ s.tokenSource === 'env' ? 'PHRASE_ACCESS_TOKEN' : s.configFile }}.
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

      @if (s.configFile === null && s.tokenSource !== null) {
        @if (projects(); as list) {
          @if (list.length === 0) {
            <p class="callout">This token cannot see any Phrase project.</p>
          } @else {
            <lx-field label="Phrase project">
              <select
                class="lx-input picker"
                [value]="projectId()"
                (change)="projectId.set($any($event.target).value)"
              >
                <option value="">Choose a project…</option>
                @for (p of list; track p.id) {
                  <option [value]="p.id">
                    {{ p.name }}{{ p.account ? ' · ' + p.account : '' }}
                  </option>
                }
              </select>
            </lx-field>
            <ul class="files" aria-label="Push sources that will be written">
              @for (row of mapping(); track row.relPath) {
                <li class="file">
                  <span class="file__mark" aria-hidden="true">↑</span>
                  <span class="file__path lx-mono">{{ row.relPath }}</span>
                  <span class="file__meta lx-mono">{{ row.locale }}</span>
                </li>
              }
            </ul>
          }
        } @else if (!projectsFailed()) {
          <p class="lead">Loading your Phrase projects…</p>
        }
      }
    }

    @if (error(); as message) {
      <p class="callout" data-tone="bad" role="alert">{{ message }}</p>
    }

    <div class="actions">
      <button type="button" lx-button size="field" (click)="finished.emit(connected())">
        {{ connected() ? 'Close' : 'Skip' }}
      </button>
      @if (status()?.configFile === null) {
        <button
          type="button"
          lx-button
          variant="primary"
          size="field"
          [disabled]="projectId() === '' || busy()"
          (click)="connect()"
        >
          {{ busy() ? 'Writing…' : 'Create .phrase.yml' }}
        </button>
      } @else if (status() !== null) {
        <button
          type="button"
          lx-button
          variant="primary"
          size="field"
          (click)="finished.emit(true)"
        >
          {{ continueLabel() }}
        </button>
      }
    </div>
  `,
})
export class LxPhraseConnect {
  readonly #api = inject(PhraseApi);
  readonly #project = inject(ProjectStore);

  /** The primary button's text once connected: "Continue" in the wizard, "Done" elsewhere. */
  readonly continueLabel = input('Continue');
  /** True when the project is connected (a config exists), false when skipped. */
  readonly finished = output<boolean>();

  protected readonly status = signal<PhraseStatus | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly projects = signal<readonly PhraseProjectSummary[] | null>(null);
  protected readonly projectsFailed = signal(false);
  protected readonly projectId = signal('');

  protected readonly connected = computed(() => (this.status()?.configFile ?? null) !== null);

  /** What `.phrase.yml` will name, from the mapping the user confirmed. */
  protected readonly mapping = computed(() =>
    this.#project
      .files()
      .flatMap((f) => (f.locale === null ? [] : [{ relPath: f.relPath, locale: f.locale }]))
      .sort((a, b) => a.relPath.localeCompare(b.relPath)),
  );

  constructor() {
    void this.refresh();
  }

  /** Re-read the status — on open, and after a token was stored or removed. */
  async refresh(): Promise<void> {
    this.error.set(null);
    try {
      const status = await this.#api.status();
      this.status.set(status);
      if (status.configFile === null && status.tokenSource !== null) await this.#loadProjects();
    } catch (error) {
      this.error.set(messageOf(error, 'Could not read the Phrase configuration.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async connect(): Promise<void> {
    const projectId = this.projectId();
    if (projectId === '' || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.#api.connect(projectId);
      // Re-read rather than keep the connect answer: it also names the project
      // and checks its locales, which is what tells the user the push will work.
      await this.refresh();
    } catch (error) {
      this.error.set(messageOf(error, 'Could not write .phrase.yml.'));
    } finally {
      this.busy.set(false);
    }
  }

  async #loadProjects(): Promise<void> {
    this.projectsFailed.set(false);
    try {
      this.projects.set((await this.#api.projects()).projects);
    } catch (error) {
      this.projects.set(null);
      this.projectsFailed.set(true);
      this.error.set(messageOf(error, 'Could not list the Phrase projects.'));
    }
  }
}
