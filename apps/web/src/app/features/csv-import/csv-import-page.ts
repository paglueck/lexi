// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  ElementRef,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  tokenText,
  type CsvImportApplyRequest,
  type CsvImportApplyResponse,
  type CsvImportPreviewResponse,
  type CsvImportRow,
  type CsvImportUndoResponse,
} from '@lexi/shared';

import { CsvImportApi } from '../../core/api/csv-import-api.js';
import { messageOf } from '../../core/api/server-message.js';
import { jobDisplayName } from '../../core/job-math.js';
import { CsvImportStore, type CsvImportOrigin } from '../../core/stores/csv-import-store.js';
import { JobsStore } from '../../core/stores/jobs-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { LxButton } from '../../ui/button.js';
import { LxSegmentedControl, type SegmentOption } from '../../ui/segmented-control.js';
import { LxImportDetail } from './import-detail.js';
import { LxImportFooter } from './import-footer.js';
import {
  applyLabel,
  baselineLine,
  chipOf,
  counts,
  finalizableCount,
  localeOptions,
  openConflicts,
  summary,
  toWrite,
  visibleRows,
  type Filter,
  type ImportChip,
  type Resolution,
} from './import-model.js';
import { LxImportRow } from './import-row.js';

type View = 'inline' | 'split';

/**
 * The part of an import a failed save DID write: the server kept those files
 * and named the rest. Until it is undone the files are half old, half new.
 */
interface PartialImport {
  readonly importId: string;
  readonly notWritten: readonly string[];
}

/** `nl.xliff`, `nl.xliff and tr.xliff`, `de.xliff, nl.xliff and tr.xliff`. */
function fileList(paths: readonly string[]): string {
  const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The 409 envelope's `details` for a partial save; null for any other refusal. */
function partialOf(error: unknown): PartialImport | null {
  const body = (error as { error?: unknown } | null)?.error;
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details as
    { importId?: unknown; notWritten?: unknown } | undefined;
  if (typeof details?.importId !== 'string') return null;
  return {
    importId: details.importId,
    notWritten: Array.isArray(details.notWritten)
      ? details.notWritten.filter((f): f is string => typeof f === 'string')
      : [],
  };
}

const TABS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All changes' },
  { value: 'change', label: 'Changed' },
  { value: 'conflict', label: 'Conflicts' },
  { value: 'error', label: 'Not importable' },
  { value: 'same', label: 'Unchanged' },
];

const VIEWS: readonly SegmentOption<View>[] = [
  { value: 'inline', label: 'Inline' },
  { value: 'split', label: 'Split' },
];

/**
 * S16, Import reviewed CSV: the reviewer's file next to what Lexi holds, row
 * by row, before anything is written.
 *
 * The page holds the review's state (README "State") and nothing about how a
 * rule reads: which rows a tab lists, what a chip says and what Apply would
 * write are `import-model`'s pure functions over that state. Everything a
 * choice touches is keyed on the preview, so picking another file starts the
 * review over instead of carrying ticks onto rows that merely share a line
 * number. Only the diff view, a reading preference, survives a new file.
 *
 * Nothing is written from here until Apply; the store only ever holds the
 * server's preview.
 */
@Component({
  selector: 'lx-csv-import-page',
  imports: [RouterLink, LxButton, LxSegmentedControl, LxImportRow, LxImportDetail, LxImportFooter],
  templateUrl: './csv-import-page.html',
  styleUrl: './csv-import-page.css',
})
export class CsvImportPage {
  readonly #store = inject(CsvImportStore);
  readonly #api = inject(CsvImportApi);
  readonly #router = inject(Router);
  readonly #jobs = inject(JobsStore);
  readonly #project = inject(ProjectStore);
  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly picker = viewChild<ElementRef<HTMLInputElement>>('picker');

  /**
   * Where the import started, kept for the page's life: a new pick clears the
   * store's origin while it runs, and the page still has to know where "Choose
   * another file…" and the breadcrumb lead.
   */
  readonly #origin: CsvImportOrigin = this.#store.origin() ?? { grid: true };

