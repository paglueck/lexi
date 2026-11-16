// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject } from '@angular/core';
import { GRID_FILTERS, UNAVAILABLE_FILTERS } from '@lexi/shared/constants';
import type { GridFilter } from '@lexi/shared';

import { LxCheckboxRow } from '../../ui/checkbox-row.js';
import { LxSearchField } from '../../ui/field.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { UnitsStore } from '../../core/stores/units-store.js';

/** The rail's labels. The only user-visible strings here, kept in the template's reach. */
export const FILTER_LABEL: Record<GridFilter, string> = {
  untranslated: 'Untranslated',
  needsReview: 'Needs review',
  machineDrafts: 'Machine drafts',
  toReview: 'Needs a look',
  hasErrors: 'Has validation errors',
  stale: 'Stale source',
  noNote: 'No note',
  icuOnly: 'ICU units only',
};

/**
 * S4's 244 px left rail: search, the files-and-namespaces tree, and the filters.
 *
 * Two things worth not undoing:
 *
 * - THE COUNTS COME FROM THE FACETS, in the same response as the ids. One round
 *   trip, never one per filter.
 * - A FILTER WITH NO DATA IS DISABLED, NOT FAKED. `machineDrafts` has no source
 *   until the LLM milestones write machine origin, so it renders greyed with a
 *   caption instead of showing a zero that would read as "none found". This is
 *   the same call M4 made for S1's environment panel: a plausible number nobody
 *   can stand behind is worse than an honest gap.
 */
@Component({
  selector: 'lx-grid-rail',
  imports: [LxSearchField, LxCheckboxRow],
  template: `
    <div class="search">
      <lx-search-field
        [value]="grid.searchInput()"
        (valueChange)="grid.setSearch($event)"
        placeholder="Search keys, text, notes"
      />
    </div>

    <section class="group">
      <span class="lx-caption">Files &amp; namespaces</span>
      <button
        type="button"
        class="tree-row"
        [attr.data-active]="grid.groups().length === 0 ? 'true' : null"
        [attr.aria-pressed]="grid.groups().length === 0"
        (click)="grid.clearGroups()"
      >
        <span class="lx-truncate">All files</span>
        <span class="count lx-mono lx-num">{{ units.scopeTotal() }}</span>
      </button>
      @for (g of groups(); track g.name) {
        <button
          type="button"
          class="tree-row indent"
          [attr.data-active]="grid.groups().includes(g.name) ? 'true' : null"
          [attr.aria-pressed]="grid.groups().includes(g.name)"
          (click)="grid.toggleGroup(g.name)"
        >
          <span class="lx-truncate">{{ g.label }}</span>
          <span class="count lx-mono lx-num">{{ g.count }}</span>
        </button>
      }
    </section>

    <section class="group">
      <span class="lx-caption">Filters</span>
      @for (f of filters(); track f.id) {
        @if (f.available) {
          <lx-checkbox-row
            [label]="f.label"
            [count]="f.count"
            [countTone]="f.id === 'hasErrors' ? 'danger' : 'default'"
            [checked]="grid.filters().includes(f.id)"
            (checkedChange)="grid.toggleFilter(f.id)"
          />
        } @else {
          <div class="unavailable" [title]="f.why">
            <lx-checkbox-row [label]="f.label" [count]="null" [checked]="false" />
          </div>
        }
      }
      <p class="note">
        Filters combine with <span class="lx-mono">AND</span>. The active set is saved with the
        project.
      </p>
      @if (unavailable().length > 0) {
        <p class="note note--muted">
          {{ unavailable().join(', ') }} needs the local model to have run at least once — it has no
          data to count yet.
        </p>
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: var(--lx-w-rail);
      flex: none;
      background: var(--lx-bg-rail);
      border-right: 1px solid var(--lx-border-section);
      overflow-y: auto;
    }
    .search {
      padding: var(--lx-sp-12);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .group {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-2);
      padding: var(--lx-sp-16) var(--lx-sp-12);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .group > .lx-caption {
      margin-bottom: var(--lx-sp-6);
    }
    .tree-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-8);
      padding: var(--lx-sp-4) var(--lx-sp-8);
      border-radius: var(--lx-r-6);
      background: transparent;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      text-align: left;
      width: 100%;
    }
    .tree-row:hover {
      background: var(--lx-bg-raised);
    }
    .tree-row[data-active='true'] {
      background: var(--lx-bg-selected);
      color: var(--lx-accent-on-tint);
      font-weight: var(--lx-fw-600);
    }
    .indent {
      padding-left: var(--lx-sp-24);
    }
    .count {
      flex: none;
      color: var(--lx-text-faint-2);
      font-size: var(--lx-fs-11);
    }
    .tree-row[data-active='true'] .count {
      color: var(--lx-accent-on-tint-dim);
    }
    .unavailable {
      opacity: 0.45;
      pointer-events: none;
    }
    .note {
      margin: var(--lx-sp-10) 0 0;
      padding: var(--lx-sp-10);
      border: 1px solid var(--lx-border-section);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .note--muted {
      border-style: dashed;
      background: transparent;
    }
  `,
})
export class LxGridRail {
  protected readonly grid = inject(GridStore);
  protected readonly units = inject(UnitsStore);

  protected readonly groups = computed(() => {
    const counts = this.units.groupCounts();
    return Object.keys(counts)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        // A project whose files are named for their locale alone — `en-GB.xlf`
        // beside `de-DE.xlf` in the root — has one group whose key is the empty
        // string, because there is no stem left after the locale comes off. The
        // key stays empty; only the label needs a word.
        label: name === '' ? 'Project root' : name,
        count: counts[name] ?? 0,
      }));
  });

  protected readonly filters = computed(() => {
    const facets = this.units.facets();
    return GRID_FILTERS.map((id) => {
      const available = !UNAVAILABLE_FILTERS.includes(id);
      return {
        id,
        label: FILTER_LABEL[id],
        available,
        count: available ? (facets[id] ?? 0) : null,
        why: available ? '' : 'No data source until the local model has produced drafts.',
      };
    });
  });

  protected readonly unavailable = computed(() =>
    this.filters()
      .filter((f) => !f.available)
      .map((f) => f.label),
  );
}
