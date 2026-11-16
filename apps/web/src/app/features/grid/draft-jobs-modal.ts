// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';

import { UnitsApi } from '../../core/api/units-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { defaultJobTitle, etaText, localesText } from '../../core/job-math.js';
import { localeName } from '../../core/locale-name.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { ToastStore } from '../../core/stores/toast-store.js';
import { LxButton } from '../../ui/button.js';
import { LxField, LxInput } from '../../ui/field.js';
import { LxModalShell } from '../../ui/modal.js';
import { LxSegmentedControl, type SegmentOption } from '../../ui/segmented-control.js';
import { loadDraftScope, type DraftCandidate } from './draft-scope.js';

type RunOrder = 'listed' | 'small';

interface LocaleRow {
  readonly locale: string;
  readonly name: string;
  readonly rtl: boolean;
  readonly total: number;
  /** The number of the active job that already holds this locale, if any. */
  readonly lockedBy: number | null;
  readonly on: boolean;
  /** Locked, or nothing in scope to draft. */
  readonly disabled: boolean;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * S15 — "Translate": queue ONE job that drafts the current Grid
 * scope into several locales, one after another.
 *
 * The scope is the Grid's filters, read-only here ("Change in Grid" closes the
 * dialog); each locale counts its own units under them (`draft-scope.ts`). A
 * locale an active draft job already holds is locked and names that job — the
 * server refuses the same set, so the two never disagree.
 *
 * Queueing closes the dialog and says so in a toast that links to the Jobs
 * page — the same way "Translate N cells" does. A failure keeps the dialog
 * open with the reason, so the pick can be changed and sent again.
 */
