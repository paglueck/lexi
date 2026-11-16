// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ElementRef } from '@angular/core';
import { Component, booleanAttribute, effect, input, output, viewChild } from '@angular/core';

import type { SegmentDto } from '@lexi/shared';
import type { EditorMode } from '@lexi/shared/constants';

import {
  FILLER,
  createChip,
  isChip,
  renderSegments,
  segmentsPlainText,
  serializeSegments,
} from './segment-dom.js';

/** Kept as its own alias: this component's concern is rendering, not the stored preference. */
export type SegmentEditorMode = EditorMode;

/**
 * The target editor: text with atomic, non-editable placeholder chips (FR-PH-1).
 *
 * THE RULE THAT DECIDES THE SHAPE OF THIS COMPONENT IS IME. Any Angular
 * re-render between `compositionstart` and `compositionend` destroys the
 * composition, so the DOM is written exactly ONCE per external value change and
 * is otherwise uncontrolled: the template's surface is empty and every child
 * node is built by hand. Never `[innerHTML]`, never `document.execCommand`.
 *
 * `mode` is an input rather than a second component on purpose. It is the
 * fallback: if contenteditable chips cannot be made safe in some browser,
 * `'text'` becomes the default and nothing else in the app changes.
 *
 * Three safety nets stand behind it, so this only has to be pleasant rather than
 * perfect: exactly one instance exists, the server
 * refuses a target whose placeholders do not match the source, and the text mode
 * is always reachable.
 */
@Component({
  selector: 'lx-segment-editor',
  template: `
    @if (mode() === 'text') {
      <textarea
        #textarea
        class="surface surface--text"
        [attr.dir]="dir()"
        [attr.disabled]="disabled() ? '' : null"
        [value]="plainText()"
        (input)="onTextInput($event)"
        (keydown)="onKeydown($event)"
      ></textarea>
    } @else {
      <div
        #surface
        class="surface"
        role="textbox"
        aria-multiline="true"
        [attr.contenteditable]="disabled() ? null : 'true'"
        [attr.tabindex]="disabled() ? null : 0"
        [attr.dir]="dir()"
        (beforeinput)="onBeforeInput($event)"
        (keydown)="onKeydown($event)"
        (input)="onInput()"
        (paste)="onPaste($event)"
        (copy)="onCopy($event, false)"
        (cut)="onCopy($event, true)"
        (compositionstart)="composing = true"
        (compositionend)="onCompositionEnd()"
      ></div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .surface {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 10px;
      border: 1px solid var(--lx-border-strong);
      border-radius: var(--lx-r-7);
      background: var(--lx-bg-field);
      color: var(--lx-text-primary);
      font-size: var(--lx-fs-13);
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      caret-color: var(--lx-accent);
    }
    .surface:focus {
      outline: none;
      border-color: var(--lx-accent);
    }
    .surface--text {
      min-height: 66px;
      resize: vertical;
      font-family: var(--lx-font-mono);
      font-size: var(--lx-fs-12-5);
    }
    :host([aria-disabled='true']) .surface {
      opacity: 0.55;
    }
    /* A <g> group: a boundary the caret may enter, unlike a chip. */
    .surface :where(.lx-group) {
      border-bottom: 1px dotted var(--lx-border-strong);
    }
  `,
})
export class LxSegmentEditor {
  readonly value = input.required<readonly SegmentDto[]>();
  readonly dir = input<'ltr' | 'rtl'>('ltr');
  readonly mode = input<SegmentEditorMode>('chips');
  readonly disabled = input(false, { transform: booleanAttribute });
  /**
   * Placeholder ids the source offers. Shift+Enter may only insert a LINE_BREAK
   * that actually exists in the source — inventing one is rejected on save, so
   * offering it here would be a trap.
   */
  readonly available = input<readonly string[]>([]);

  readonly valueChange = output<readonly SegmentDto[]>();
  /** `Cmd/Ctrl+Enter` and plain Enter: commit and advance (FR-3.6). */
  readonly commit = output<void>();
  /** `Esc`: revert to the last saved value (FR-3.6). */
  readonly revert = output<void>();

