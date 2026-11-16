// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Injectable, computed, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import type { UnitDetail } from '@lexi/shared';

import { messageOf } from '../api/server-message.js';
import { UnitsStore } from './units-store.js';

/**
 * The detail panel's body, as a function of the selection.
 *
 * `httpResource` again, for the same reason as the query: arrowing down a list
 * fires a request per row, and only the last one's answer should ever be shown.
 * An awaited call would race — hold the down arrow and the panel would end up
 * displaying whichever request happened to finish last.
 */
@Injectable({ providedIn: 'root' })
export class UnitDetailStore {
  readonly #units = inject(UnitsStore);

  readonly resource = httpResource<UnitDetail>(() => {
    const rowId = this.#units.selectedRowId();
    return rowId === null ? undefined : `/api/units/${encodeURIComponent(rowId)}`;
  });

  readonly detail = computed<UnitDetail | undefined>(() => this.resource.value());
  readonly isLoading = computed(() => this.resource.isLoading());
  /**
   * Why the panel is empty when a row IS selected. Before M13 a failed read
   * fell through to "Select a row to see its context", which sent people
   * looking for a click that had already happened.
   */
  readonly error = computed<string | null>(() => {
    const error: unknown = this.resource.error();
    return error ? messageOf(error, 'This unit could not be loaded.') : null;
  });

  /**
   * Re-read the selected unit.
   *
   * The resource is keyed on the SELECTION, so it does not notice when the
   * project changes underneath it — which is exactly what starting a locale
   * does (FR-1.9): the same unit now has somewhere to put a translation.
   */
  reload(): void {
    this.resource.reload();
  }
}
