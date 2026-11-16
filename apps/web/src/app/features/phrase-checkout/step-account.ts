// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { PhraseCheckoutStore, noteOf } from '../../core/stores/phrase-checkout-store.js';

/**
 * S18 step 1: which saved token, and which of its projects. A rejected token
 * is shown but cannot be picked. Key and tag counts per project are not known
 * up front, so a row shows them once the project was loaded.
 */
@Component({
  selector: 'lx-step-account',
  imports: [RouterLink],
  template: `
    <section class="group">
      <div class="label-row">
        <h2 class="label">Access token</h2>
        <a class="link push" routerLink="/settings" [queryParams]="{ section: 'phrase' }">
          Manage tokens
        </a>
      </div>

      @if (store.tokensError(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      } @else if (store.tokensLoaded() && store.tokens().length === 0) {
        <div class="empty panel">
          <p class="empty__title">No Phrase token yet</p>
          <p class="empty__text">
            Add one in Settings › Phrase. Read access is enough for a checkout.
          </p>
          <a class="link" routerLink="/settings" [queryParams]="{ section: 'phrase' }">
            Manage tokens
          </a>
        </div>
      } @else {
        <div class="tokens" role="radiogroup" aria-label="Access token">
          @for (token of store.tokens(); track token.id) {
            @let on = token.id === store.token()?.id;
            <button
              type="button"
              role="radio"
              class="pick token"
              [class.pick--on]="on"
              [class.token--bad]="token.status === 'bad'"
              [attr.aria-checked]="on"
              [disabled]="token.status === 'bad'"
              (click)="store.selectToken(token.id)"
            >
              <span class="token__head">
                <span class="radio" [class.radio--on]="on"></span>
                <span class="token__note">{{ noteOf(token) }}</span>
              </span>
              <span class="token__meta mono">{{ meta(token.user, token.org) }}</span>
              <span class="token__foot">
                <span class="region">{{ token.region }}</span>
                @if (token.status === 'bad') {
                  <span class="bad">Rejected by Phrase (401)</span>
                } @else {
                  <span class="token__projects">
                    {{ token.projects.length }}
                    {{ token.projects.length === 1 ? 'project' : 'projects' }}
                  </span>
                }
              </span>
            </button>
          }
        </div>
      }
    </section>

    @if (store.token(); as token) {
      <section class="group">
        <h2 class="label">Project</h2>
        @if (store.loadError(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        @if (token.projects.length === 0) {
          <p class="muted small">
            This token cannot read any project. Check it again in Settings › Phrase.
          </p>
        }
        <div class="projects" role="radiogroup" aria-label="Project">
          @for (project of token.projects; track project.id) {
            @let on = project.id === store.project()?.id;
            @let detail = store.detailFor(project.id);
            @let tags = store.tagsFor(project.id);
            <button
              type="button"
              role="radio"
              class="pick project"
              [class.pick--on]="on"
              [attr.aria-checked]="on"
              (click)="store.selectProject(project.id)"
            >
              <span class="radio" [class.radio--on]="on"></span>
              <span class="project__name">{{ project.name }}</span>
              <span class="project__meta mono">
                @if (detail) {
                  {{ detail.baseLocale }} → {{ detail.locales.length - 1 }} locales
                }
              </span>
              <span class="project__keys mono">{{ project.account ?? '' }}</span>
              <span class="project__tags">
                @if (tags) {
                  {{ tags.length }} {{ tags.length === 1 ? 'tag' : 'tags' }}
                }
              </span>
            </button>
          }
        </div>
      </section>
    }
  `,
  styleUrls: ['./checkout-shared.css'],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-22);
      max-width: 900px;
    }
    .group {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-8);
    }
    .tokens {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--lx-sp-8);
    }
    .token {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-7);
      padding: var(--lx-sp-12) var(--lx-sp-14);
    }
    .token--bad {
      opacity: 0.62;
    }
    .token__head {
      display: flex;
      gap: 9px;
      align-items: flex-start;
    }
    .token__head .radio {
      margin-top: 3px;
    }
    .token__note {
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
      font-weight: var(--lx-fw-600);
      line-height: 1.4;
    }
    .token__meta {
      overflow: hidden;
      padding-left: 21px;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .token__foot {
      display: flex;
      gap: var(--lx-sp-8);
      align-items: center;
      padding-left: 21px;
      font-size: var(--lx-fs-11-5);
    }
    .token__projects {
      color: var(--lx-text-subtle);
    }
    .projects {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
    }
    .project {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr) 160px 110px 80px;
      gap: var(--lx-sp-14);
      align-items: center;
      padding: var(--lx-sp-12) var(--lx-sp-14);
    }
    .project__name {
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13-5);
      font-weight: var(--lx-fw-600);
    }
    .project__meta,
    .project__keys {
      overflow: hidden;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-11-5);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project__keys {
      text-align: right;
    }
    .project__tags {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
      text-align: right;
    }
    .empty {
      gap: var(--lx-sp-6);
      align-items: flex-start;
      padding: var(--lx-sp-16) var(--lx-sp-18);
    }
    .empty__title {
      margin: 0;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
      font-weight: var(--lx-fw-600);
    }
    .empty__text {
      margin: 0;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12-5);
    }
    .small {
      margin: 0;
      font-size: var(--lx-fs-12);
    }
  `,
})
export class LxStepAccount {
  protected readonly store = inject(PhraseCheckoutStore);
  protected readonly noteOf = noteOf;

  protected meta(user: string, org: string): string {
    return [user, org].filter((s) => s !== '').join(' · ') || 'Not checked yet';
  }
}
