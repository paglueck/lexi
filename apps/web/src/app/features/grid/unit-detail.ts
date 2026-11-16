// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { SegmentDto } from '@lexi/shared';

import { LxBadge, LxStateBadge } from '../../ui/badge.js';
import { LxButton } from '../../ui/button.js';
import { LxIcon } from '../../ui/icon.js';
import { LxModalService } from '../../ui/modal.js';
import { LxPlaceholderChip } from '../../ui/placeholder-chip.js';
import { LxSegmentEditor } from '../../ui/segment-editor.js';
import { UnitDetailStore } from '../../core/stores/unit-detail-store.js';
import { EditSessionStore } from '../../core/stores/edit-session-store.js';
import { DraftStore } from '../../core/stores/draft-store.js';
import { GridStore } from '../../core/stores/grid-store.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { TranslateStore } from '../../core/stores/translate-store.js';
import { LxPromptPreview, type PromptPreviewData } from '../../ui/prompt-preview.js';

/**
 * S4's 330 px right panel, now with the editor (M6).
 *
 * EXACTLY ONE TARGET IS EDITABLE — the locale of the selected grid cell,
 * defaulting to the first visible column. S4 draws a single `Target · de` with
 * an editor in it; M5 rendered one read-only section per visible column because
 * on a ten-locale project that is the useful read. This keeps both: the chosen
 * locale gets the editor, the rest stay the summaries they were. It also means
 * only one instance of the riskiest component in the app exists at a time,
 * which is the third of the editor's three safety nets.
 *
 * The LLM buttons work from M9: "Preview prompt" opens S5, "Translate with
 * local model" runs one unit and lands the answer in the same dirty buffer a
 * typed edit uses.
 */