  protected readonly preview = this.#store.preview;
  protected readonly busy = this.#store.busy;
  protected readonly error = this.#store.error;
  protected readonly rows = computed(() => this.preview()?.rows ?? []);

  // ---- state (README "State") ----
  protected readonly selectedKey = this.#perPreview<string | null>(() => null);
  protected readonly filter = this.#perPreview<Filter>(() => 'all');
  protected readonly localeFilter = this.#perPreview<string>(() => 'all');
  protected readonly view = signal<View>('inline');
  /** Changes the user unticked. */
  protected readonly excluded = this.#perPreview<ReadonlySet<string>>(() => new Set());
  protected readonly resolution = this.#perPreview<Resolution>(() => new Map());
  protected readonly targetState = signal<CsvImportApplyRequest['state']>('final');
  /** Unchanged rows the reviewer confirmed become final too; on unless unticked. */
  protected readonly finalizeUnchanged = signal(true);
  /** How many cells Apply marked final as they were; the banner names them. */
  protected readonly finalized = this.#perPreview(() => 0);
  protected readonly applied = this.#perPreview(() => false);
  /** What Apply wrote; the banner names it and Undo sends its id back. */
  protected readonly result = this.#perPreview<CsvImportApplyResponse | null>(() => null);
  /** The server's sentence for a refused Apply or Undo. */
  protected readonly failure = this.#perPreview<string | null>(() => null);
  /**
   * A partly written import, kept apart from `failure` on purpose: whatever
   * happens next (another Apply, a failed Undo) the handle to undo it must not
   * be lost. Only its own successful Undo clears it, and until then Apply is
   * blocked, since a retry would meet the cells it already wrote and fail stale.
   */
  protected readonly pendingUndo = this.#perPreview<PartialImport | null>(() => null);
  protected readonly undone = this.#perPreview<CsvImportUndoResponse | null>(() => null);
  /** An Apply or Undo is in flight. */
  protected readonly sending = signal(false);

