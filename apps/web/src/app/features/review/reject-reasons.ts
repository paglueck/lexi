// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, input, model, signal } from '@angular/core';
import { REJECT_REASONS, type RejectReason } from '@lexi/shared/constants';

/** What each stored reason code reads as. The codes are what travel; these are for people. */
export const REASON_LABEL: Readonly<Record<RejectReason, string>> = {
  'wrong-term': 'Wrong term',
  'ignores-glossary': 'Ignores term base',
  'too-long': 'Too long',
  'wrong-register': 'Wrong register',
  'placeholder-misplaced': 'Placeholder misplaced',
};

/**
 * S11's reject-reason chips (M14).
 *
 * The chips are a FIXED VOCABULARY plus one free note, rather than a text box.
 * Two things depend on it: the reason is stored in `.lexi/review-notes.json`
 * for the next person, where a sentence someone typed in a hurry ages badly;
 * and it is fed back into the re-draft prompt, where five consistent phrases
 * give the model something it can act on and free prose gives it noise.
 *
 * Selecting a reason does not reject anything — the action bar still has to be
 * used. A chip that rejected on click would make the most destructive action on
 * the screen the easiest one to hit by accident.
 */
@Component({
  selector: 'lx-reject-reasons',
  template: `
    <div class="head">
      <span class="lx-caption">Reject reason</span>
      <span class="hint">Optional, stored with the unit and fed back into the re-draft prompt</span>
    </div>
    <div class="chips">
      @for (reason of reasons; track reason) {
        <button
          type="button"
          class="chip"
          [attr.aria-pressed]="isSelected(reason)"
          (click)="toggle(reason)"
        >
          {{ label(reason) }}
        </button>
      }
      @if (noteOpen()) {
        <input
          class="note lx-input"
          type="text"
          maxlength="200"
          placeholder="Add a note…"
          [value]="note()"
          (input)="onNote($event)"
        />
      } @else {
        <button type="button" class="chip chip--add" (click)="noteOpen.set(true)">Add note…</button>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      padding: var(--lx-sp-14);
      border: 1px solid var(--lx-border-table);
      border-radius: var(--lx-r-9);
      background: var(--lx-bg-rail);
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--lx-sp-8);
      margin-bottom: var(--lx-sp-10);
    }
    .hint {
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--lx-sp-7);
    }
    .chip {
      padding: var(--lx-sp-4) var(--lx-sp-10);
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-raised);
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12);
      cursor: pointer;
    }
    .chip[aria-pressed='true'] {
      border-color: var(--lx-danger-tint-border);
      background: var(--lx-danger-tint-bg);
      color: var(--lx-danger-on-tint);
      font-weight: var(--lx-fw-600);
    }
    .chip--add {
      border-style: dashed;
      color: var(--lx-text-muted);
    }
    .note {
      min-width: 220px;
      height: 28px;
      font-size: var(--lx-fs-12);
    }
  `,
})
export class LxRejectReasons {
  /** The codes for the fixed chips. Two-way, so the page can clear them per unit. */
  readonly selected = model.required<readonly RejectReason[]>();
  /** The free note, carried alongside the codes rather than mixed into them. */
  readonly note = model<string>('');
  /** Reasons already on file for this unit, shown as pre-selected. */
  readonly stored = input<readonly string[]>([]);

  protected readonly reasons = REJECT_REASONS;
  protected readonly noteOpen = signal(false);

  protected readonly selectedSet = computed(() => new Set(this.selected()));

  protected isSelected(reason: RejectReason): boolean {
    return this.selectedSet().has(reason);
  }

  protected label(reason: RejectReason): string {
    return REASON_LABEL[reason];
  }

  protected toggle(reason: RejectReason): void {
    this.selected.update((list) =>
      list.includes(reason) ? list.filter((r) => r !== reason) : [...list, reason],
    );
  }

  protected onNote(event: Event): void {
    this.note.set((event.target as HTMLInputElement).value);
  }
}

/** The codes plus the note, as the PATCH and the re-draft prompt both want them. */
export const reasonsPayload = (
  selected: readonly RejectReason[],
  note: string,
): readonly string[] => {
  const trimmed = note.trim();
  return trimmed === '' ? [...selected] : [...selected, trimmed];
};

/** The same reasons, spelled out — what the model is told, and what a person reads. */
export const reasonsSpoken = (reasons: readonly string[]): readonly string[] =>
  reasons.map((r) => REASON_LABEL[r as RejectReason] ?? r);