@Component({
  selector: 'lx-unit-detail',
  imports: [
    LxBadge,
    LxStateBadge,
    LxButton,
    LxIcon,
    LxPlaceholderChip,
    LxSegmentEditor,
    NgTemplateOutlet,
    RouterLink,
  ],
  template: `
    @let d = store.detail();
    @if (store.error(); as error) {
      <p class="placeholder placeholder--failed" role="alert">{{ error }}</p>
    } @else if (!d) {
      <p class="placeholder" [attr.aria-busy]="store.isLoading()">
        {{ store.isLoading() ? 'Loading…' : 'Select a row to see its context.' }}
      </p>
    } @else {
      <section class="sec">
        <span class="lx-caption">Identity</span>
        <div class="idrow">
          <span class="lx-mono id">{{ d.unitId }}</span>
          <lx-badge [tone]="d.customId ? 'accent' : 'warn'" outline>
            {{ d.customId ? 'custom id' : 'hash id' }}
          </lx-badge>
        </div>
        <p class="cap">
          @if (d.customId) {
            Developer-assigned. Stable across an English copy edit (FR-2.5b).
          } @else {
            Auto-generated from the source text. An English copy edit will change this id, and the
            translations attached to it become orphans.
          }
        </p>
      </section>

      <section class="sec">
        <span class="lx-caption">Source · {{ d.sourceLocale }}</span>
        <p class="body">
          @for (s of d.source; track $index) {
            @if (s.k === 'p') {
              <span lx-chip size="panel" [label]="s.equivText || s.id"></span>
            } @else if (s.k === 't') {
              {{ s.v }}
            }
          }
        </p>
      </section>

      @if (d.locations.length > 0) {
        <section class="sec">
          <div class="head">
            <span class="lx-caption">Used in</span>
            @if (d.locations.length > 1) {
              <lx-badge tone="warn" size="xs">{{ d.locations.length }} templates</lx-badge>
            }
          </div>
          @for (loc of d.locations; track loc.sourcefile + loc.linenumber) {
            <div class="lx-mono loc">
              {{ loc.sourcefile }}<span class="line"> :{{ loc.linenumber }}</span>
            </div>
          }
          @if (d.locations.length > 1) {
            <p class="warnline">Shared across several templates — rewording affects all of them.</p>
          }
        </section>
      }

      <section class="sec notes">
        <div class="head">
          <span class="lx-caption">Context notes</span>
          @if (d.notesPending) {
            <span class="lx-caption dirty">unsaved</span>
          }
          <span class="lx-spacer"></span>
          @if (d.notesFile !== null && noteForm() === null) {
            <button
              type="button"
              lx-button
              variant="ghost"
              size="xs"
              class="addnote"
              (click)="startNote(null)"
            >
              <lx-icon name="plus" [size]="12" />
              Add note
            </button>
          }
        </div>
        @for (note of d.notes; track $index; let i = $index) {
          @if (noteForm()?.index === i) {
            <ng-container *ngTemplateOutlet="noteEditor" />
          } @else {
            <div class="note">
              <div class="notehead">
                <span class="lx-mono notefrom" [attr.data-kind]="note.from">
                  {{ note.from === null ? 'note' : 'from="' + note.from + '"' }}
                </span>
                @if (d.notesFile !== null && noteForm() === null) {
                  <button
                    type="button"
                    lx-button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    class="noteedit"
                    title="Edit note"
                    [attr.aria-label]="'Edit note ' + (i + 1)"
                    (click)="startNote(i)"
                  >
                    <lx-icon name="pencil" [size]="12" />
                  </button>
                  @let armed = armedNote() === i;
                  <button
                    type="button"
                    lx-button
                    size="xs"
                    iconOnly
                    class="notedelete"
                    [variant]="armed ? 'danger-soft' : 'ghost'"
                    [attr.title]="armed ? 'Click again to delete this note' : 'Delete note'"
                    [attr.aria-label]="
                      armed ? 'Confirm: delete note ' + (i + 1) : 'Delete note ' + (i + 1)
                    "
                    (click)="deleteNote(i)"
                  >
                    <lx-icon name="trash" [size]="12" />
                  </button>
                }
              </div>
              <span class="body">{{ note.text }}</span>
            </div>
          }
        } @empty {
          @if (noteForm() === null) {
            <p class="cap">
              No note. The durable place for context is the <span class="lx-mono">i18n</span>
              attribute in the template (FR-4.3c).
            </p>
          }
        }
        @if (noteForm()?.index === null) {
          <ng-container *ngTemplateOutlet="noteEditor" />
        }
        @if (drafts.error() && noteError()) {
          <p class="cap failed" role="alert">{{ drafts.error() }}</p>
        }

        <ng-template #noteEditor>
          <div class="noteform">
            @let kind = noteForm()?.from ?? '';
            <select
              class="lx-input notekind"
              aria-label="Kind of note"
              (change)="setNoteFrom($any($event.target).value)"
            >
              <option value="description" [selected]="kind === 'description'">
                Description — where and how it is used
              </option>
              <option value="meaning" [selected]="kind === 'meaning'">
                Meaning — which sense of the word
              </option>
              <option value="" [selected]="kind === ''">Plain note</option>
              @if (kind !== '' && kind !== 'description' && kind !== 'meaning') {
                <!-- A kind the file already used, kept as it is. -->
                <option [value]="kind" selected>from="{{ kind }}"</option>
              }
            </select>
            <textarea
              #noteText
              class="lx-input notetext"
              rows="3"
              aria-label="Note text"
              [value]="noteForm()?.text ?? ''"
              (keydown)="onNoteKey($event)"
              (input)="setNoteText($any($event.target).value)"
            ></textarea>
            @if (d.notesFileIsTemplate) {
              <p class="warnline">
                Written to <span class="lx-mono">{{ d.notesFile }}</span
                >, the extraction template — the next
                <span class="lx-mono">ng extract-i18n</span> overwrites it. The durable place is the
                template's <span class="lx-mono">i18n="meaning|description&#64;&#64;id"</span>.
              </p>
            } @else {
              <p class="cap">
                Written to <span class="lx-mono">{{ d.notesFile }}</span> on Save.
              </p>
            }
            <div class="noteactions">
              <button type="button" lx-button size="xs" (click)="cancelNote()">Cancel</button>
              <button
                type="button"
                lx-button
                size="xs"
                variant="primary"
                [disabled]="(noteForm()?.text ?? '').trim() === ''"
                (click)="saveNote()"
              >
                Keep note <span class="lx-mono chord">⌘↩</span>
              </button>
            </div>
          </div>
        </ng-template>
      </section>

      @for (t of targets(); track t.locale) {
        <!-- A unit the locale's file does not have yet is still editable: the
             element is created on save (FR-1.9). Only a locale with no file at
             all has nowhere to write. Angle brackets are avoided in template
             comments on purpose — Angular parses them as markup. -->
        @let editing = t.locale === editLocale() && !t.noFile;
        <section class="sec" [attr.data-editing]="editing ? 'true' : null">
          <div class="head">
            <span class="lx-caption">Target · {{ t.locale }}</span>
            @if (dirtyFor(t.locale)) {
              <span class="lx-caption dirty">unsaved</span>
            }
            <span class="lx-caption chars">{{ t.charCount }} chars</span>
            <!-- Only where there is something to clear: a locale with no file,
                 no unit yet, or no text has nothing to delete. -->
            @if (!t.noFile && !t.missing && t.charCount > 0) {
              @let armed = armedLocale() === t.locale;
              <button
                type="button"
                lx-button
                size="xs"
                class="clear"
                [variant]="armed ? 'danger-soft' : 'ghost'"
                [iconOnly]="!armed"
                [attr.title]="
                  armed
                    ? 'Click again to delete this translation'
                    : 'Delete the ' + t.locale + ' translation'
                "
                [attr.aria-label]="
                  armed
                    ? 'Confirm: delete the ' + t.locale + ' translation'
                    : 'Delete the ' + t.locale + ' translation'
                "
                (click)="clearTarget(t.locale)"
              >
                <lx-icon name="trash" [size]="13" />
                @if (armed) {
                  Confirm
                }
              </button>
            }
          </div>

          @if (editing && session.inline()) {
            <!-- The grid's overlay holds the one editor while it is open; a
                 second instance here would fight it for the IME (deviation 3). -->
            <p class="cap inline-note">Editing in the grid — Esc there to come back here.</p>
          }
          @if (editing && !session.inline()) {
            <lx-segment-editor
              [value]="t.segments"
              [dir]="t.isRtl ? 'rtl' : 'ltr'"
              [available]="availableIds()"
              [mode]="settings.editorMode()"
              (valueChange)="onEdit($event)"
              (commit)="commitAndAdvance()"
              (revert)="revert()"
            />
          } @else {
            <div class="targetrow">
              <lx-state-badge [state]="t.state" [error]="hasError(t.findings)" />
              <!-- RTL only when the paragraph holds target text: the notices
                   below are English, and inside dir=rtl their full stop lands
                   at the start of the line. -->
              <p
                class="body"
                [attr.dir]="
                  t.isRtl && !t.noFile && !t.missing && t.segments.length > 0 ? 'rtl' : null
                "
              >
                @if (t.noFile) {
                  <span class="cap">No {{ t.locale }} file for this group yet.</span>
                } @else if (t.missing) {
                  <span class="cap">Not in this locale's file yet — writing here adds it.</span>
                } @else {
                  @for (s of t.segments; track $index) {
                    @if (s.k === 'p') {
                      <span lx-chip size="panel" [label]="s.equivText || s.id"></span>
                    } @else if (s.k === 't') {
                      {{ s.v }}
                    }
                  } @empty {
                    <span class="cap">Empty.</span>
                  }
                }
              </p>
            </div>
          }

          @if (editing && t.missing) {
            <p class="cap">
              Saving adds this string to <span class="lx-mono">{{ fileFor(t.locale) }}</span
              >, copied from the source file with its notes and context.
            </p>
          }

          @if (t.noFile) {
            <div class="confirm">
              <button
                type="button"
                lx-button
                size="field"
                [disabled]="creating()"
                (click)="createLocaleFile(t.locale)"
              >
                {{ creating() ? 'Creating…' : 'Create ' + (t.newFile ?? t.locale + ' file') }}
              </button>
            </div>
            <p class="cap">
              An empty file copied from the source, so the prolog, the namespace and the indentation
              match the rest of the project. Remember to register it with your build.
            </p>
          }

          @if (t.missingPlaceholders.length > 0) {
            <div class="missing">
              <span class="cap">Insert missing:</span>
              @for (id of t.missingPlaceholders; track id) {
                <!-- eslint-disable-next-line @angular-eslint/template/interactive-supports-focus --
                     LxPlaceholderChip already sets role="button" and tabindex="0"
                     on the missing variant; the rule cannot see a host binding. -->
                <span
                  lx-chip
                  size="panel"
                  missing
                  [label]="id"
                  (click)="insert(t.locale, id)"
                  (keydown.enter)="insert(t.locale, id)"
                ></span>
              }
            </div>
          }

          @for (f of t.findings; track $index) {
            <div class="finding" [attr.data-tone]="f.severity === 'error' ? 'danger' : 'warn'">
              <span class="lx-badge" aria-hidden="true">{{
                f.severity === 'error' ? '!' : 'i'
              }}</span>
              <span class="body">{{ f.message }}</span>
              <a
                class="to-issues"
                routerLink="/issues"
                [queryParams]="{ rule: f.rule, locale: t.locale, rowId: d.rowId }"
                [attr.aria-label]="'Show this finding in Issues'"
                >Issues →</a
              >
            </div>
          } @empty {
            @if (!t.missing) {
              <div class="finding" data-tone="accent">
                <span class="lx-badge" aria-hidden="true">✓</span>
                <span class="body">No validation findings.</span>
              </div>
            }
          }
        </section>
      }

      @if (drafts.error(); as message) {
        <section class="sec">
          <p class="finding" data-tone="danger">{{ message }}</p>
        </section>
      }

      <!-- What the model did, for the locale being edited (FR-6.14 in miniature).
           A rejection is shown, never swallowed: "the model dropped
           INTERPOLATION" is the finding the MVP exists to collect. -->
      @if (run(); as r) {
        <section class="sec">
          <div class="head">
            <span class="lx-caption">Last run</span>
            <span class="lx-caption chars">{{ r.result.run.latencyMs }} ms</span>
          </div>
          @if (r.result.ok) {
            <p class="cap">
              {{ r.result.run.model }} · {{ r.result.run.placeholderStyle }} placeholders
              @if (r.result.run.confidence) {
                · confidence {{ r.result.run.confidence }}
              }
            </p>
            @if (r.result.run.notesForReviewer; as note) {
              <p class="warnline">Note from the model: {{ note }}</p>
            }
            <!-- The way into S11 for a single draft (M14). An offer, not a
                 redirect: drafting five units in a row is a normal thing to do,
                 and navigating away on the first one would make it impossible. -->
            <a
              class="reviewlink"
              routerLink="/review"
              [queryParams]="{ rowId: r.rowId, locale: r.locale }"
            >
              Draft ready · Review →
            </a>
          } @else {
            <div class="finding" data-tone="danger">
              <span class="lx-badge" aria-hidden="true">!</span>
              <span class="body">{{ r.result.rejection?.detail }}</span>
            </div>
            <p class="cap">
              Nothing was written. The model answered:
              <span class="lx-mono">{{ r.result.run.raw }}</span>
            </p>
          }
        </section>
      }

      @if (translate.confirm(); as ask) {
        <section class="sec">
          <div class="finding" data-tone="warn">
            <span class="lx-badge" aria-hidden="true">!</span>
            <span class="body">{{ ask.message }}</span>
          </div>
          <p class="cap">Current: {{ ask.existing }}</p>
          <div class="confirm">
            <button
              type="button"
              lx-button
              variant="danger-soft"
              size="field"
              (click)="confirmOverwrite()"
            >
              Replace it
            </button>
            <button type="button" lx-button size="field" (click)="translate.dismissConfirm()">
              Keep it
            </button>
          </div>
        </section>
      }

      @if (translate.error(); as message) {
        <section class="sec">
          <p class="finding" data-tone="danger">{{ message }}</p>
        </section>
      }

      <section class="sec actions">
        <button
          type="button"
          lx-button
          variant="primary"
          [disabled]="!canTranslate()"
          [title]="translateHint()"
          (click)="translateUnit()"
        >
          {{ busy() ? 'Translating…' : 'Translate unit' }}
        </button>
        <button
          type="button"
          lx-button
          [disabled]="editLocale() === null"
          (click)="previewPrompt()"
        >
          Preview prompt
        </button>
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: var(--lx-w-panel);
      flex: none;
      background: var(--lx-bg-rail);
      border-left: 1px solid var(--lx-border-section);
      overflow-y: auto;
    }
    .placeholder {
      padding: var(--lx-sp-20) var(--lx-sp-16);
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-12-5);
    }
    .placeholder--failed {
      color: var(--lx-danger);
    }
    .sec {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
      padding: var(--lx-sp-14) var(--lx-sp-16);
      border-bottom: 1px solid var(--lx-border-row);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
    }
    .chars {
      margin-left: auto;
      text-transform: none;
      letter-spacing: 0;
    }
    .clear {
      flex: none;
    }
    .idrow {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-8);
    }
    .id {
      font-size: var(--lx-fs-11-5);
      color: var(--lx-text-primary);
      overflow-wrap: anywhere;
    }
    .cap {
      margin: 0;
      color: var(--lx-text-faint);
      font-size: var(--lx-fs-11-5);
    }
    .body {
      margin: 0;
      color: var(--lx-text-secondary);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
      overflow-wrap: anywhere;
    }
    .loc {
      color: var(--lx-text-muted);
      font-size: var(--lx-fs-11);
      overflow-wrap: anywhere;
    }
    .line {
      color: var(--lx-text-faint-2);
    }
    .reviewlink {
      display: inline-block;
      margin-top: var(--lx-sp-6);
      color: var(--lx-accent-on-tint);
      font-size: var(--lx-fs-12);
      text-decoration: none;
    }
    .reviewlink:hover {
      text-decoration: underline;
    }
    .warnline {
      margin: var(--lx-sp-2) 0 0;
      color: var(--lx-warn-body-text);
      font-size: var(--lx-fs-11-5);
    }
    .note {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-2);
    }
    .notehead {
      display: flex;
      align-items: center;
      gap: var(--lx-sp-4);
      min-height: 22px;
    }
    .noteedit {
      margin-left: auto;
    }
    .noteform {
      display: flex;
      flex-direction: column;
      gap: var(--lx-sp-6);
    }
    .notekind {
      height: 28px;
      font-family: var(--lx-font-ui);
    }
    .notetext {
      height: auto;
      padding: var(--lx-sp-6) var(--lx-sp-8);
      font-family: var(--lx-font-ui);
      font-size: var(--lx-fs-12-5);
      line-height: var(--lx-lh-body);
      resize: vertical;
    }
    .noteactions {
      display: flex;
      justify-content: flex-end;
      gap: var(--lx-sp-6);
    }
    .failed {
      color: var(--lx-danger);
    }
    .notefrom {
      font-size: var(--lx-fs-9-5);
      color: var(--lx-text-faint);
    }
    /* FR-4.3: the two note kinds are different things and must not look alike. */
    .notefrom[data-kind='description'] {
      color: var(--lx-accent-on-tint);
    }
    .notefrom[data-kind='meaning'] {
      color: var(--lx-warn);
    }
    .targetrow {
      display: flex;
      align-items: flex-start;
      gap: var(--lx-sp-7);
    }
    .missing {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--lx-sp-4);
    }
    .finding {
      display: flex;
      align-items: flex-start;
      gap: var(--lx-sp-7);
      color: var(--r-fg);
    }
    .finding .body {
      flex: 1;
      color: var(--r-fg);
      font-size: var(--lx-fs-12-5);
    }
    .to-issues {
      flex: none;
      color: var(--lx-accent);
      font-size: var(--lx-fs-11-5);
      white-space: nowrap;
    }
    .actions {
      flex-direction: row;
      gap: var(--lx-sp-8);
      margin-top: auto;
      border-bottom: 0;
    }
    .actions button {
      flex: 1;
    }
    .dirty {
      color: var(--lx-warn);
    }
    .confirm {
      display: flex;
      gap: var(--lx-sp-8);
    }
    .sec[data-editing='true'] .head {
      color: var(--lx-accent-on-tint);
    }
  `,
})
export class LxUnitDetail {
  protected readonly store = inject(UnitDetailStore);
  protected readonly drafts = inject(DraftStore);
  protected readonly translate = inject(TranslateStore);
  protected readonly settings = inject(SettingsStore);
  readonly #grid = inject(GridStore);
  readonly #modal = inject(LxModalService);
  readonly #injector = inject(Injector);
  protected readonly project = inject(ProjectStore);

