// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import type {
  PlaceholderStyle,
  PromptBlock,
  PromptPreviewResponse,
  PromptTerm,
  PromptView,
} from '@lexi/shared';
import { termPromptLine } from '@lexi/shared/termbase-csv';

import { LxBadge } from './badge.js';
import { LxButton } from './button.js';
import { LxIcon } from './icon.js';
import { LxModalShell } from './modal.js';
import { LxSegmentedControl, type SegmentOption } from './segmented-control.js';
import { LxStackedBar, type BarSegment } from './stacked-bar.js';
import { PromptApi } from '../core/api/prompt-api.js';
import { TranslateStore } from '../core/stores/translate-store.js';

/**
 * S5 — the composed prompt, exactly as the model will receive it (FR-5.7).
 *
 * THE SCREEN COMPOSES NOTHING. It asks the server for the blocks and renders
 * them verbatim: no joining, no re-wrapping, no "and then we add the schema".
 * That is the entire value of the screen — a preview assembled here would be a
 * second implementation of `services/prompt.ts` and would be right only until
 * somebody edited one of the two.
 *
 * The masked/raw switch is a real product decision rather than a debug toggle
 * (requirements Appendix A): whether a local model reproduces `[[0]]` more reliably than
 * `<x id="…" equiv-text="…"/>` is still open, and this is where the two can be
 * run against the same unit and the same model.
 */

export interface PromptPreviewData {
  readonly rowId: string;
  readonly locale: string;
}

