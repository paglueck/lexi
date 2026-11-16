// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, signal } from '@angular/core';

import { LxSegmentedControl } from '../../ui/index.js';
import { KsContent } from './ks-content.js';

type View = 'dark' | 'light' | 'both';

/**
 * The M2 fidelity checkpoint.
 *
 * `both` renders the whole kit twice, the right column wrapped in
 * [data-theme="light"]. That works only because the semantic blocks are
 * attribute selectors rather than :root — so this view is simultaneously the
 * review tool and the proof that the token architecture is right.
 */
@Component({
  selector: 'lx-kitchen-sink-page',
  imports: [KsContent, LxSegmentedControl],
  template: `
    <header class="bar">
      <h1>Kitchen sink <span class="lx-caption">M2 fidelity checkpoint</span></h1>
      <span class="lx-spacer"></span>
      <lx-segmented-control [options]="viewOptions" [(value)]="view" />
      <label class="opt">
        <input type="checkbox" [checked]="measure()" (change)="measure.set(!measure())" />
        outline
      </label>
    </header>

    <div class="panes" [class.panes--split]="view() === 'both'" [class.ks-measure]="measure()">
      @if (view() !== 'light') {
        <div class="pane" data-theme="dark"><lx-ks-content /></div>
      }
      @if (view() !== 'dark') {
        <div class="pane" data-theme="light"><lx-ks-content /></div>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-12);
      padding: var(--lx-sp-12) var(--lx-sp-32);
      border-bottom: 1px solid var(--lx-border-section);
      background: var(--lx-bg-panel);
      flex: none;
    }
    h1 {
      display: flex;
      align-items: baseline;
      gap: var(--lx-sp-10);
      font-size: var(--lx-fs-17);
      font-weight: var(--lx-fw-600);
    }
    .opt {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-6);
      font-size: var(--lx-fs-12);
      color: var(--lx-text-muted);
    }
    .panes {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: grid;
      grid-template-columns: 1fr;
    }
    .panes--split {
      grid-template-columns: 1fr 1fr;
    }
    .pane {
      min-width: 0;
      background: var(--lx-bg-app);
    }
    .panes--split .pane + .pane {
      border-left: 1px solid var(--lx-border-section);
    }
  `,
})
export class KitchenSinkPage {
  protected readonly view = signal<View>('dark');
  protected readonly measure = signal(false);
  protected readonly viewOptions = [
    { value: 'dark' as const, label: 'Dark' },
    { value: 'light' as const, label: 'Light' },
    { value: 'both' as const, label: 'Side by side' },
  ];
}