  /** A locale file is being created — one button, one flight. */
  protected readonly creating = signal(false);

  private readonly editor = viewChild(LxSegmentEditor);

  constructor() {
    // An armed delete belongs to the key it was armed on; moving off it is an
    // answer of "no", not a pause. Keyed on the row rather than on `detail()`
    // so a background refetch of the same key does not silently disarm it.
    effect(() => {
      const rowId = this.store.detail()?.rowId ?? null;
      if (this.#armedRow() === rowId) return;
      this.#armedRow.set(rowId);
      this.armedLocale.set(null);
      this.armedNote.set(null);
      this.noteForm.set(null);
    });

    // Idempotent, and shared with S1 and S7. The panel has to know whether a
    // model is configured before anyone opens Settings, or the translate button
    // would read "not configured" on a machine where it is.
    void this.settings.load();
  }

  /**
   * The locale whose delete button is armed, if any.
   *
   * Two clicks rather than a modal, as the glossary's term delete already does:
   * the write lands in the unsaved overlay, so the cost of a slip is an undo
   * away, and a dialog per locale on a ten-locale unit would be its own tax.
   */
  protected readonly armedLocale = signal<string | null>(null);

  /* ---- notes (FR-4.2) ----------------------------------------------------- */

  /** The note being written: its position (null = a new one), kind and text. */
  protected readonly noteForm = signal<{
    index: number | null;
    from: string | null;
    text: string;
  } | null>(null);
  /** The note whose delete is armed — two clicks, as for a translation. */
  protected readonly armedNote = signal<number | null>(null);
  /** The last draft-store error came from a note write, so it is shown here. */
  protected readonly noteError = signal(false);
  private readonly noteText = viewChild<ElementRef<HTMLTextAreaElement>>('noteText');

  protected startNote(index: number | null): void {
    const note = index === null ? undefined : this.store.detail()?.notes[index];
    this.armedNote.set(null);
    this.noteForm.set({
      index,
      from: note === undefined ? 'description' : note.from,
      text: note?.text ?? '',
    });
    afterNextRender(() => this.noteText()?.nativeElement.focus(), { injector: this.#injector });
  }

  protected setNoteFrom(value: string): void {
    this.noteForm.update((f) => (f === null ? f : { ...f, from: value === '' ? null : value }));
  }

  protected setNoteText(value: string): void {
    this.noteForm.update((f) => (f === null ? f : { ...f, text: value }));
  }

  protected cancelNote(): void {
    this.noteForm.set(null);
  }

  /** ⌘↩ keeps the note, Esc drops the form — the editor's own keys. */
  protected onNoteKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelNote();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void this.saveNote();
    }
  }

  protected async saveNote(): Promise<void> {
    const form = this.noteForm();
    const detail = this.store.detail();
    if (form === null || detail === undefined || form.text.trim() === '') return;
    const notes = detail.notes.map((n) => ({ from: n.from, text: n.text }));
    const edited = { from: form.from, text: form.text.trim() };
    if (form.index === null) notes.push(edited);
    else notes[form.index] = edited;
    if (await this.#writeNotes(detail.rowId, notes)) this.noteForm.set(null);
  }

  protected async deleteNote(index: number): Promise<void> {
    if (this.armedNote() !== index) {
      this.armedNote.set(index);
      return;
    }
    this.armedNote.set(null);
    const detail = this.store.detail();
    if (detail === undefined) return;
    await this.#writeNotes(
      detail.rowId,
      detail.notes.filter((_, i) => i !== index).map((n) => ({ from: n.from, text: n.text })),
    );
  }

  async #writeNotes(
    rowId: string,
    notes: { from: string | null; text: string }[],
  ): Promise<boolean> {
    const updated = await this.drafts.putNotes(rowId, notes);
    this.noteError.set(updated === null);
    // The answer IS the new detail: shown at once, without a second request.
    if (updated !== null && this.store.detail()?.rowId === rowId) this.store.resource.set(updated);
    return updated !== null;
  }