@Component({
  selector: 'lx-draft-jobs-modal',
  imports: [LxButton, LxField, LxInput, LxModalShell, LxSegmentedControl],
  template: `
    <lx-modal-shell
      size="sm"
      title="Translate"
      subtitle="Runs as one job. Locales are drafted one after another."
    >
      <div class="sections">
        <section>
          <div class="section-head">
            <span class="lx-caption">Scope from Grid filters</span>
            <span class="lx-spacer"></span>
            <button type="button" class="link" (click)="ref.close()">Change in Grid</button>
          </div>
          <div class="chips">
            @for (chip of chips(); track chip) {
              <span class="chip">{{ chip }}</span>
            }
          </div>
        </section>

        <lx-field label="Name" hint="Shown on the Jobs page. Leave it as is for the default.">
          <input
            lxInput
            type="text"
            maxlength="120"
            [value]="name()"
            [placeholder]="defaultName()"
            (input)="editName($any($event.target).value)"
            (blur)="settleName()"
          />
        </lx-field>

        <section>
          <div class="section-head">
            <span class="lx-caption" id="draft-locales-label">Locales</span>
            <span class="picked">{{ selected().length }} selected</span>
            <span class="lx-spacer"></span>
            <button type="button" class="link" (click)="selectAll()">Select all</button>
            <button type="button" class="link" (click)="selectNone()">None</button>
          </div>
          @if (!settings.configured()) {
            <p class="note">Set a model in Settings before drafting.</p>
          } @else if (loading()) {
            <p class="note" aria-busy="true">Counting units per locale…</p>
          } @else if (loadError(); as error) {
            <p class="note note--danger" role="alert">{{ error }}</p>
          } @else {
            <div class="locales" role="group" aria-labelledby="draft-locales-label">
              @for (row of rows(); track row.locale) {
                <button
                  type="button"
                  role="checkbox"
                  class="locale"
                  [attr.aria-checked]="row.on"
                  [attr.data-on]="row.on"
                  [attr.data-locked]="row.lockedBy !== null"
                  [disabled]="row.disabled"
                  [title]="
                    row.lockedBy !== null
                      ? 'Already in job #' + row.lockedBy
                      : row.total === 0
                        ? 'Nothing in this scope needs drafting here'
                        : ''
                  "
                  (click)="toggle(row)"
                >
                  <span class="box" aria-hidden="true">{{ row.on ? '✓' : '' }}</span>
                  <span class="code">{{ row.locale }}</span>
                  <span class="name">{{ row.name }}</span>
                  @if (row.rtl) {
                    <span class="lx-mono rtl">RTL</span>
                  }
                  <span class="lx-spacer"></span>
                  @if (row.lockedBy !== null) {
                    <span class="lx-mono locked">in #{{ row.lockedBy }}</span>
                  } @else {
                    <span class="lx-mono lx-num count">{{ fmt(row.total) }}</span>
                  }
                </button>
              } @empty {
                <p class="note">No target locales in this project.</p>
              }
            </div>
          }
        </section>

        <section>
          <div class="section-head">
            <span class="lx-caption" id="draft-order-label">Run order</span>
          </div>
          <div class="order">
            <lx-segmented-control
              [options]="orders"
              [value]="order()"
              (valueChange)="order.set($event)"
              ariaLabelledby="draft-order-label"
            />
            <span class="lx-mono sequence" [attr.data-empty]="sequence().length === 0">
              {{ sequence().length === 0 ? 'Pick at least one locale' : sequence().join('  →  ') }}
            </span>
          </div>
        </section>
      </div>

      @if (queueError(); as error) {
        <div class="banner" role="alert">{{ error }}</div>
      }

      <ng-container modal-footer>
        <span class="summary">{{ summary() }}</span>
        <span class="lx-spacer"></span>
        <button type="button" lx-button (click)="ref.close()">Cancel</button>
        <button
          type="button"
          lx-button
          variant="primary"
          [disabled]="!canQueue()"
          (click)="queue()"
        >
          {{ queueLabel() }}
        </button>
      </ng-container>
    </lx-modal-shell>
  `,
  styles: `
    .sections {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-18);
    }
    .section-head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      margin-bottom: var(--lx-sp-8);
    }
    .picked {
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-subtle);
    }
    .link {
      padding: 0;
      background: none;
      font-size: var(--lx-fs-11-5);
      color: var(--lx-accent-on-tint);
    }
    .link:hover {
      color: var(--lx-text-primary);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--lx-sp-6);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      height: 26px;
      padding: 0 9px;
      border: 1px solid var(--lx-accent-tint-border);
      border-radius: var(--lx-r-6);
      background: var(--lx-accent-tint-bg);
      font-size: var(--lx-fs-11-5);
      color: var(--lx-accent-on-tint);
    }
    .locales {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--lx-sp-6);
    }
    .locale {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-10);
      height: 38px;
      padding: 0 12px;
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-titlebar);
      text-align: left;
      cursor: pointer;
    }
    .locale[data-on='true'] {
      border-color: var(--lx-accent-tint-border);
      background: var(--lx-accent-tint-bg);
    }
    .locale:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .box {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 15px;
      height: 15px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-4);
      font-size: var(--lx-fs-10);
      font-weight: var(--lx-fw-700);
      color: var(--lx-accent-on);
    }
    .locale[data-on='true'] .box {
      border-color: var(--lx-accent);
      background: var(--lx-accent);
    }
    .code {
      font-size: var(--lx-fs-12-5);
      font-weight: var(--lx-fw-600);
      color: var(--lx-text-primary);
    }
    .name {
      overflow: hidden;
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-subtle);
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .rtl {
      padding: 0 4px;
      border: 1px solid var(--lx-neutral-tint-border);
      border-radius: var(--lx-r-3);
      font-size: var(--lx-fs-9-5);
      color: var(--lx-text-subtle);
    }
    .count {
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-mono);
    }
    .locked {
      font-size: var(--lx-fs-10-5);
      color: var(--lx-text-subtle);
    }
    .order {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-14);
    }
    .sequence {
      font-size: var(--lx-fs-12);
      color: var(--lx-text-mono);
      white-space: pre;
    }
    .sequence[data-empty='true'] {
      color: var(--lx-text-faint-2);
    }
    .note {
      font-size: var(--lx-fs-12);
      color: var(--lx-text-faint);
    }
    .note--danger {
      color: var(--lx-danger-on-tint);
    }
    .banner {
      margin-top: var(--lx-sp-18);
      padding: 10px 12px;
      border: 1px solid var(--lx-danger-border-soft);
      border-radius: var(--lx-r-7);
      background: var(--lx-danger-tint-bg);
      font-size: var(--lx-fs-12-5);
      color: var(--lx-danger-on-tint);
    }
    .summary {
      font-size: var(--lx-fs-12-5);
      color: var(--lx-text-mono);
    }
  `,
})
export class LxDraftJobsModal {
  protected readonly ref = inject<DialogRef<void, LxDraftJobsModal>>(DialogRef);
  protected readonly settings = inject(SettingsStore);
  readonly #grid = inject(GridStore);
  readonly #project = inject(ProjectStore);
  readonly #jobs = inject(JobsStore);
  readonly #units = inject(UnitsApi);
  readonly #toasts = inject(ToastStore);

  protected readonly fmt = fmt;

  protected readonly orders: readonly SegmentOption<RunOrder>[] = [
    { value: 'listed', label: 'As listed' },
    { value: 'small', label: 'Smallest first' },
  ];

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly candidates = signal<readonly DraftCandidate[]>([]);
  protected readonly chips = signal<readonly string[]>([]);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly order = signal<RunOrder>('listed');
  protected readonly busy = signal(false);
  protected readonly queueError = signal<string | null>(null);

