// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateMode, UpdateState, UpdateStatus } from '@lexi/shared';

import { ToastStore } from '../../core/stores/toast-store.js';
import { UpdateStore } from '../../core/stores/update-store.js';
import {
  LxUpdateDialog,
  MIN_CHECK_MS,
  UP_TO_DATE_MS,
  type UpdateDialogData,
} from './update-dialog.js';

/**
 * The start-up dialog holds the app until it is answered, so what is asserted
 * is when it lets go: by itself when there is nothing to offer or no answer,
 * and otherwise only through the buttons the phase allows.
 */

let closed: number;
let http: HttpTestingController;

const status = (state: UpdateState, mode: UpdateMode = 'auto'): UpdateStatus => ({
  supported: true,
  currentVersion: '1.0.0',
  mode,
  state,
});

const AVAILABLE: UpdateState = { phase: 'available', version: '1.1.0', releaseNotes: '- Faster' };

const setup = (start: UpdateDialogData['start'], initial: UpdateStatus) => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: DIALOG_DATA, useValue: { start } satisfies UpdateDialogData },
      { provide: DialogRef, useValue: { close: () => (closed += 1) } as Partial<DialogRef> },
    ],
  });
  http = TestBed.inject(HttpTestingController);
  // The store as App leaves it: loaded, before the dialog opens.
  const store = TestBed.inject(UpdateStore);
  void store.load();
  http.expectOne('/api/update').flush(initial);
};

const mount = async () => {
  const fixture = TestBed.createComponent(LxUpdateDialog);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
};

const settle = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fixture.whenStable();
  fixture.detectChanges();
};

const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const buttons = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('button')].map((b) => text(b));

beforeEach(() => {
  closed = 0;
});

afterEach(() => {
  http.verify();
  vi.useRealTimers();
});

describe('LxUpdateDialog at start-up', () => {
  it('shows the check with no way out, then says Lexi is current before it closes', async () => {
    vi.useFakeTimers();
    setup('startup', status({ phase: 'idle' }));
    const fixture = await mount();
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();

    expect(text(el)).toContain('Checking for updates…');
    expect(buttons(el)).toEqual([]);

    // A quick answer stays behind the check until it has been on screen a while.
    http.expectOne('/api/update/check').flush(status({ phase: 'none' }));
    await vi.advanceTimersByTimeAsync(MIN_CHECK_MS - 100);
    fixture.detectChanges();
    expect(text(el)).toContain('Checking for updates…');

    await vi.advanceTimersByTimeAsync(100);
    fixture.detectChanges();
    expect(text(el)).toContain('You are using the latest version, Lexi 1.0.0.');
    expect(closed).toBe(0);

    await vi.advanceTimersByTimeAsync(UP_TO_DATE_MS);
    expect(closed).toBe(1);
  });

  it('closes on a failed check, and says so in a toast', async () => {
    vi.useFakeTimers();
    setup('startup', status({ phase: 'idle' }));
    await mount();
    http
      .expectOne('/api/update/check')
      .flush(status({ phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }));
    await vi.advanceTimersByTimeAsync(MIN_CHECK_MS);

    expect(closed).toBe(1);
    const toasts = TestBed.inject(ToastStore).toasts();
    expect(toasts.map((t) => t.title)).toEqual(['Could not check for updates']);
  });

  it('offers the update with its notes, and skipping just closes', async () => {
    setup('startup', status({ phase: 'idle' }));
    const fixture = await mount();
    http.expectOne('/api/update/check').flush(status(AVAILABLE));
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;

    expect(text(el)).toContain('Lexi 1.1.0 is available. You are using 1.0.0.');
    expect(text(el.querySelector('.notes'))).toBe('- Faster');
    expect(buttons(el)).toEqual(['Skip for now', 'Update now', '']);

    [...el.querySelectorAll('button')].find((b) => text(b) === 'Skip for now')!.click();
    expect(closed).toBe(1);
  });

  it('downloads behind a progress bar with no way out, then installs by itself on Windows', async () => {
    setup('startup', status({ phase: 'idle' }));
    const fixture = await mount();
    http.expectOne('/api/update/check').flush(status(AVAILABLE));
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;

    [...el.querySelectorAll('button')].find((b) => text(b) === 'Update now')!.click();
    http
      .expectOne('/api/update/download')
      .flush(status({ phase: 'downloading', version: '1.1.0', percent: 0 }));
    await settle(fixture);

    const store = TestBed.inject(UpdateStore);
    store.apply({ phase: 'downloading', version: '1.1.0', percent: 42.4 });
    fixture.detectChanges();
    expect(text(el)).toContain('42 %');
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(buttons(el)).toEqual([]);

    store.apply({ phase: 'ready', version: '1.1.0', releaseNotes: null });
    fixture.detectChanges();
    await settle(fixture);
    expect(http.expectOne('/api/update/install').request.method).toBe('POST');
    expect(closed).toBe(0);
  });
});

describe('LxUpdateDialog from Settings', () => {
  it('starts the download straight away', async () => {
    setup('download', status(AVAILABLE));
    await mount();
    expect(http.expectOne('/api/update/download').request.method).toBe('POST');
  });

  it('on the Mac, waits for a click before it opens the disk image and quits', async () => {
    setup('download', status(AVAILABLE, 'dmg'));
    const fixture = await mount();
    http
      .expectOne('/api/update/download')
      .flush(status({ phase: 'downloading', version: '1.1.0', percent: 0 }, 'dmg'));
    TestBed.inject(UpdateStore).apply({ phase: 'ready', version: '1.1.0', releaseNotes: null });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;

    expect(text(el)).toContain('Drag Lexi into the Applications folder');
    http.expectNone('/api/update/install');

    [...el.querySelectorAll('button')].find((b) => text(b) === 'Open and quit')!.click();
    expect(http.expectOne('/api/update/install').request.method).toBe('POST');
  });
});