  /** The row `armedLocale` was armed on; see the effect in the constructor. */
  readonly #armedRow = signal<string | null>(null);

  /** The edit session the panel shares with the grid's inline editor. */
  protected readonly session = inject(EditSessionStore);
  protected readonly editLocale = this.session.editLocale;
  protected readonly targets = this.session.targets;
  protected readonly availableIds = this.session.availableIds;

  protected hasError(findings: readonly { severity: string }[]): boolean {
    return findings.some((f) => f.severity === 'error');
  }

  protected dirtyFor(locale: string): boolean {
    const rowId = this.store.detail()?.rowId;
    return rowId !== undefined && this.drafts.draftFor(rowId, locale) !== undefined;
  }

  protected onEdit(segments: readonly SegmentDto[]): void {
    this.session.onEdit(segments);
  }

  /** `Cmd+Enter`: commit, then move to the next filtered row (FR-3.6). */
  async commitAndAdvance(): Promise<void> {
    await this.session.commitAndAdvance();
  }

  async commit(): Promise<void> {
    await this.session.commit();
  }

  /** `Esc`: throw away the pending edit and show what is in the file again. */
  async revert(): Promise<void> {
    await this.session.revert();
  }

  /**
   * Clear one locale's translation, armed-then-confirmed.
   *
   * There is no delete endpoint and none is needed: an edit that empties the
   * text is the delete. `stateForEdit` on the server maps empty segments back
   * to `untranslated`, so this lands in the unsaved overlay exactly like a
   * typed edit and is written by the same Save.
   */
  protected async clearTarget(locale: string): Promise<void> {
    if (this.armedLocale() !== locale) {
      this.armedLocale.set(locale);
      return;
    }
    this.armedLocale.set(null);

    const rowId = this.store.detail()?.rowId;
    if (rowId === undefined) return;
    if (locale === this.editLocale()) this.session.clearBuffer();
    await this.drafts.commit(rowId, locale, []);
  }