@Component({
  selector: 'lx-prompt-preview',
  imports: [LxBadge, LxButton, LxIcon, LxModalShell, LxSegmentedControl, LxStackedBar],
  template: `
    @let p = preview();
    <lx-modal-shell title="Composed prompt" [subtitle]="subtitle()">
      <lx-segmented-control
        modal-header
        ariaLabel="Prompt part"
        [options]="views"
        [(value)]="view"
      />

      @if (p === null) {
        <p class="note">{{ error() ?? 'Composing…' }}</p>
      } @else {
        <!-- The token meter (FR-5.4). Honest about being an estimate: no
             OpenAI-compatible endpoint reports a tokenizer, and the real figure
             only exists once a request has run. -->
        <section class="meter">
          <div class="meterhead">
            <span class="est">
              Estimated <span class="lx-num">{{ p.totals.tokens.toLocaleString() }}</span> tokens
            </span>
            <span class="window">
              context window
              <span class="lx-num">{{ p.totals.contextWindow.toLocaleString() }}</span>
            </span>
          </div>
          <lx-stacked-bar size="md" [segments]="bars()" [total]="p.totals.contextWindow" />
          <div class="legend">
            @for (b of p.blocks; track b.id) {
              @if (b.tokens > 0) {
                <span class="lg"
                  >{{ b.title }} <span class="lx-num">{{ b.tokens }}</span></span
                >
              }
            }
          </div>
          @if (overBudget()) {
            <p class="warnline">
              The prompt is estimated at more than the context window. The style guides are the
              usual cause — the model will silently drop the beginning of what it was told.
            </p>
          }
        </section>

        @if (view() === 'schema') {
          <section class="block">
            <span class="lx-caption accent">Response contract</span>
            <p class="caption">
              Tolerantly parsed: code fences are stripped, an object embedded in prose is recovered,
              and a model that answers in prose anyway is asked once more before its whole answer is
              taken as the translation.
            </p>
            <pre class="mono">{{ p.schema }}</pre>
          </section>
        } @else {
          @for (b of shown(); track b.id) {
            <section class="block" [attr.data-kind]="b.kind" [attr.data-empty]="b.empty">
              <div class="head">
                <span class="lx-caption" [class.accent]="!b.empty">{{ b.title }}</span>
                @if (b.kind === 'user' && p.placeholderStyle === 'masked') {
                  <lx-badge tone="accent" size="xs" outline>restored after generation</lx-badge>
                }
                @if (b.kind === 'user' && p.placeholderStyle === 'raw') {
                  <lx-badge tone="warn" size="xs" outline>higher breakage risk</lx-badge>
                }
                @if (b.source) {
                  <span class="lx-mono src">{{ b.source }} · {{ b.tokens }} tok</span>
                }
              </div>
              @if (b.caption) {
                <p class="caption">{{ b.caption }}</p>
              }
              @if (b.content) {
                <pre class="mono">{{ b.content }}</pre>
              }
            </section>
          }

          @if (view() === 'system') {
            <section class="block">
              <div class="head">
                <span class="lx-caption">Terminology</span>
                <span class="lx-mono src">{{ p.terminology.total }} terms</span>
              </div>
              @if (p.terminology.matched.length === 0) {
                <p class="caption">
                  {{
                    p.terminology.total === 0 ? 'No term base yet.' : 'No term matched this string.'
                  }}
                  Only the terms that appear in the string are injected, so this block stays small
                  however long the term base grows.
                </p>
              } @else {
                <ul class="terms">
                  @for (t of p.terminology.matched; track t.term) {
                    <li [class.dnt]="t.dnt">{{ lineOf(t, p.locale) }}</li>
                  }
                </ul>
              }
            </section>
          }
        }

        @if (p.blocked) {
          <p class="warnline">{{ p.blocked }}</p>
        }
        @if (translate.error(); as message) {
          <p class="warnline danger">{{ message }}</p>
        }
      }

      <!-- Footer: what a run would use, and the two ways to leave the screen. -->
      <lx-segmented-control
        modal-footer
        ariaLabel="Placeholder style"
        [options]="styles"
        [value]="activeStyle()"
        (valueChange)="setStyle($event)"
      />
      <!-- One projectable node per @if: Angular will not slot a block whose
           root has more than one. -->
      @if (p !== null) {
        <span modal-footer class="lx-mono model">{{ p.model || 'no model' }}</span>
      }
      @if (p !== null) {
        <span modal-footer class="params">{{ params() }}</span>
      }
      <span modal-footer class="lx-spacer"></span>
      <button type="button" modal-footer lx-button size="field" (click)="copy()">
        <lx-icon [name]="copied() ? 'check' : 'copy'" [size]="13" />
        {{ copied() ? 'Copied' : 'Copy' }}
      </button>
      <button
        type="button"
        modal-footer
        lx-button
        variant="primary"
        size="field"
        [disabled]="p === null || p.blocked !== '' || translate.isRunning()"
        (click)="run()"
      >
        {{ translate.isRunning() ? 'Running…' : 'Run for this unit' }}
      </button>
    </lx-modal-shell>
  `,
  styles: `
    .note,
    .caption {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-body);
    }
    .meter {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding-bottom: var(--lx-sp-12);
      margin-bottom: var(--lx-sp-12);
      border-bottom: 1px solid var(--lx-border-table);
    }
    .meterhead {
      display: flex;
      justify-content: space-between;
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-muted);
    }
    .window {
      color: var(--lx-text-faint);
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: var(--lx-sp-14);
      font-size: var(--lx-fs-11);
      color: var(--lx-text-faint);
    }
    .block {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-12);
      margin-bottom: var(--lx-sp-12);
      border: 1px solid var(--lx-border-section);
      border-radius: var(--lx-r-8);
      background: var(--lx-bg-rail);
    }
    .block[data-kind='user'] {
      border-color: var(--lx-accent-tint-border);
    }
    .block[data-empty='true'] {
      opacity: 0.75;
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
    }
    .accent {
      color: var(--lx-accent-on-tint);
    }
    .src {
      margin-left: auto;
      font-size: var(--lx-fs-10-5);
      color: var(--lx-text-faint-2);
    }
    /* Verbatim, and it has to look verbatim: a preview that reflowed the text
       would stop being evidence of what the model receives. */
    .mono {
      margin: 0;
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-11-5);
      line-height: var(--lx-lh-mono);
      color: var(--lx-text-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* A long style guide scrolls inside its own block instead of pushing every
       other block out of view. */
    .block .mono {
      max-height: 320px;
      overflow: auto;
    }
    .warnline {
      margin: 0 0 var(--lx-sp-12);
      color: var(--lx-warn-body-text);
      font-size: var(--lx-fs-11-5);
    }
    .warnline.danger {
      color: var(--lx-danger-on-tint);
    }
    .terms {
      margin: 0;
      padding: 0;
      list-style: none;
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-11);
    }
    .terms li {
      padding: var(--lx-sp-4) var(--lx-sp-8);
      border-bottom: 1px solid var(--lx-border-row);
      color: var(--lx-text-mono);
    }
    .dnt {
      color: var(--lx-warn);
    }
    .model {
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-muted);
    }
    .params {
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-faint);
    }
  `,
})
export class LxPromptPreview {
  /** The same line the model reads — `termPromptLine` is shared with the composer. */
  protected readonly lineOf = (t: PromptTerm, locale: string): string => termPromptLine(t, locale);
  protected readonly ref = inject<DialogRef<boolean, LxPromptPreview>>(DialogRef);
  protected readonly translate = inject(TranslateStore);
  readonly #api = inject(PromptApi);
  readonly #data = inject<PromptPreviewData>(DIALOG_DATA);

  protected readonly views: readonly SegmentOption<PromptView>[] = [
    { value: 'system', label: 'System' },
    { value: 'user', label: 'User' },
    { value: 'schema', label: 'Schema' },
  ];

