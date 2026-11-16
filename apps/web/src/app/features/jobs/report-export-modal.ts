// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import {
  CSV_DELIMITERS,
  CSV_SPLITS,
  REPORT_FORMATS,
  type CsvDelimiter,
  type CsvSplit,
  type ReportFormat,
} from '@lexi/shared/constants';
import type { ReportQuery } from '@lexi/shared';

import { LxButton } from '../../ui/button.js';
import { LxModalShell } from '../../ui/modal.js';
import { LxRadioCard, LxRadioCardGroup } from '../../ui/radio-card.js';
import { LxSegmentedControl, type SegmentOption } from '../../ui/segmented-control.js';

export interface ReportExportModalData {
  /** The job's target locales as the card names them ("de, fr" or "5 locales"), for the subtitle. */
  readonly locales: string;
  /** How many target locales the job has; a per-locale split only makes sense above one. */
  readonly localeCount: number;
}

const STORAGE_KEY = 'lexi.report-export';

/** The last choice, so a team that always sends CSV does not re-pick it per job. */
export function readReportChoice(): ReportQuery {
  const fallback: ReportQuery = { format: 'html', delimiter: ';', split: 'single' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<keyof ReportQuery, unknown>>;
    return {
      format: REPORT_FORMATS.find((f) => f === parsed.format) ?? fallback.format,
      delimiter: CSV_DELIMITERS.find((d) => d === parsed.delimiter) ?? fallback.delimiter,
      split: CSV_SPLITS.find((v) => v === parsed.split) ?? fallback.split,
    };
  } catch {
    return fallback;
  }
}

function writeReportChoice(choice: ReportQuery): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private window or blocked site data: the choice just is not remembered.
  }
}

/**
 * What a finished job is exported as. The HTML report is for whoever checks
 * the drafts here; the CSV goes out to a reviewer in the target market, who
 * edits the translation column in Excel and sends the file back. It resolves
 * the chosen options, or undefined when cancelled.
 */
@Component({
  selector: 'lx-report-export-modal',
  imports: [LxButton, LxModalShell, LxRadioCard, LxRadioCardGroup, LxSegmentedControl],
  template: `
    <lx-modal-shell title="Export job" [subtitle]="'Translations into ' + data.locales">
      <div class="fields">
        <lx-radio-card-group aria-label="Format">
          <lx-radio-card
            data-format="html"
            title="Review report (HTML)"
            hint="One file with every source, translation, finding and prompt, for a native speaker to check."
            [selected]="format() === 'html'"
            (click)="format.set('html')"
          />
          <lx-radio-card
            data-format="csv"
            title="Translations (CSV)"
            hint="Unit ID, description and translation, for a market reviewer to edit in Excel. Can be imported back later."
            [selected]="format() === 'csv'"
            (click)="format.set('csv')"
          />
        </lx-radio-card-group>

        @if (format() === 'csv') {
          <div class="row">
            <span class="label" id="lx-report-delimiter">Separator</span>
            <lx-segmented-control
              ariaLabelledby="lx-report-delimiter"
              [options]="delimiters"
              [(value)]="delimiter"
            />
          </div>
          @if (data.localeCount > 1) {
            <div class="row" data-files>
              <span class="label" id="lx-report-split">Files</span>
              <lx-segmented-control
                ariaLabelledby="lx-report-split"
                [options]="splits"
                [(value)]="split"
              />
            </div>
          }
          <p class="body">
            Placeholders appear as numbered tokens such as <code>{{ tokenExample }}</code
            >. Reviewers should leave them as they are.
          </p>
        }
      </div>

      <span modal-footer class="lx-spacer"></span>
      <button type="button" modal-footer lx-button size="field" (click)="ref.close()">
        Cancel
      </button>
      <button
        type="button"
        modal-footer
        lx-button
        variant="primary"
        size="field"
        (click)="export()"
      >
        Export
      </button>
    </lx-modal-shell>
  `,
  styles: `
    .fields {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-14);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
    }
    .label {
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-600);
    }
    .body {
      margin: 0;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
    }
  `,
})
export class LxReportExportModal {
  protected readonly ref = inject<DialogRef<ReportQuery, LxReportExportModal>>(DialogRef);
  protected readonly data = inject<ReportExportModalData>(DIALOG_DATA);

  readonly #initial = readReportChoice();
  protected readonly format = signal<ReportFormat>(this.#initial.format);
  protected readonly delimiter = signal<CsvDelimiter>(this.#initial.delimiter);

  protected readonly split = signal<CsvSplit>(this.#initial.split);

  /** Braces cannot be written literally in a template. */
  protected readonly tokenExample = '{1:{{ count }}}';

  protected readonly delimiters: readonly SegmentOption<CsvDelimiter>[] = [
    { value: ';', label: 'Semicolon ;', title: 'What Excel expects in Germany and most of Europe' },
    { value: ',', label: 'Comma ,', title: 'What Excel expects in the UK, the US and Asia' },
  ];

  protected readonly splits: readonly SegmentOption<CsvSplit>[] = [
    { value: 'single', label: 'One file', title: 'Every locale in one CSV' },
    {
      value: 'perLocale',
      label: 'One per locale',
      title: 'A zip with one CSV per locale, to send each reviewer only their own',
    },
  ];

  protected export(): void {
    // What is remembered is the user's own pick; a one-locale job or an HTML report has no
    // Files row, so it only sends 'single' without overwriting a per-locale preference.
    const stored: ReportQuery = {
      format: this.format(),
      delimiter: this.delimiter(),
      split: this.split(),
    };
    writeReportChoice(stored);
    const perLocale = this.format() === 'csv' && this.data.localeCount > 1;
    const effective = perLocale ? this.split() : 'single';
    const choice: ReportQuery = { ...stored, split: effective };
    this.ref.close(choice);
  }
}
