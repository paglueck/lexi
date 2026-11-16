// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type AfterViewInit,
  type ElementRef,
  viewChild,
} from '@angular/core';
import type { TermImportMode } from '@lexi/shared';
import { diffImport, parseTermCsv, type ImportPreviewRow } from '@lexi/shared/termbase-csv';

import { TermBaseStore } from '../../core/stores/termbase-store.js';
import { LxButton } from '../../ui/button.js';
import { LxSegmentedControl, type SegmentOption } from '../../ui/segmented-control.js';
import type { TermLocale } from './termbase-page.js';

const STATUS_LABEL = { new: 'New', update: 'Update', unchanged: 'Unchanged' } as const;

const MODES: readonly SegmentOption<TermImportMode>[] = [
  { value: 'overwrite', label: 'Overwrite' },
  { value: 'keep', label: 'Keep existing' },
];

/**
 * "Import terms from CSV" — the preview before anything is written.
 *
 * Parsed and diffed here with the same `@lexi/shared` functions the server
 * applies, so the counts on the button are the counts that land. Covers the
 * body area only, as the design draws it, leaving the toolbar readable.
 */
@Component({
  selector: 'lx-import-dialog',
  imports: [LxButton, LxSegmentedControl],
  host: { '(keydown.escape)': 'closed.emit()' },
  template: `
    <div class="scrim" (click)="closed.emit()" aria-hidden="true"></div>
    <div
      #dialog
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      tabindex="-1"
    >
      <header class="head">
        <div class="head-text">
          <h2 class="title" id="import-title">Import terms from CSV</h2>
          <span class="file lx-mono">{{ fileName() }}</span>
        </div>
        <button
          lx-button
          type="button"
          variant="secondary"
          class="another"
          (click)="chooseAnother.emit()"
        >
          Choose another file…
        </button>
      </header>

      <section class="columns">
        <div class="chips">
          @for (c of parsed().recognised; track c) {
            <span class="chip lx-mono">{{ c }}</span>
          }
          @for (c of parsed().ignored; track c) {
            <span class="chip chip--ignored lx-mono">{{ c }} · ignored, not a project locale</span>
          }
        </div>
        <p class="help">
          Header row required. <code class="lx-mono">dnt</code> accepts yes/no, true/false or 1/0.
          Empty locale cells keep the source term. Rows with DNT ignore their locale cells.
        </p>
        @if (parsed().errors.length > 0) {
          <ul class="errors" role="alert">
            @for (e of parsed().errors; track e) {
              <li>{{ e }}</li>
            }
          </ul>
        }
      </section>

      <div class="preview" role="table" aria-label="Import preview">
        <div class="prow prow--head" role="row">
          <span role="columnheader">Term</span>
          <span role="columnheader" class="center">DNT</span>
          <span role="columnheader">Translations</span>
          <span role="columnheader">Changes</span>
          <span role="columnheader">Status</span>
        </div>
        @for (p of preview(); track p.row.term) {
          <div class="prow" role="row">
            <span role="cell" class="pterm">{{ p.row.term }}</span>
            <span role="cell" class="center">
              @if (p.row.dnt) {
                <span class="dnt lx-mono">DNT</span>
              }
            </span>
            <span role="cell" class="muted">{{ translationsText(p) }}</span>
            <span role="cell" class="muted">{{ changesText(p) }}</span>
            <span role="cell">
              <span class="status lx-mono" [attr.data-status]="p.status">{{
                statusLabel[p.status]
              }}</span>
            </span>
          </div>
        } @empty {
          <p class="none">No terms in this file.</p>
        }
      </div>

      <section class="conflict">
        <span class="conflict-label" id="conflict-label">Terms that already exist</span>
        <lx-segmented-control ariaLabelledby="conflict-label" [options]="modes" [(value)]="mode" />
      </section>

      <footer class="foot">
        <span class="summary"
          >{{ counts().new }} new · {{ counts().update }} update ·
          {{ counts().unchanged }} unchanged</span
        >
        <span class="spacer"></span>
        <button lx-button type="button" variant="secondary" (click)="closed.emit()">Cancel</button>
        <button
          lx-button
          type="button"
          variant="primary"
          [disabled]="importCount() === 0 || busy()"
          (click)="run()"
        >
          Import {{ importCount() }} {{ importCount() === 1 ? 'term' : 'terms' }}
        </button>
      </footer>
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding-top: var(--lx-sp-40);
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: var(--lx-scrim);
    }
    .dialog {
      position: relative;
      display: flex;
      flex-direction: column;
      width: min(820px, calc(100% - 32px));
      max-height: calc(100% - 80px);
      border: 1px solid var(--lx-border-strong);
      border-radius: 10px;
      background: var(--lx-bg-titlebar);
      box-shadow: 0 24px 60px rgb(0 0 0 / 50%);
      outline: none;
    }
    .dialog > * + * {
      border-top: 1px solid var(--lx-border-section);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-12);
      padding: var(--lx-sp-18) var(--lx-sp-22);
    }
    .head-text {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: var(--lx-sp-4);
      min-width: 0;
    }
    .title {
      margin: 0;
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-15);
      font-weight: var(--lx-fw-600);
    }
    .file {
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-11);
    }
    .another {
      height: 26px;
    }
    .columns {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-16) var(--lx-sp-22);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--lx-sp-6);
    }
    .chip {
      padding: var(--lx-sp-3) var(--lx-sp-8);
      border: 1px solid var(--lx-accent-tint-border);
      border-radius: var(--lx-r-5);
      background: var(--lx-accent-tint-bg);
      color: var(--lx-accent-on-tint);
      font-size: var(--lx-fs-11);
    }
    .chip--ignored {
      border: 1px dashed var(--lx-warn-tint-border);
      background: transparent;
      color: var(--lx-warn);
    }
    .help {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .help code {
      color: var(--lx-text-subtle);
    }
    .errors {
      margin: 0;
      padding-left: var(--lx-sp-16);
      color: var(--lx-danger-on-tint);
      font-size: var(--lx-fs-11-5);
    }
    .preview {
      min-height: 0;
      overflow-y: auto;
    }
    .prow {
      display: grid;
      grid-template-columns: 180px 56px 1fr 150px 100px;
      align-items: center;
      min-height: 38px;
      padding: 0 var(--lx-sp-22);
      border-bottom: 1px solid var(--lx-border-row);
      font-size: var(--lx-fs-12-5);
    }
    .prow > * {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .prow--head {
      position: sticky;
      top: 0;
      min-height: 0;
      padding-top: var(--lx-sp-8);
      padding-bottom: var(--lx-sp-8);
      border-bottom-color: var(--lx-border-table);
      background: var(--lx-bg-panel);
      color: var(--lx-text-faint);
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-9-5);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .center {
      text-align: center;
    }
    .pterm {
      color: var(--lx-text-primary);
      font-weight: var(--lx-fw-600);
    }
    .muted {
      color: var(--lx-text-subtle);
    }
    .dnt {
      padding: 1px var(--lx-sp-4);
      border: 1px solid var(--lx-warn-tint-border);
      border-radius: var(--lx-r-3);
      background: var(--lx-warn-tint-bg);
      color: var(--lx-warn);
      font-size: var(--lx-fs-9);
    }
    .status {
      padding: var(--lx-sp-2) var(--lx-sp-6);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-4);
      color: var(--lx-text-subtle);
      font-size: var(--lx-fs-10);
    }
    .status[data-status='new'] {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
      color: var(--lx-accent-on-tint);
    }
    .status[data-status='update'] {
      border-color: var(--lx-warn-tint-border);
      background: var(--lx-warn-tint-bg);
      color: var(--lx-warn);
    }
    .none {
      margin: 0;
      padding: var(--lx-sp-16) var(--lx-sp-22);
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
    .conflict {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-12);
      padding: var(--lx-sp-14) var(--lx-sp-22);
    }
    .conflict-label {
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
    }
    .foot {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      padding: var(--lx-sp-14) var(--lx-sp-22);
    }
    .summary {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12);
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class LxImportDialog implements AfterViewInit {
  readonly fileName = input.required<string>();
  readonly text = input.required<string>();
  readonly locales = input.required<readonly TermLocale[]>();
  readonly chooseAnother = output();
  readonly closed = output();

  readonly #store = inject(TermBaseStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');

  protected readonly modes = MODES;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly mode = signal<TermImportMode>('overwrite');
  protected readonly busy = signal(false);

  readonly #codes = computed(() => this.locales().map((l) => l.code));

  protected readonly parsed = computed(() => parseTermCsv(this.text(), this.#codes()));

  /** The project locales the file has a column for — the only ones it can change. */
  readonly #fileLocales = computed(() =>
    this.#codes().filter((c) => this.parsed().recognised.includes(c)),
  );

  /** A file with errors imports nothing: a half-applied file is harder to undo than a refused one. */
  protected readonly preview = computed<ImportPreviewRow[]>(() =>
    this.parsed().errors.length > 0
      ? []
      : diffImport(this.#store.terms(), this.parsed().rows, this.#fileLocales()),
  );

  protected readonly counts = computed(() => {
    const out = { new: 0, update: 0, unchanged: 0 };
    for (const p of this.preview()) out[p.status] += 1;
    return out;
  });

  protected readonly importCount = computed(() =>
    this.mode() === 'overwrite' ? this.counts().new + this.counts().update : this.counts().new,
  );

  ngAfterViewInit(): void {
    this.dialog().nativeElement.focus();
  }

  protected translationsText(p: ImportPreviewRow): string {
    if (p.row.dnt) return 'Kept as source';
    const total = this.#codes().length;
    const n = this.#codes().filter((c) => (p.row.translations[c] ?? '').trim() !== '').length;
    return n === total ? 'All locales' : `${n} translated, ${total - n} as source`;
  }

  protected changesText(p: ImportPreviewRow): string {
    if (p.status === 'new') return 'Added';
    if (p.status === 'unchanged') return 'Identical';
    return p.changedLocales.length > 0
      ? `${p.changedLocales.join(', ')} changed`
      : 'Note or DNT changed';
  }

  protected async run(): Promise<void> {
    this.busy.set(true);
    const ok = await this.#store.import(
      this.preview().map((p) => p.row),
      this.mode(),
      this.#fileLocales(),
    );
    this.busy.set(false);
    if (ok) this.closed.emit();
  }
}