  protected readonly styles: readonly SegmentOption<PlaceholderStyle>[] = [
    { value: 'masked', label: '[[0]] masked' },
    { value: 'raw', label: '<x/> raw' },
  ];

  protected readonly view = signal<PromptView>('system');
  /**
   * Null until the user picks one, which means "whichever the machine setting
   * says". The screen must not fight `maskPlaceholders`: opening the preview is
   * not a decision about how to prompt.
   */
  protected readonly style = signal<PlaceholderStyle | null>(null);
  protected readonly preview = signal<PromptPreviewResponse | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);

  /** What is on screen: the user's choice, else what the server composed with. */
  protected readonly activeStyle = computed<PlaceholderStyle>(
    () => this.style() ?? this.preview()?.placeholderStyle ?? 'raw',
  );

  protected readonly subtitle = computed(() => {
    const p = this.preview();
    if (p === null) return `${this.#data.rowId} → ${this.#data.locale}`;
    return `unit ${p.unitId} · ${p.sourceLocale} → ${p.locale}`;
  });

  /** The system half, or the user message. Schema is rendered separately. */
  protected readonly shown = computed<readonly PromptBlock[]>(() => {
    const blocks = this.preview()?.blocks ?? [];
    // Terminology has its own table below, so it is filtered out of the plain
    // block list rather than rendered twice.
    return this.view() === 'user'
      ? blocks.filter((b) => b.role === 'user')
      : blocks.filter((b) => b.role === 'system' && b.kind !== 'terminology');
  });

  /** Each block's share of the context window, in prompt order. */
  protected readonly bars = computed<readonly BarSegment[]>(() =>
    (this.preview()?.blocks ?? [])
      .filter((b) => b.tokens > 0)
      .map((b, i) => ({
        value: b.tokens,
        tone: TONES[i % TONES.length] ?? 'accent',
        label: b.title,
      })),
  );

  protected readonly overBudget = computed(() => {
    const totals = this.preview()?.totals;
    return totals !== undefined && totals.tokens > totals.contextWindow;
  });

  protected readonly params = computed(() => {
    const p = this.preview()?.params;
    if (p === undefined) return '';
    return `temp ${p.temperature} · top_p ${p.topP} · seed ${p.seed ?? 'none'} · max ${p.maxTokens}`;
  });

  constructor() {
    void this.load();
  }

  /**
   * Typed as a string because a component generic is not inferred through a
   * template binding, and a cast at the boundary is worse than one check.
   */
  protected setStyle(style: string): void {
    if (style !== 'masked' && style !== 'raw') return;
    this.style.set(style);
    void this.load();
  }

  protected async load(): Promise<void> {
    this.error.set(null);
    try {
      const chosen = this.style();
      this.preview.set(
        await this.#api.preview(
          this.#data.rowId,
          this.#data.locale,
          chosen === null ? undefined : chosen,
        ),
      );
    } catch (error) {
      this.preview.set(null);
      this.error.set(messageOf(error));
    }
  }

  /**
   * The prompt on the clipboard, in the shape it is sent: system then user.
   *
   * For pasting into a model's own playground — which is the fastest way to
   * find out whether a disappointing draft is the prompt's fault or the
   * model's.
   */
  protected async copy(): Promise<void> {
    const p = this.preview();
    if (p === null) return;
    const text = `### SYSTEM\n${p.blocks
      .filter((b) => b.role === 'system' && b.content !== '')
      .map((b) => b.content)
      .join('\n\n')}\n\n### USER\n${p.blocks.find((b) => b.role === 'user')?.content ?? ''}`;
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      // Clipboard access can be refused; the text is on screen either way.
      this.error.set('The clipboard is not available. Select the text instead.');
    }
  }

  protected async run(): Promise<void> {
    const chosen = this.style();
    const result = await this.translate.translate(this.#data.rowId, this.#data.locale, {
      // Only when the user actually chose one, so a run started from the
      // preview uses exactly what the preview asked the server for.
      ...(chosen === null ? {} : { placeholderStyle: chosen }),
    });
    // Closing on a rejection would hide the reason. The panel behind shows an
    // accepted draft immediately, so there is nothing left to see here.
    if (result?.ok === true) this.ref.close(true);
  }
}

/** Four ramp tones, cycled, so adjacent blocks in the meter stay distinguishable. */
const TONES = [
  'accent',
  'accent-muted',
  'warn',
  'danger',
] as const satisfies readonly BarSegment['tone'][];

function messageOf(error: unknown): string {
  const body = (error as { error?: { error?: { message?: string } } }).error;
  return body?.error?.message ?? 'The prompt could not be composed.';
}