  protected composing = false;

  private readonly surface = viewChild<ElementRef<HTMLElement>>('surface');
  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('textarea');

  /**
   * The value this component last emitted. Reference equality against it is what
   * stops the echo of our own `valueChange` from rewriting the DOM under the
   * caret — the parent stores exactly the array we handed it.
   */
  #lastEmitted: readonly SegmentDto[] | null = null;

  constructor() {
    effect(() => {
      const segments = this.value();
      // `viewChild` returns an ElementRef, not the element — reading `.style`
      // off it fails silently, which once froze the grid header unnoticed.
      const host = this.surface()?.nativeElement;
      if (host === undefined) return;
      if (segments === this.#lastEmitted) return;
      if (this.composing) return;
      renderSegments(host, segments);
    });
  }

  protected plainText(): string {
    return segmentsPlainText(this.value());
  }

  /** Insert a placeholder chip at the caret (FR-3.8, the "Insert missing" slot). */
  insertPlaceholder(id: string, equivText?: string): void {
    const host = this.surface()?.nativeElement;
    if (host === undefined || this.disabled()) return;

    const chip = createChip(host.ownerDocument, {
      k: 'p',
      id,
      ...(equivText === undefined ? {} : { equivText }),
    });
    const range = this.#caret(host);
    if (range === null) host.appendChild(chip);
    else {
      range.deleteContents();
      range.insertNode(chip);
    }
    // Keep the caret landable on both sides of the new chip.
    const doc = host.ownerDocument;
    chip.parentNode?.insertBefore(doc.createTextNode(FILLER), chip);
    const after = doc.createTextNode(FILLER);
    chip.parentNode?.insertBefore(after, chip.nextSibling);
    this.#placeCaret(after, 1);
    this.#emit();
  }

  focus(): void {
    (this.surface()?.nativeElement ?? this.textarea()?.nativeElement)?.focus();
  }

  /* ---- input ------------------------------------------------------------- */

  protected onInput(): void {
    if (this.composing) return;
    this.#emit();
  }

  protected onCompositionEnd(): void {
    this.composing = false;
    this.#emit();
  }

  protected onTextInput(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    this.#lastEmitted = text === '' ? [] : [{ k: 't', v: text }];
    this.valueChange.emit(this.#lastEmitted);
  }

  #emit(): void {
    const host = this.surface()?.nativeElement;
    if (host === undefined) return;
    this.#lastEmitted = serializeSegments(host);
    this.valueChange.emit(this.#lastEmitted);
  }

  /* ---- the interceptions ------------------------------------------------- */

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.revert.emit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) this.#insertLineBreak();
      else this.commit.emit();
      return;
    }
    if (this.mode() === 'text') return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    const host = this.surface()?.nativeElement;
    if (host === undefined) return;
    const forward = event.key === (this.dir() === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
    const chip = this.#chipBeside(host, forward);
    if (chip === null) return;

    // A chip is one thing. The caret steps over it; a selection swallows it whole.
    event.preventDefault();
    const selection = host.ownerDocument.getSelection();
    if (selection === null) return;
    if (event.shiftKey) selection.extend(chip.parentNode!, this.#indexOf(chip) + (forward ? 1 : 0));
    else this.#placeCaretAt(chip, forward);
  }

  protected onBeforeInput(event: InputEvent): void {
    const host = this.surface()?.nativeElement;
    if (host === undefined) return;

    const backward = event.inputType === 'deleteContentBackward';
    const forward = event.inputType === 'deleteContentForward';
    if (!backward && !forward) return;

    const selection = host.ownerDocument.getSelection();
    if (selection === null || !selection.isCollapsed) return;

    const chip = this.#chipBeside(host, forward);
    if (chip === null) return;

    // Deleting beside a chip removes the whole chip, never a fragment of it.
    event.preventDefault();
    const anchor = backward ? chip.previousSibling : chip.nextSibling;
    chip.remove();
    if (anchor !== null && anchor.nodeType === Node.TEXT_NODE) {
      this.#placeCaret(anchor, backward ? (anchor.nodeValue ?? '').length : 0);
    }
    this.#emit();
  }

  protected onPaste(event: ClipboardEvent): void {
    // Always. Browser-native paste drops arbitrary markup into the field, and
    // markup that imitates a placeholder is exactly what must never be invented.
    event.preventDefault();
    const host = this.surface()?.nativeElement;
    if (host === undefined) return;

    const internal = event.clipboardData?.getData('application/x-lexi-segments');
    const doc = host.ownerDocument;
    const range = this.#caret(host);
    if (range === null) return;
    range.deleteContents();

    if (internal !== undefined && internal !== '') {
      const fragment = doc.createDocumentFragment();
      const holder = doc.createElement('div');
      renderSegments(holder, JSON.parse(internal) as SegmentDto[]);
      while (holder.firstChild !== null) fragment.appendChild(holder.firstChild);
      range.insertNode(fragment);
    } else {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text !== '') range.insertNode(doc.createTextNode(text));
    }
    host.ownerDocument.getSelection()?.collapseToEnd();
    this.#emit();
  }