  /** FR-3.12, from the toolbar and the panel alike. */
  async copySource(): Promise<void> {
    const rowId = this.store.detail()?.rowId;
    const locale = this.editLocale();
    if (rowId === undefined || locale === null) return;
    this.session.clearBuffer();
    await this.drafts.copySource(rowId, locale);
  }

  /** FR-3.8: the dashed chips finally do something. */
  protected insert(locale: string, id: string): void {
    if (locale !== this.editLocale()) {
      this.#grid.setEditLocale(locale);
      return;
    }
    const source = this.store.detail()?.source ?? [];
    const found = source.find((s) => s.k === 'p' && s.id === id);
    this.editor()?.insertPlaceholder(id, found?.k === 'p' ? found.equivText : undefined);
  }

  focusEditor(): void {
    this.editor()?.focus();
  }

  /* ---- the local model (M9) ---------------------------------------------- */

  /** The last run for the cell being edited, if there has been one. */
  protected readonly run = computed(() => {
    const rowId = this.store.detail()?.rowId;
    const locale = this.editLocale();
    if (rowId === undefined || locale === null) return undefined;
    return this.translate.runFor(rowId, locale);
  });

  protected readonly busy = computed(() => {
    const rowId = this.store.detail()?.rowId;
    const locale = this.editLocale();
    return rowId !== undefined && locale !== null && this.translate.runningFor(rowId, locale);
  });