  readonly #locked = computed(() => this.#jobs.locked('draft'));
  readonly #rtl = computed(
    () =>
      new Set(
        this.#project
          .targetLocales()
          .filter((l) => l.isRtl)
          .map((l) => l.locale),
      ),
  );

  protected readonly rows = computed<readonly LocaleRow[]>(() => {
    const locked = this.#locked();
    const picked = this.picked();
    return this.candidates().map((c) => {
      const lockedBy = locked.get(c.locale) ?? null;
      const disabled = lockedBy !== null || c.total === 0;
      return {
        locale: c.locale,
        name: localeName(c.locale),
        rtl: this.#rtl().has(c.locale),
        total: c.total,
        lockedBy,
        on: !disabled && picked.has(c.locale),
        disabled,
      };
    });
  });

  /** The picked, pickable locales in run order — what the job will store. */
  protected readonly selected = computed<readonly DraftCandidate[]>(() => {
    const on = new Set(
      this.rows()
        .filter((r) => r.on)
        .map((r) => r.locale),
    );
    const chosen = this.candidates().filter((c) => on.has(c.locale));
    return this.order() === 'small' ? [...chosen].sort((a, b) => a.total - b.total) : chosen;
  });

  protected readonly sequence = computed(() => this.selected().map((c) => c.locale));

  /**
   * The Name field. Until the user types in it, it shows the title the job
   * would get anyway (`jobTitle`'s rule over the run order) and follows the
   * selection; `null` means "not edited". Emptying it hands it back to the
   * default.
   */
  readonly #nameEdit = signal<string | null>(null);
  protected readonly defaultName = computed(() => defaultJobTitle('draft', this.sequence()));
  protected readonly name = computed(() => this.#nameEdit() ?? this.defaultName());
  readonly #unitTotal = computed(() => this.selected().reduce((n, c) => n + c.total, 0));

  protected readonly summary = computed(() => {
    const n = this.selected().length;
    if (n === 0) return 'No locales selected';
    const units = this.#unitTotal();
    return `${localesText(n)} · ${fmt(units)} units · ${etaText(units)}`;
  });

  protected readonly canQueue = computed(
    () => this.selected().length > 0 && !this.busy() && this.settings.configured(),
  );
  protected readonly queueLabel = computed(() => {
    const n = this.selected().length;
    return n === 0 ? 'Queue job' : `Queue job · ${localesText(n)}`;
  });

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const scope = await loadDraftScope(
        this.#units,
        this.#grid.queryBody(),
        this.#grid.availableLocales(),
      );
      this.candidates.set(scope.candidates);
      this.chips.set(scope.chips);
      // Seed from the visible columns: what the user is looking at is the
      // likeliest answer. Locked rows and empty ones fall out in `rows`.
      const visible = new Set(this.#grid.visibleLocales());
      this.picked.set(
        new Set(scope.candidates.filter((c) => visible.has(c.locale)).map((c) => c.locale)),
      );
    } catch (error) {
      this.loadError.set(messageOf(error, 'The units in scope could not be counted.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected toggle(row: LocaleRow): void {
    if (row.disabled) return;
    this.#clearMessages();
    this.picked.update((set) => {
      const next = new Set(set);
      if (!next.delete(row.locale)) next.add(row.locale);
      return next;
    });
  }

  protected selectAll(): void {
    this.#clearMessages();
    this.picked.set(
      new Set(
        this.rows()
          .filter((r) => !r.disabled)
          .map((r) => r.locale),
      ),
    );
  }

  protected selectNone(): void {
    this.#clearMessages();
    this.picked.set(new Set());
  }

  protected editName(value: string): void {
    this.#nameEdit.set(value);
  }

  /** On blur: an emptied field goes back to the default, and to following the selection. */
  protected settleName(): void {
    if (this.#nameEdit()?.trim() === '') this.#nameEdit.set(null);
  }

  /** The name to send: only one the user typed, and not just the default retyped. */
  #customName(): string | undefined {
    const name = this.#nameEdit()?.trim();
    return name === undefined || name === '' || name === this.defaultName() ? undefined : name;
  }

  protected async queue(): Promise<void> {
    // Captured now: once the job exists its locales are locked, and the live
    // selection (and its unit total) empties before the toast is written.
    const chosen = this.selected();
    const units = this.#unitTotal();
    const name = this.#customName();
    if (chosen.length === 0 || this.busy()) return;
    this.busy.set(true);
    this.queueError.set(null);
    try {
      const job = await this.#jobs.create({
        task: 'draft',
        locales: chosen.map((c) => ({ locale: c.locale, ids: [...c.ids] })),
        ...(name === undefined ? {} : { name }),
      });
      this.#toasts.show({
        tone: 'accent',
        title:
          name === undefined ? `Job #${job.number} queued` : `Job #${job.number} queued · ${name}`,
        detail: `${localesText(chosen.length)}: ${chosen.map((c) => c.locale).join(', ')} · ${fmt(units)} units`,
        action: { label: 'View jobs', route: '/jobs' },
      });
      this.ref.close();
    } catch (error) {
      this.queueError.set(messageOf(error, 'The job could not be queued.'));
    } finally {
      this.busy.set(false);
    }
  }

  #clearMessages(): void {
    this.queueError.set(null);
  }
}
