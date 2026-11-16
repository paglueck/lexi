// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';

import { count, relative } from '../../core/format-time.js';
import { PhraseCheckoutStore, type CheckoutMode } from '../../core/stores/phrase-checkout-store.js';
import { LxButton, LxField, LxSegmentedControl, type SegmentOption } from '../../ui/index.js';

/**
 * S18 step 2: every key of the project, or the union of one or more tags —
 * picked from a filterable list — with a preview of the first keys, and on
 * request every key of the scope, filterable and rendered a page at a time.
 */
@Component({
  selector: 'lx-step-tag',
  imports: [LxButton, LxField, LxSegmentedControl],
  template: `
    <section class="col">
      @if (store.branches().length > 0) {
        <lx-field
          class="branch"
          label="Phrase branch"
          hint="The tags, keys and locales below are read from this branch."
        >
          <select
            class="lx-input"
            aria-label="Phrase branch"
            [disabled]="store.locked()"
            (change)="pickBranch($any($event.target).value)"
          >
            <!-- [selected] per option: a [value] on the select lands before @for renders them -->
            <option value="" [selected]="store.branch() === null">Main project (no branch)</option>
            @for (row of store.branches(); track row.name) {
              <option [value]="row.name" [selected]="store.branch() === row.name">
                {{ row.name }}
              </option>
            }
          </select>
        </lx-field>
      }

      <lx-segmented-control
        class="mode"
        ariaLabel="What to check out"
        [options]="modes()"
        [value]="store.mode()"
        (valueChange)="store.setMode($event)"
      />

      @if (store.mode() === 'all') {
        <div class="panel all">
          <p class="all__text">Every key of {{ store.project()?.name }} is checked out.</p>
          <p class="all__count mono">
            {{ store.keysText() === '—' ? '—' : store.keysText() + ' keys' }}
          </p>
        </div>
      } @else {
        <div class="label-row">
          <h2 class="label">Tags</h2>
          @if (store.tags(); as tags) {
            <span class="count">{{ tags.length }} tags in {{ store.project()?.name }}</span>
          }
          <span class="count push selected">{{ store.selectedTags().length }} selected</span>
        </div>
        <div class="filter-row">
          <input
            class="filter"
            type="search"
            placeholder="Filter tags"
            aria-label="Filter tags"
            spellcheck="false"
            [value]="store.tagFilter()"
            (input)="store.setTagFilter($any($event.target).value)"
          />
          <span class="links">
            <button type="button" class="link" (click)="store.selectAllShown()">
              Select all shown
            </button>
            <button type="button" class="link" (click)="store.clearTags()">None</button>
          </span>
        </div>
        <div class="panel table">
          <div class="head" aria-hidden="true">
            <span></span><span>Tag</span><span class="num">Keys</span
            ><span class="num">Last change</span>
          </div>
          <div class="scroll" role="group" aria-label="Tags">
            @if (store.loadError(); as message) {
              <p class="empty error" role="alert">{{ message }}</p>
            } @else if (store.tags() === null) {
              @for (i of [1, 2, 3, 4]; track i) {
                <div class="row" aria-hidden="true">
                  <span></span><span class="skeleton"></span>
                </div>
              }
            } @else {
              @for (tag of store.filteredTags(); track tag.name) {
                @let on = store.isTagOn(tag.name);
                <button
                  type="button"
                  role="checkbox"
                  class="row"
                  [class.row--on]="on"
                  [attr.aria-checked]="on"
                  (click)="store.toggleTag(tag.name)"
                >
                  <span class="box" aria-hidden="true">{{ on ? '✓' : '' }}</span>
                  <span class="row__name mono">{{ tag.name }}</span>
                  <span class="row__keys mono num">{{ count(tag.keysCount) }}</span>
                  <span class="row__when num">{{ when(tag.updatedAt) }}</span>
                </button>
              } @empty {
                <p class="empty">
                  {{
                    store.tags()?.length === 0
                      ? 'This project has no tags.'
                      : 'No tag matches this filter.'
                  }}
                </p>
              }
            }
          </div>
        </div>
      }
    </section>

    <section class="col">
      <h2 class="label">Preview</h2>
      <div class="panel">
        @if (store.scope() !== null) {
          @let all = store.allKeys();
          <div class="prev__head">
            <span class="prev__title mono" [attr.title]="tagList()">{{ store.scopeLabel() }}</span>
            <span class="prev__meta">
              {{ store.keysText() }} keys
              @if (store.scopeUpdatedAt(); as at) {
                · last change {{ when(at) }}
              }
            </span>
          </div>
          @if (all?.status === 'loaded') {
            <div class="prev__filter">
              <input
                class="filter"
                type="search"
                placeholder="Filter keys"
                aria-label="Filter keys"
                spellcheck="false"
                [value]="store.keyFilter()"
                (input)="store.setKeyFilter($any($event.target).value)"
              />
            </div>
          }
          <div class="prev__cols mono" aria-hidden="true">
            <span>Key → unit id</span><span>Base text · {{ store.baseLocale() }}</span>
          </div>
          <div class="scroll">
            @if (all === null) {
              @if (store.preview(); as preview) {
                @for (row of preview.sample; track row.key) {
                  <div class="prev__row">
                    <span class="prev__key mono">{{ row.key }}</span>
                    <span class="prev__text">{{ row.text }}</span>
                  </div>
                }
              } @else if (store.previewLoading()) {
                @for (i of [1, 2, 3, 4]; track i) {
                  <div class="prev__row" aria-hidden="true">
                    <span class="skeleton"></span><span class="skeleton"></span>
                  </div>
                }
                <span class="sr-only" role="status">Loading the preview…</span>
              } @else {
                <p class="prev__more">No preview for these keys.</p>
              }
            } @else if (all.status === 'loading') {
              @for (i of [1, 2, 3, 4]; track i) {
                <div class="prev__row" aria-hidden="true">
                  <span class="skeleton"></span><span class="skeleton"></span>
                </div>
              }
              <span class="sr-only" role="status">Loading keys…</span>
            } @else if (all.status === 'error') {
              <p class="prev__more error" role="alert">
                {{ all.message }}
                <button type="button" class="link" (click)="store.showAllKeys()">Retry</button>
              </p>
            } @else {
              @for (row of store.shownKeys(); track $index) {
                <div class="prev__row">
                  <span class="prev__key mono">{{ row.key }}</span>
                  <span class="prev__text">{{ row.text }}</span>
                </div>
              } @empty {
                <p class="prev__more">
                  {{
                    all.keys.length === 0
                      ? 'No keys in this selection.'
                      : 'No key matches this filter.'
                  }}
                </p>
              }
            }
          </div>
          @if (all === null) {
            @if (canShowAll()) {
              <div class="prev__foot">
                <button lx-button type="button" size="sm" (click)="store.showAllKeys()">
                  {{ showAllLabel() }}
                </button>
              </div>
            }
          } @else {
            <div class="prev__foot">
              @if (all.status === 'loaded') {
                @if (store.moreKeys() > 0) {
                  <button lx-button type="button" size="sm" (click)="store.showMoreKeys()">
                    Show {{ count(store.moreKeys()) }} more
                  </button>
                }
                <span class="prev__shown">
                  {{ count(store.shownKeys().length) }} of {{ count(store.filteredKeys().length) }}
                </span>
              }
              <button type="button" class="link push" (click)="store.showFewerKeys()">
                Show fewer
              </button>
            </div>
          }
        } @else {
          <p class="prev__more">Pick at least one tag to see its first keys.</p>
        }
      </div>
    </section>
  `,
  styleUrls: ['./checkout-shared.css'],
  styles: `
    /*
     * Fills the content area so a long tag list or preview scrolls inside its
     * own panel, with the headers pinned, instead of stretching the page.
     */
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      gap: var(--lx-sp-20);
      max-width: 1080px;
      height: 100%;
      min-height: 0;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-10);
      min-width: 0;
      min-height: 0;
    }
    .panel {
      flex: 0 1 auto;
      min-height: 0;
    }
    /*
     * Only the two lists give way when the window is short; everything above
     * them keeps its height (a flex column shrinks every child by default,
     * which squashed the filter input).
     */
    .branch,
    .mode,
    .label-row,
    .filter-row,
    .head,
    .prev__head,
    .prev__filter,
    .prev__cols,
    .prev__foot,
    .all {
      flex-shrink: 0;
    }
    .mode {
      align-self: flex-start;
    }
    .filter-row {
      display: flex;
      gap: var(--lx-sp-12);
      align-items: center;
    }
    .links {
      display: flex;
      flex: none;
      gap: var(--lx-sp-12);
    }
    .selected {
      color: var(--lx-text-mono);
    }
    .all {
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-16);
    }
    .all__text {
      margin: 0;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
    }
    .all__count {
      margin: 0;
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12);
    }
    .scroll {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
    }
    .filter {
      box-sizing: border-box;
      flex: 1;
      min-width: 0;
      height: 34px;
      padding: 0 var(--lx-sp-12);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-titlebar);
      color: var(--lx-text-primary);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-12);
      outline: none;
    }
    .filter:focus {
      border-color: var(--lx-accent);
    }
    .table {
      overflow: hidden;
    }
    .head,
    .row {
      display: grid;
      grid-template-columns: 15px minmax(0, 1fr) 70px 100px;
      gap: var(--lx-sp-12);
      align-items: center;
    }
    .head {
      padding: var(--lx-sp-8) var(--lx-sp-14);
      border-bottom: 1px solid var(--lx-border-section);
      color: var(--lx-text-faint-2);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-10);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .row {
      width: 100%;
      padding: var(--lx-sp-10) var(--lx-sp-14);
      border: 0;
      border-bottom: 1px solid var(--lx-border-row);
      background: transparent;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover {
      background: var(--lx-bg-titlebar);
    }
    .row:focus-visible {
      outline: none;
      box-shadow: var(--lx-ring-focus);
    }
    .row--on,
    .row--on:hover {
      background: var(--lx-bg-selected);
      box-shadow: var(--lx-ring-selected);
    }
    /* The same box as step 3's locale chips. */
    .box {
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 15px;
      height: 15px;
      border: 1px solid var(--lx-neutral-border-strong);
      border-radius: var(--lx-r-4);
      color: var(--lx-accent-on);
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
    }
    .row--on .box {
      border-color: var(--lx-accent);
      background: var(--lx-accent);
    }
    .row__name {
      overflow: hidden;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-12-5);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row__keys {
      color: var(--lx-text-mono);
      font-size: var(--lx-fs-12);
    }
    .row__when {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .num {
      text-align: right;
    }
    .empty {
      margin: 0;
      padding: var(--lx-sp-18) var(--lx-sp-14);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
    .prev__head {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-4);
      padding: var(--lx-sp-14) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-section);
    }
    .prev__title {
      color: var(--lx-accent-on-tint);
      overflow: hidden;
      font-size: var(--lx-fs-14);
      font-weight: var(--lx-fw-500);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .prev__meta {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-12);
    }
    .prev__cols,
    .prev__row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--lx-sp-12);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .prev__cols {
      padding: var(--lx-sp-8) var(--lx-sp-16);
      color: var(--lx-text-faint-2);
      font-size: var(--lx-fs-10);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .prev__row {
      padding: var(--lx-sp-10) var(--lx-sp-16);
    }
    .prev__key {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11-5);
      overflow-wrap: anywhere;
    }
    .prev__text {
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-12-5);
    }
    .prev__filter {
      display: flex;
      padding: var(--lx-sp-10) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-section);
    }
    .prev__foot {
      display: flex;
      gap: var(--lx-sp-12);
      align-items: center;
      padding: var(--lx-sp-10) var(--lx-sp-16);
      border-top: 1px solid var(--lx-border-section);
    }
    .prev__shown {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .prev__more {
      margin: 0;
      padding: var(--lx-sp-10) var(--lx-sp-16);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12);
    }
  `,
})
export class LxStepTag {
  protected readonly store = inject(PhraseCheckoutStore);
  protected readonly count = count;