  protected readonly canTranslate = computed(
    () => this.editLocale() !== null && this.settings.configured() && !this.translate.isRunning(),
  );

  /**
   * Why the button is disabled, in the place a user looks when it is.
   *
   * An endpoint that is not configured is by far the likeliest reason, and the
   * fix is one screen away — saying so here is cheaper than a support question.
   */
  protected readonly translateHint = computed(() => {
    if (this.editLocale() === null) return 'Select a target locale that this unit exists in.';
    if (!this.settings.configured()) return 'No local model is configured yet — see Settings.';
    return 'Draft this string with the configured local model.';
  });

  /** Which file this locale's copy lives in, for the "saving adds this" line. */
  protected fileFor(locale: string): string {
    const detail = this.store.detail();
    if (detail === undefined) return '';
    // The detail carries the files it knows about; a unit missing from a locale
    // has no entry, so the group's other file for that locale is the answer.
    return (
      detail.files[locale] ??
      this.project.files().find((f) => f.group === detail.group && f.locale === locale)?.relPath ??
      `the ${locale} file`
    );
  }

  protected async createLocaleFile(locale: string): Promise<void> {
    const detail = this.store.detail();
    if (detail === undefined || this.creating()) return;
    this.creating.set(true);
    try {
      const created = await this.project.createLocaleFile(detail.group, locale);
      // The panel reads the unit again: the target that had nowhere to go now
      // has a file, and the editor should appear without a click.
      if (created !== null) this.store.reload();
    } finally {
      this.creating.set(false);
    }
  }

  protected async translateUnit(): Promise<void> {
    const rowId = this.store.detail()?.rowId;
    const locale = this.editLocale();
    if (rowId === undefined || locale === null) return;
    // Any buffered keystrokes belong to the user, not to the model's answer.
    this.session.clearBuffer();
    await this.translate.translate(rowId, locale);
  }

  protected async confirmOverwrite(): Promise<void> {
    await this.translate.confirmOverwrite();
  }

  /** S5 (FR-5.7), over the live grid. */
  protected previewPrompt(): void {
    const rowId = this.store.detail()?.rowId;
    const locale = this.editLocale();
    if (rowId === undefined || locale === null) return;
    this.#modal.open<LxPromptPreview, boolean>(LxPromptPreview, {
      data: { rowId, locale } satisfies PromptPreviewData,
    });
  }
}