  // ---- derived ----
  protected readonly visible = computed(() =>
    visibleRows(this.rows(), this.filter(), this.localeFilter()),
  );
  protected readonly tabCounts = computed(() =>
    counts(this.rows(), this.localeFilter(), this.resolution()),
  );
  /** The selected row, or the first one listed once the selection is filtered out. */
  protected readonly selected = computed<CsvImportRow | null>(() => {
    const visible = this.visible();
    return visible.find((r) => r.key === this.selectedKey()) ?? visible[0] ?? null;
  });
  protected readonly toWrite = computed(() =>
    toWrite(this.rows(), this.excluded(), this.resolution()),
  );
  protected readonly openConflicts = computed(() => openConflicts(this.rows(), this.resolution()));
  protected readonly finalizable = computed(() => finalizableCount(this.rows()));
  /** The cells Apply would mark final: none while the box is unticked. */
  readonly #finals = computed(() => (this.finalizeUnchanged() ? this.finalizable() : 0));
  /**
   * An applied import that was undone is still a record, not a fresh review:
   * Apply stays off, but the footer must not go on saying it was applied.
   */
  readonly #undoneApplied = computed(() => this.applied() && this.undone() !== null);
  protected readonly applyState = computed(() =>
    this.#undoneApplied()
      ? { label: 'Undone', ready: false }
      : applyLabel(
          this.toWrite().length,
          this.openConflicts().length,
          this.applied(),
          this.#finals(),
        ),
  );
  protected readonly summary = computed(() => {
    if (this.#undoneApplied()) return 'Import undone';
    return this.applied()
      ? 'Import applied'
      : summary(this.rows(), this.excluded(), this.resolution(), this.#finals());
  });
  protected readonly exportedAt = computed(() => this.preview()?.baseline?.at ?? null);
  protected readonly sourceLocale = this.#project.sourceLocale;

  /** `Wrote 2 units to nl.xliff and tr.xliff as final. …` */
  protected readonly appliedText = computed(() => {
    const result = this.result();
    if (result === null) return '';
    const n = result.written.reduce((sum, w) => sum + w.count, 0);
    const files = fileList(result.written.map((w) => w.path));
    const units = (k: number): string => `${k} ${k === 1 ? 'unit' : 'units'}`;
    // Cells marked final as they were count among the written ones.
    const f = this.finalized();
    const w = n - f;
    if (w === 0) {
      return `Marked ${units(f)} final in ${files}. Undo restores the previous states.`;
    }
    const finals = f === 0 ? '' : ` and marked ${f} unchanged final`;
    return `Wrote ${units(w)} to ${files} as ${this.targetState()}${finals}. Undo restores the previous targets.`;
  });
  protected readonly undoneText = computed(() => {
    const undone = this.undone();
    if (undone === null) return '';
    const k = undone.skipped.length;
    const skipped = k > 0 ? `, ${k} skipped because they changed since` : '';
    return `Import undone. ${undone.restored} restored${skipped}`;
  });
  protected readonly applyBlocked = computed(() =>
    this.pendingUndo() === null ? '' : 'Undo the partly written import first',
  );
  protected readonly backLabel = 'grid' in this.#origin ? 'Back to Grid' : 'Back to Jobs';

  protected readonly tabs = TABS;
  protected readonly views = VIEWS;
  protected readonly locales = computed(() => localeOptions(this.rows()));
  protected readonly fromGrid = 'grid' in this.#origin;

  /** `#13 Draft untranslated units · nl, tr` (or the job's name), once the job is in the store. */
  protected readonly jobCrumb = computed(() => {
    const origin = this.#origin;
    if (!('jobId' in origin)) return null;
    const job = this.#jobs.jobs().find((j) => j.id === origin.jobId);
    return job === undefined ? null : `#${job.number} ${jobDisplayName(job)}`;
  });
  protected readonly baseline = computed(() => {
    const preview = this.preview();
    return preview === null ? '' : baselineLine(preview.baseline);
  });

  readonly #projectLocales = computed(
    () => new Set(this.#project.targetLocales().map((l) => l.locale)),
  );

  constructor() {
    if (this.#store.preview() === null) {
      const origin = this.#store.origin();
      void this.#router.navigateByUrl(origin !== null && 'grid' in origin ? '/grid' : '/jobs');
    }
  }

  protected chipFor(row: CsvImportRow): ImportChip {
    return chipOf(row, this.excluded(), this.resolution(), this.applied());
  }

  /** Only a blocked row can carry a locale the project lacks; the server checked the rest. */
  protected invalidLocale(row: CsvImportRow): boolean {
    return row.category === 'blocked' && !this.#projectLocales().has(row.locale);
  }

  /**
   * The Conflicts count is amber while ANY conflict is open, whatever the
   * locale filter shows: Apply waits for all of them, and a count that went
   * grey under `nl` would say the way was clear when it is not.
   */
  protected countTone(filter: Filter): 'warn' | 'danger' | null {
    if (filter === 'conflict') return this.openConflicts().length > 0 ? 'warn' : null;
    return filter === 'error' ? 'danger' : null;
  }

  protected unchangedText(): string {
    const n = this.tabCounts().same;
    return `${n} ${n === 1 ? 'row matches' : 'rows match'} the translation in Lexi exactly. Nothing to apply for them.`;
  }

  protected optionId(row: CsvImportRow): string {
    return `import-row-${row.key.replaceAll(':', '-')}`;
  }

  protected select(row: CsvImportRow): void {
    this.selectedKey.set(row.key);
  }

  /** A change's include box. After Apply the screen is a record, so nothing toggles. */
  protected toggleInclude(row: CsvImportRow): void {
    if (this.applied() || row.category !== 'changed') return;
    this.excluded.update((set) => {
      const next = new Set(set);
      if (!next.delete(row.key)) next.add(row.key);
      return next;
    });
  }

  /** The bulk bar: one choice for every conflict in the file. */
  protected resolveAll(choice: 'csv' | 'current'): void {
    if (this.applied()) return;
    const conflicts = this.rows().filter((r) => r.category === 'conflict');
    this.resolution.update(
      (m) => new Map([...m, ...conflicts.map((r) => [r.key, choice] as const)]),
    );
  }

  /** A conflict's decision from the detail panel's radio cards. */
  protected resolve(row: CsvImportRow, choice: 'csv' | 'current'): void {
    if (this.applied() || row.category !== 'conflict') return;
    this.resolution.update((m) => new Map([...m, [row.key, choice]]));
  }

  /**
   * Apply. With conflicts open it writes nothing and takes the user to the
   * first one instead (README "Footer"). Otherwise it sends the texts the
   * preview was made from, never a fresh read of the files, with the rows to
   * write, each with the cell's text as the preview saw it, so the server can
   * refuse a cell that changed in between rather than overwrite it.
   *
   * A refusal leaves the screen editable: the user can untick the stale row,
   * or go back and pick the file again. A partial save is the exception:
   * Apply waits until the part it wrote is undone.
   */
  protected async apply(): Promise<void> {
    if (this.applied() || this.sending() || this.pendingUndo() !== null) return;
    const open = this.openConflicts()[0];
    if (open !== undefined) {
      this.filter.set('conflict');
      if (!visibleRows(this.rows(), 'conflict', this.localeFilter()).includes(open)) {
        this.localeFilter.set('all');
      }
      this.selectedKey.set(open.key);
      return;
    }
    if (!this.applyState().ready) return;
    const origin = this.#origin;
    this.sending.set(true);
    this.failure.set(null);
    this.undone.set(null);
    try {
      const result = await this.#api.apply({
        files: [...this.#store.files()],
        jobId: 'jobId' in origin ? origin.jobId : null,
        state: this.targetState(),
        finalizeUnchanged: this.finalizeUnchanged(),
        include: this.toWrite().map((r) => ({ key: r.key, current: tokenText(r.current ?? []) })),
      });
      this.finalized.set(this.#finals());
      this.result.set(result);
      this.applied.set(true);
    } catch (error) {
      this.failure.set(messageOf(error, 'The import could not be applied.'));
      this.pendingUndo.set(partialOf(error));
    } finally {
      this.sending.set(false);
    }
  }

  /**
   * Undo an import: the one Apply just wrote, or the part of one a failed
   * save did write. An applied screen stays a record afterwards; the banner
   * says what came back and what did not, because a cell edited since the
   * import is left alone.
   */
  protected async undo(importId: string): Promise<void> {
    if (this.sending()) return;
    this.sending.set(true);
    try {
      this.undone.set(await this.#api.undo(importId));
      this.result.set(null);
      this.failure.set(null);
      if (this.pendingUndo()?.importId === importId) this.pendingUndo.set(null);
    } catch (error) {
      this.failure.set(messageOf(error, 'The import could not be undone.'));
    } finally {
      this.sending.set(false);
    }
  }

  /** Cancel, or "Back to …" once applied: nothing is kept for next time. */
  protected leave(): void {
    this.#store.clear();
    void this.#router.navigateByUrl(this.fromGrid ? '/grid' : '/jobs');
  }

  /** The list's keys: ↑/↓ move the selection, Space ticks or unticks a selected change. */
  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.#move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === ' ') {
      event.preventDefault();
      const row = this.selected();
      if (row !== null) this.toggleInclude(row);
    }
  }

  protected choose(): void {
    const input = this.picker()?.nativeElement;
    if (input === undefined) return;
    input.value = '';
    input.click();
  }

  /** "Choose another file…": a new preview from the same place, which resets the review. */
  protected async onFiles(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.#store.start(files, this.#origin);
  }

  #move(step: 1 | -1): void {
    const visible = this.visible();
    if (visible.length === 0) return;
    const at = visible.findIndex((r) => r.key === this.selected()?.key);
    const next = visible[Math.min(Math.max(at + step, 0), visible.length - 1)]!;
    this.selectedKey.set(next.key);
    this.#host.nativeElement
      .querySelector(`#${this.optionId(next)}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }

  /** A piece of review state that starts over whenever the preview is replaced. */
  #perPreview<T>(initial: () => T) {
    return linkedSignal<CsvImportPreviewResponse | null, T>({
      source: this.#store.preview,
      computation: initial,
    });
  }
}
