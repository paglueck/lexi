// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, booleanAttribute, input } from '@angular/core';
import type { SegmentDto, UnitRow } from '@lexi/shared';

import { GLYPH, STATE_LABEL } from '../../ui/glyphs.js';

/**
 * One grid row: the shape that was benchmarked at 20k x 10 before the grid was
 * built (docs/architecture.md, grid performance).
 *
 * The four rules it exists to keep, all of them load-bearing at that scale:
 *
 * 1. ONE component per row, and CELLS ARE NOT COMPONENTS. Twelve columns by
 *    forty-five visible rows would otherwise churn 540 instances per fling.
 * 2. All colour through [attr.data-state] / [attr.data-error], resolved by
 *    tokens/ramps.css. No ngClass, no ngStyle, no object literals in the
 *    template — those allocate on every change-detection pass.
 * 3. Placeholders as raw <span class="lx-chip">, which is why
 *    LxPlaceholderChip declares zero styles of its own and a spec asserts it.
 * 4. `contain: layout style paint` on the host. NOT content-visibility:auto,
 *    which fights virtualization.
 *
 * Segments are NEVER parsed here — the server delivers them decomposed and
 * clipped. The template walks an array; that is the whole render cost.
 */
@Component({
  selector: 'lx-grid-row',
  host: {
    class: 'row',
    role: 'row',
    '[attr.data-selected]': 'selected() ? "true" : null',
    '[attr.aria-selected]': 'selected()',
    '[attr.id]': 'index() < 0 ? null : "lx-grid-row-" + index()',
    // 1-based, and the header row is row 1.
    '[attr.aria-rowindex]': 'index() < 0 ? null : index() + 2',
  },
  template: `
    @let r = row();
    @if (r) {
      <div class="c c-id lx-mono lx-truncate" role="gridcell" [title]="r.unitId">
        {{ r.unitId }}
        @if (r.isIcu) {
          <span class="lx-badge icu" data-tone="neutral" data-size="xs">ICU</span>
        }
      </div>
      <div class="c c-src lx-truncate" role="gridcell">
        @for (s of r.source; track $index) {
          @if (s.k === 'p') {
            <span class="lx-chip">{{ s.equivText || s.id }}</span>
          } @else if (s.k === 't') {
            {{ s.v }}
          }
        }
      </div>
      @for (locale of locales(); track locale) {
        @let cell = r.cells[locale];
        <div
          class="c c-tgt"
          role="gridcell"
          [attr.data-state]="cell?.state ?? 'untranslated'"
          [attr.data-error]="cell?.error ? 'true' : null"
          [attr.data-editing]="locale === editLocale() ? 'true' : null"
          [attr.data-picked]="picked()?.has(locale) ? 'true' : null"
          [attr.dir]="rtl().includes(locale) ? 'rtl' : null"
        >
          <span class="lx-badge"
            ><span aria-hidden="true">{{
              cell?.error ? GLYPH.error : GLYPH.state[cell?.state ?? 'untranslated']
            }}</span
            ><span class="sr-only">{{ label(cell?.state, cell?.error) }}</span></span
          >
          <span class="lx-cell__text lx-truncate">
            @for (s of cell?.segments ?? []; track $index) {
              @if (s.k === 'p') {
                <span class="lx-chip">{{ s.equivText || s.id }}</span>
              } @else if (s.k === 't') {
                {{ s.v }}
              }
            }
          </span>
        </div>
      }
    } @else {
      <!-- The window is still in flight. A skeleton keeps the scroll height
           honest instead of collapsing the row to nothing. -->
      <div class="c c-id skeleton" role="gridcell"><span class="bone"></span></div>
      <div class="c c-src skeleton" role="gridcell"><span class="bone"></span></div>
      @for (locale of locales(); track locale) {
        <div class="c c-tgt skeleton" role="gridcell"><span class="bone"></span></div>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: var(--lx-grid-cols);
      align-items: center;
      height: var(--lx-h-row);
      border-bottom: 1px solid var(--lx-border-row);
      cursor: default;
      contain: layout style paint;
    }

    :host([data-selected='true']) {
      background: var(--lx-bg-selected);
      box-shadow: inset 2px 0 0 var(--lx-accent);
    }

    .c {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-7);
      min-width: 0;
      height: 100%;
      padding: 0 var(--lx-sp-12);
      border-right: 1px solid var(--lx-border-row);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-tight);
    }

    .c-id {
      padding: 0 var(--lx-sp-8);
      gap: var(--lx-sp-4);
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-10-5);
    }

    :host([data-selected='true']) .c-id {
      color: var(--lx-accent-on-tint);
    }

    .icu {
      flex: none;
    }

    .c-src {
      color: var(--lx-text-secondary);
    }

    /* The cell the panel (or the inline editor) is editing — row AND locale.
       Inset shadow rather than a border, so the fixed 34px geometry and the
       column hairlines do not move. The fill is a translucent accent, BRIGHTER
       than the selected row's tint: the old opaque tint was darker than the
       row around it, so a single selected cell read as a dim patch, and on a
       reviewed cell (same tint) it vanished. Yields to an error cell's own. */
    .c-tgt[data-editing='true'] {
      box-shadow: inset 0 0 0 2px var(--lx-accent);
    }
    .c-tgt[data-editing='true']:not([data-error='true']) {
      background: var(--lx-cell-selected-bg);
    }

    /* One of several marked cells (the multi-selection a bulk action from the
       context menu applies to). A lighter fill and an inset hairline, so a
       marked cell reads on top of a state colour and stays distinct from the
       edit cell's stronger fill and 2px outline. */
    .c-tgt[data-picked='true'] {
      background: var(--lx-cell-picked-bg);
      box-shadow: inset 0 0 0 1px var(--lx-accent);
    }
    .c-tgt[data-picked='true'][data-editing='true'] {
      background: var(--lx-cell-selected-bg);
      box-shadow: inset 0 0 0 2px var(--lx-accent);
    }

    .c-tgt .lx-cell__text {
      min-width: 0;
      flex: 1;
    }

    /* Loading: a bar rather than an empty cell, so a fast scroll does not look
       like a list full of holes. */
    .bone {
      display: block;
      width: 60%;
      height: 8px;
      border-radius: var(--lx-r-3);
      background: var(--lx-border-row);
    }
    .c-id .bone {
      width: 80%;
    }
  `,
})
export class LxGridRow {
  /** Undefined while the window holding this row is still in flight. */
  readonly row = input<UnitRow | undefined>(undefined);
  readonly locales = input.required<readonly string[]>();
  /** RTL locales among the visible columns (FR-3.10). */
  readonly rtl = input<readonly string[]>([]);
  readonly selected = input(false, { transform: booleanAttribute });
  /**
   * The locale being edited, set on the SELECTED row only (null on every
   * other), so marking the cell is one string compare per visible cell and no
   * other row's inputs ever change when the edit locale does.
   */
  readonly editLocale = input<string | null>(null);
  /**
   * The locales of this row in the grid's multi-selection; null on every row
   * with none, so marking cells changes the inputs of the marked rows only.
   * The grid hands rows with the same pattern the same Set instance.
   */
  readonly picked = input<ReadonlySet<string> | null>(null);
  /**
   * Position in the filtered list, for the id the grid's
   * `aria-activedescendant` points at and for `aria-rowindex` — a virtualized
   * grid renders forty of twenty thousand rows, so a screen reader needs to be
   * told where they sit.
   */
  readonly index = input(-1);

  protected readonly GLYPH = GLYPH;

  /**
   * FR-3.7: state is never colour alone. The badge always carries the full
   * name in an sr-only span, exactly as LxStateBadge does — the markup is
   * duplicated rather than the component reused (rule 1 above), so the two read
   * from the same GLYPH/STATE_LABEL constants and cannot drift.
   */
  protected label(state: string | undefined, error: boolean | undefined): string {
    const name = STATE_LABEL[(state ?? 'untranslated') as keyof typeof STATE_LABEL];
    return error ? `${name}, validation error` : name;
  }

  protected segments(list: readonly SegmentDto[] | undefined): readonly SegmentDto[] {
    return list ?? [];
  }
}
