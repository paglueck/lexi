// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, input } from '@angular/core';

/**
 * One section of the kitchen sink: a caption, an optional spec line, and the
 * specimens.
 *
 * The spec line is the point of the whole page — printing the handoff's numbers
 * next to the thing they describe is what turns "looks about right" into
 * "is right" during the design review.
 */
@Component({
  selector: 'lx-ks-section',
  template: `
    <header>
      <h2 class="lx-caption">{{ title() }}</h2>
      @if (spec()) {
        <p class="spec lx-mono">{{ spec() }}</p>
      }
    </header>
    <div class="specimens">
      <ng-content />
    </div>
  `,
  styles: `
    :host {
      display: block;
      padding: var(--lx-sp-28) 0;
      border-bottom: 1px solid var(--lx-border-row);
      scroll-margin-top: var(--lx-sp-20);
    }
    header {
      margin-bottom: var(--lx-sp-16);
    }
    .spec {
      margin-top: var(--lx-sp-6);
      font-size: var(--lx-fs-10);
      color: var(--lx-text-faint-2);
    }
    .specimens {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: var(--lx-sp-16);
    }
  `,
})
export class KsSection {
  readonly title = input.required<string>();
  readonly spec = input<string>('');
}