  /** The select's value: '' is the main project. */
  protected pickBranch(value: string): void {
    this.store.selectBranch(value === '' ? null : value);
  }

  protected readonly modes = computed<readonly SegmentOption<CheckoutMode>[]>(() => [
    { value: 'all', label: 'All keys' },
    {
      value: 'tags',
      label: 'By tag',
      // Without tags there is nothing to pick; say why instead of an empty list.
      disabled: this.store.tags()?.length === 0,
      title: this.store.tags()?.length === 0 ? 'This project has no tags.' : '',
    },
  ]);

  /** The preview title's tooltip: the picked tags, when there are several. */
  protected readonly tagList = computed(() => {
    const scope = this.store.scope();
    return scope?.kind === 'tags' && scope.tags.length > 1 ? scope.tags.join(', ') : null;
  });

  /** Whether the scope may hold more keys than the sample shows. */
  protected readonly canShowAll = computed(() => {
    const preview = this.store.preview();
    if (preview === null) return false;
    return preview.keysCount === null || preview.keysCount > preview.sample.length;
  });

  /** With the count when it is exact; "up to" or unknown says no number. */
  protected readonly showAllLabel = computed(() => {
    const { keys, exact } = this.store.scopeCount();
    return keys !== null && exact ? `Show all ${count(keys)} keys` : 'Show all keys';
  });

  protected when(iso: string | null): string {
    return relative(iso);
  }
}
