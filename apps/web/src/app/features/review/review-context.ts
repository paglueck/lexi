// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, inject, input } from '@angular/core';
import type { UnitDetail, UnitTarget } from '@lexi/shared';

import { LxBadge } from '../../ui/badge.js';
import { LxButton } from '../../ui/button.js';
import { LxModalService } from '../../ui/modal.js';
import { LxPromptPreview, type PromptPreviewData } from '../../ui/prompt-preview.js';
import { TranslateStore } from '../../core/stores/translate-store.js';
import { LxStyleguidePanel } from './styleguide-panel.js';

/**
 * S11's right rail: who this string is, what the writer said about it, and how
 * the draft in front of the reviewer came to exist.
 *
 * "How this draft was made" reads `UnitTarget.origin`, which the server fills
 * from `.lexi/state.json` — deliberately NOT from the last run held in
 * `TranslateStore`, which is empty for every draft this browser session did not
 * itself produce. A batch of 140 drafted overnight is the ordinary case.
 *
 * Two sections S11 draws are not here, and their absence is a decision rather
 * than an omission: "Similar accepted units" needs the translation memory
 * (FR-6.13, out of scope) and per-unit "History" needs an
 * append-only audit log (FR-7.5, cut before M12). Drawing either from what is
 * actually stored would mean inventing entries.
 */
