// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject, signal } from '@angular/core';
import type { PlaceholderStyle, TranslateUnitResponse } from '@lexi/shared';

import { PromptApi } from '../api/prompt-api.js';
import { DraftStore } from './draft-store.js';

/**
 * Drafting with the local model, as the screens see it (M9).
 *
 * An accepted draft is an ORDINARY PENDING EDIT — the server put it in the same
 * overlay a typed edit goes into — so it is pushed straight into `DraftStore`
 * and every surface that already renders drafts renders it with no further
 * work: the grid cell, the detail panel, the unsaved count, the save path.
 *
 * What this store owns is only what is specific to a run: whether one is in
 * flight, what the model actually answered, and why a draft was refused. That
 * last one is the reason the rejection is kept rather than turned into an error
 * toast — "the model dropped INTERPOLATION" is a finding about the model, and
 * the point of the MVP is to learn things like it.
 */

const keyOf = (rowId: string, locale: string): string => `${rowId} ${locale}`;

/** What the model did, for the cell it did it to. */
export interface RunRecord {
  readonly rowId: string;
  readonly locale: string;
  readonly result: TranslateUnitResponse;
}

export interface TranslateOptions {
  readonly placeholderStyle?: PlaceholderStyle;
  readonly instruction?: string;
  readonly overwrite?: boolean;
}

/** A refusal the user can answer — FR-6.10's "this was written by a person". */
export interface OverwritePrompt {
  readonly rowId: string;
  readonly locale: string;
  readonly existing: string;
  readonly message: string;
  readonly options: TranslateOptions;
}

@Injectable({ providedIn: 'root' })
export class TranslateStore {
  readonly #api = inject(PromptApi);
  readonly #drafts = inject(DraftStore);

  readonly #running = signal<string | null>(null);
  readonly #runs = signal<ReadonlyMap<string, RunRecord>>(new Map());
  readonly #error = signal<string | null>(null);
  readonly #confirm = signal<OverwritePrompt | null>(null);

  /** The cell a request is in flight for, so one button can show a spinner. */
  readonly running = this.#running.asReadonly();
  readonly error = this.#error.asReadonly();
  /** Set when the server refused to replace a human translation. */
  readonly confirm = this.#confirm.asReadonly();
  readonly isRunning = computed(() => this.#running() !== null);

  runFor(rowId: string, locale: string): RunRecord | undefined {
    return this.#runs().get(keyOf(rowId, locale));
  }

  runningFor(rowId: string, locale: string): boolean {
    return this.#running() === keyOf(rowId, locale);
  }

  /**
   * Draft one unit. Resolves to the response, or null when the call itself
   * failed — which is a different thing from a draft the gates refused, and the
   * two are reported differently on purpose.
   */
  async translate(
    rowId: string,
    locale: string,
    options: TranslateOptions = {},
  ): Promise<TranslateUnitResponse | null> {
    if (this.#running() !== null) return null;
    this.#running.set(keyOf(rowId, locale));
    this.#error.set(null);
    this.#confirm.set(null);

    try {
      const result = await this.#api.translate(rowId, locale, options);
      this.#record(rowId, locale, result);
      // The same path a typed edit takes. Nothing about a machine draft is
      // special once it has passed the gates — so the grid cell, the unsaved
      // count and the save button all move without this store knowing they exist.
      if (result.ok && result.target !== null) {
        this.#drafts.adopt(rowId, locale, result.target, result.unsavedCount);
      }
      return result;
    } catch (error) {
      const conflict = overwriteConflict(error);
      if (conflict !== null) {
        this.#confirm.set({ rowId, locale, ...conflict, options });
      } else {
        this.#error.set(messageOf(error));
      }
      return null;
    } finally {
      this.#running.set(null);
    }
  }

  /** The user said yes to the overwrite. Same call, one flag more. */
  async confirmOverwrite(): Promise<TranslateUnitResponse | null> {
    const pending = this.#confirm();
    if (pending === null) return null;
    this.#confirm.set(null);
    return this.translate(pending.rowId, pending.locale, { ...pending.options, overwrite: true });
  }

  dismissConfirm(): void {
    this.#confirm.set(null);
  }

  clearError(): void {
    this.#error.set(null);
  }

  /** Runs belong to the project that produced them. */
  reset(): void {
    this.#runs.set(new Map());
    this.#running.set(null);
    this.#error.set(null);
    this.#confirm.set(null);
  }

  #record(rowId: string, locale: string, result: TranslateUnitResponse): void {
    const next = new Map(this.#runs());
    next.set(keyOf(rowId, locale), { rowId, locale, result });
    this.#runs.set(next);
  }
}

/** The 409 FR-6.10 produces, told apart from every other failure. */
function overwriteConflict(error: unknown): { existing: string; message: string } | null {
  const status = (error as { status?: number }).status;
  const body = (
    error as { error?: { error?: { code?: string; message?: string; details?: unknown } } }
  ).error?.error;
  if (status !== 409 || body?.code !== 'conflict') return null;
  const existing = (body.details as { existing?: unknown } | undefined)?.existing;
  return {
    existing: typeof existing === 'string' ? existing : '',
    message: body.message ?? 'This translation was written by a person.',
  };
}

function messageOf(error: unknown): string {
  const body = (error as { error?: { error?: { message?: string } } }).error;
  return body?.error?.message ?? 'The model could not be reached.';
}
