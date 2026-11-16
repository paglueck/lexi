// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { SegmentDto } from '@lexi/shared';

/**
 * The DOM half of the segment editor, as pure functions.
 *
 * Kept out of the component because these are the only parts of the editor
 * jsdom can honestly test: a `childNodes` walk is a `childNodes` walk anywhere,
 * while selection, `beforeinput` and composition are not, and a unit test of
 * those would pass for the wrong reason.
 */

/**
 * Zero-width space. Every chip is `contenteditable="false"`, so without a text
 * node beside it the caret has nowhere to land: at the start of the field, at
 * the end, and between two adjacent chips. The serializer strips these, so they
 * never reach a file and never count as characters.
 */
export const FILLER = '​';

const stripFiller = (text: string): string => text.split(FILLER).join('');

/** True for a node the caret must never be able to enter or split. */
export const isChip = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute('data-ph');

const isGroup = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).hasAttribute('data-g');

/** The chip element for one placeholder, matching the grid's raw `.lx-chip` markup exactly. */
export function createChip(doc: Document, segment: Extract<SegmentDto, { k: 'p' }>): HTMLElement {
  const el = doc.createElement('span');
  el.className = 'lx-chip';
  el.setAttribute('data-size', 'panel');
  el.setAttribute('data-ph', segment.id);
  if (segment.equivText !== undefined) el.setAttribute('data-equiv', segment.equivText);
  if (segment.ctype !== undefined) el.setAttribute('data-ctype', segment.ctype);
  // The caret must not be able to get inside, and the label must not be editable.
  // Set as an ATTRIBUTE rather than through the IDL property: the attribute is
  // what serialises, what a paste carries, and what jsdom can see.
  el.setAttribute('contenteditable', 'false');
  el.textContent = segment.equivText ?? segment.id;
  el.title = segment.equivText ?? segment.id;
  return el;
}

function appendSegments(doc: Document, parent: Node, segments: readonly SegmentDto[]): void {
  for (const segment of segments) {
    if (segment.k === 't') {
      parent.appendChild(doc.createTextNode(segment.v));
    } else if (segment.k === 'p') {
      parent.appendChild(createChip(doc, segment));
    } else {
      const el = doc.createElement('span');
      el.className = 'lx-group';
      el.setAttribute('data-g', segment.id);
      appendSegments(doc, el, segment.children);
      parent.appendChild(el);
    }
  }
}

/**
 * Give every chip a text node on both sides, so the caret always has somewhere
 * to land. Applied to groups too, since a group is an element boundary for the
 * same reason a chip is.
 */
function addFillers(doc: Document, parent: Node): void {
  for (const child of Array.from(parent.childNodes)) {
    if (isGroup(child)) addFillers(doc, child);
  }
  const needsFiller = (node: Node | null): boolean =>
    node === null || node.nodeType === Node.ELEMENT_NODE;

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (needsFiller(child.previousSibling)) {
      parent.insertBefore(doc.createTextNode(FILLER), child);
    }
    if (needsFiller(child.nextSibling)) {
      parent.insertBefore(doc.createTextNode(FILLER), child.nextSibling);
    }
  }
  if (parent.childNodes.length === 0) parent.appendChild(doc.createTextNode(''));
}

/** Replace the host's children with the DOM for these segments. */
export function renderSegments(host: HTMLElement, segments: readonly SegmentDto[]): void {
  const doc = host.ownerDocument;
  host.textContent = '';
  appendSegments(doc, host, segments);
  addFillers(doc, host);
}

function walk(parent: Node): SegmentDto[] {
  const out: SegmentDto[] = [];
  const pushText = (text: string): void => {
    if (text === '') return;
    const last = out[out.length - 1];
    // Coalesce, because a browser splits text nodes freely as the caret moves.
    if (last !== undefined && last.k === 't') out[out.length - 1] = { k: 't', v: last.v + text };
    else out.push({ k: 't', v: text });
  };

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      pushText(stripFiller(child.nodeValue ?? ''));
      continue;
    }
    if (isChip(child)) {
      const equivText = child.getAttribute('data-equiv');
      const ctype = child.getAttribute('data-ctype');
      out.push({
        k: 'p',
        id: child.getAttribute('data-ph') ?? '',
        ...(equivText === null ? {} : { equivText }),
        ...(ctype === null ? {} : { ctype }),
      });
      continue;
    }
    if (isGroup(child)) {
      out.push({ k: 'g', id: child.getAttribute('data-g') ?? '', children: walk(child) });
      continue;
    }
    if (child.nodeName === 'BR') {
      // A browser's trailing filler <br>. Never content: a real line break is a
      // LINE_BREAK placeholder chip.
      continue;
    }
    // Anything else got in through a paste the interception missed. Keep its
    // text, drop the markup — inventing a placeholder is the one thing the
    // client must never do.
    for (const segment of walk(child)) {
      if (segment.k === 't') pushText(segment.v);
      else out.push(segment);
    }
  }
  return out;
}

/** Walk the host's children back into wire segments. The inverse of `renderSegments`. */
export const serializeSegments = (host: HTMLElement): SegmentDto[] => walk(host);

/** Readable text, placeholders rendered as their label. Mirrors the engine's `plainText`. */
export function segmentsPlainText(segments: readonly SegmentDto[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.k === 't') out += segment.v;
    else if (segment.k === 'p') out += segment.equivText ?? segment.id;
    else out += segmentsPlainText(segment.children);
  }
  return out;
}

/** Placeholder ids in document order, descending into groups. Mirrors the engine's `placeholderIds`. */
export function segmentsPlaceholderIds(
  segments: readonly SegmentDto[],
  into: string[] = [],
): string[] {
  for (const segment of segments) {
    if (segment.k === 'p') into.push(segment.id);
    else if (segment.k === 'g') segmentsPlaceholderIds(segment.children, into);
  }
  return into;
}