@Component({
  selector: 'lx-review-context',
  imports: [LxBadge, LxButton, LxStyleguidePanel],
  template: `
    @let d = detail();
    @let t = target();
    @if (d && t) {
      <section class="sec">
        <div class="head">
          <span class="lx-mono id">{{ d.unitId }}</span>
          <lx-badge tone="neutral" size="xs" outline>{{
            d.customId ? 'custom id' : 'hash id'
          }}</lx-badge>
        </div>
        <p class="lx-mono where">
          {{ d.files[t.locale] ?? 'not in a file yet' }}<br />{{ d.group }}
        </p>
      </section>

      <section class="sec">
        <span class="lx-caption">Context notes</span>
        @for (note of d.notes; track $index) {
          <div class="note">
            <span class="lx-mono notefrom" [attr.data-kind]="note.from"
              >from="{{ note.from }}"</span
            >
            <span class="body">{{ note.text }}</span>
          </div>
        } @empty {
          <p class="cap">No context note for this string (FR-4.3c).</p>
        }
      </section>

      @if (d.locations.length > 0) {
        <section class="sec">
          <div class="head">
            <span class="lx-caption">Used in</span>
            <lx-badge tone="neutral" size="xs" outline>
              {{ d.locations.length }} {{ d.locations.length === 1 ? 'template' : 'templates' }}
            </lx-badge>
          </div>
          @for (loc of d.locations; track loc.sourcefile + loc.linenumber) {
            <div class="lx-mono loc">
              {{ loc.sourcefile }}<span class="line"> :{{ loc.linenumber }}</span>
            </div>
          }
        </section>
      }

      <section class="sec">
        <span class="lx-caption">How this draft was made</span>
        @if (t.origin; as origin) {
          <dl class="facts">
            <div>
              <dt>Model</dt>
              <dd class="lx-mono">{{ origin.model }}</dd>
            </div>
            @if (origin.temperature !== undefined) {
              <div>
                <dt>Temperature</dt>
                <dd class="lx-mono">{{ origin.temperature }}</dd>
              </div>
            }
            <div>
              <dt>Placeholders</dt>
              <dd>{{ origin.style }}</dd>
            </div>
            @if (origin.styleGuide !== undefined) {
              <div>
                <dt>Style guide</dt>
                <dd>{{ origin.styleGuide ?? 'none for this locale' }}</dd>
              </div>
            }
            @if (glossaryText(t); as glossary) {
              <div>
                <dt>Term base</dt>
                <dd>{{ glossary }}</dd>
              </div>
            }
            @if (origin.confidence) {
              <div>
                <dt>Confidence</dt>
                <dd>{{ origin.confidence }}</dd>
              </div>
            }
            <div>
              <dt>Generated</dt>
              <dd>{{ generated(origin.at) }}</dd>
            </div>
          </dl>
          @if (origin.notesForReviewer) {
            <p class="modelnote">Note from the model: {{ origin.notesForReviewer }}</p>
          }
          <div class="actions">
            <button type="button" lx-button size="xs" (click)="viewPrompt(d.rowId, t.locale)">
              View prompt
            </button>
          </div>
          @if (raw(d.rowId, t.locale); as answer) {
            <details class="raw">
              <summary class="lx-caption">Raw response</summary>
              <pre class="lx-mono">{{ answer }}</pre>
            </details>
          } @else {
            <p class="cap">
              The raw answer is only kept for runs started in this session; this draft's is in the
              job's run log.
            </p>
          }
        } @else {
          <p class="cap">
            No model wrote this target — it is in the queue because it is flagged Needs review.
          </p>
        }
      </section>

      <section class="sec sec--last">
        <lx-styleguide-panel [locale]="t.locale" />
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: none;
      flex-direction: column;
      width: var(--lx-w-panel);
      min-height: 0;
      overflow-y: auto;
      border-left: 1px solid var(--lx-border-section);
      background: var(--lx-bg-rail);
    }
    .sec {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-14) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .sec--last {
      margin-top: auto;
      border-bottom: 0;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--lx-sp-8);
    }
    .id {
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-11-5);
      overflow-wrap: anywhere;
    }
    .where,
    .loc {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-10-5);
      line-height: var(--lx-lh-loose);
      overflow-wrap: anywhere;
    }
    .loc {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11);
    }
    .line {
      color: var(--lx-text-faint-2);
    }
    .note {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-2);
    }
    .notefrom {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-9-5);
    }
    .notefrom[data-kind='description'] {
      color: var(--lx-accent-on-tint);
    }
    .notefrom[data-kind='meaning'] {
      color: var(--lx-warn);
    }
    .body {
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
      overflow-wrap: anywhere;
    }
    .cap {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-body);
    }
    .facts {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-3);
      margin: 0;
    }
    .facts > div {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--lx-sp-10);
      font-size: var(--lx-fs-12);
    }
    dt {
      color: var(--lx-text-muted);
    }
    dd {
      margin: 0;
      color: var(--lx-text-secondary);
      text-align: right;
      overflow-wrap: anywhere;
    }
    .modelnote {
      margin: var(--lx-sp-4) 0 0;
      color: var(--lx-warn-body-text);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-body);
    }
    .actions {
      display: flex;
      gap: var(--lx-sp-6);
      margin-top: var(--lx-sp-6);
    }
    .raw pre {
      max-height: 180px;
      margin: var(--lx-sp-6) 0 0;
      overflow: auto;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-10-5);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class LxReviewContext {
  readonly detail = input.required<UnitDetail | undefined>();
  readonly target = input.required<UnitTarget | undefined>();

  readonly #modal = inject(LxModalService);
  readonly #translate = inject(TranslateStore);

  /**
   * "2 of 3 applied · 148 in the term base", or nothing.
   *
   * A project with no term base would otherwise get a row reading "0 of 0
   * applied · 0 in the term base", which is three zeroes saying that a feature
   * nobody has used was not used.
   */
  protected glossaryText(target: UnitTarget): string | null {
    const origin = target.origin;
    if (!origin || !origin.glossaryTotal) return null;
    const injected = origin.glossaryInjected ?? 0;
    if (injected === 0) return `none of ${origin.glossaryTotal} terms matched this string`;
    return `${origin.glossaryApplied ?? 0} of ${injected} applied · ${origin.glossaryTotal} in the term base`;
  }

  protected generated(at: string): string {
    const when = new Date(at);
    return Number.isNaN(when.getTime()) ? at : when.toLocaleString();
  }

  /** Only for a run this session started — see the class comment. */
  protected raw(rowId: string, locale: string): string | null {
    return this.#translate.runFor(rowId, locale)?.result.run.raw ?? null;
  }

  protected viewPrompt(rowId: string, locale: string): void {
    this.#modal.open<LxPromptPreview, boolean>(LxPromptPreview, {
      data: { rowId, locale } satisfies PromptPreviewData,
    });
  }
}
