// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Drag a header border to resize its column: the grid's, and S12's findings.
 *
 * Pointer capture keeps the moves coming when the pointer leaves the thin grab
 * zone, which it does at once. Each move reports one width; the caller clamps
 * and stores it. A header in an RTL document grows to the left, not the right.
 */
export function dragColumn(
  event: PointerEvent,
  startWidth: number,
  onWidth: (px: number) => void,
  onEnd: () => void,
): void {
  const handle = event.currentTarget as HTMLElement;
  const startX = event.clientX;
  const sign = getComputedStyle(handle).direction === 'rtl' ? -1 : 1;
  handle.setPointerCapture(event.pointerId);
  const body = handle.ownerDocument.body;
  const previousCursor = body.style.cursor;
  body.style.cursor = 'col-resize';

  const move = (e: PointerEvent): void => onWidth(startWidth + sign * (e.clientX - startX));
  const end = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    body.style.cursor = previousCursor;
    onEnd();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