  protected onCopy(event: ClipboardEvent, cut: boolean): void {
    const host = this.surface()?.nativeElement;
    if (host === undefined || event.clipboardData === null) return;
    const range = this.#caret(host);
    if (range === null || range.collapsed) return;

    const holder = host.ownerDocument.createElement('div');
    holder.appendChild(range.cloneContents());
    const segments = serializeSegments(holder);

    event.preventDefault();
    // A custom type so copying inside the app round-trips chips rather than
    // degrading them to their labels.
    event.clipboardData.setData('application/x-lexi-segments', JSON.stringify(segments));
    event.clipboardData.setData('text/plain', segmentsPlainText(segments));
    if (cut) {
      range.deleteContents();
      this.#emit();
    }
  }

  #insertLineBreak(): void {
    if (this.available().includes('LINE_BREAK')) this.insertPlaceholder('LINE_BREAK', '<br/>');
  }

  /* ---- caret helpers ----------------------------------------------------- */

  #caret(host: HTMLElement): Range | null {
    const selection = host.ownerDocument.getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return host.contains(range.commonAncestorContainer) ? range : null;
  }

  /**
   * The chip immediately beside a collapsed caret, filler text nodes skipped.
   * `null` when there is real text in the way — then the browser's own caret
   * movement is already correct and must not be second-guessed.
   */
  #chipBeside(host: HTMLElement, forward: boolean): HTMLElement | null {
    const range = this.#caret(host);
    if (range === null || !range.collapsed) return null;

    let node: Node | null = range.startContainer;
    const offset = range.startOffset;

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? '';
      const rest = forward ? text.slice(offset) : text.slice(0, offset);
      if (rest.split(FILLER).join('') !== '') return null;
    } else {
      node = node.childNodes[forward ? offset : offset - 1] ?? null;
      if (node !== null && isChip(node)) return node;
    }

    let sibling = node === null ? null : forward ? node.nextSibling : node.previousSibling;
    while (sibling !== null && sibling.nodeType === Node.TEXT_NODE) {
      if ((sibling.nodeValue ?? '').split(FILLER).join('') !== '') return null;
      sibling = forward ? sibling.nextSibling : sibling.previousSibling;
    }
    return sibling !== null && isChip(sibling) ? sibling : null;
  }

  #indexOf(node: Node): number {
    return Array.prototype.indexOf.call(node.parentNode?.childNodes ?? [], node);
  }

  #placeCaretAt(chip: HTMLElement, after: boolean): void {
    const doc = chip.ownerDocument;
    const range = doc.createRange();
    if (after) range.setStartAfter(chip);
    else range.setStartBefore(chip);
    range.collapse(true);
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  #placeCaret(node: Node, offset: number): void {
    const doc = node.ownerDocument ?? document;
    const range = doc.createRange();
    range.setStart(node, Math.min(offset, (node.nodeValue ?? '').length));
    range.collapse(true);
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}
