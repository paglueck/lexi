// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UnitCreateResponse } from '@lexi/shared';

import { LxCreateUnitModal, type CreateUnitModalData } from './create-unit-modal.js';

/**
 * "New key…" writes to disk the moment Create is pressed, so what is pinned
 * here is the request it sends and that a refusal keeps the modal open with
 * the server's own sentence, rather than closing as if it had worked.
 */

let closed: unknown;
let closeCalls: number;
let http: HttpTestingController;

const DATA: CreateUnitModalData = { group: 'messages', sourceFile: 'messages.xlf' };

beforeEach(() => {
  closed = undefined;
  closeCalls = 0;
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: DIALOG_DATA, useValue: DATA },
      {
        provide: DialogRef,
        useValue: {
          close: (value: unknown) => {
            closeCalls += 1;
            closed = value;
          },
        } as Partial<DialogRef>,
      },
    ],
  });
  http = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  http.verify();
});

const mount = () => {
  const fixture = TestBed.createComponent(LxCreateUnitModal);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const fields = [
    ...el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
  ];
  const type = (index: number, value: string) => {
    const field = fields[index]!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const createButton = () =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Create'),
    )!;
  return { fixture, el, type, createButton };
};

describe('LxCreateUnitModal', () => {
  it('shows the source file it writes to', () => {
    expect(mount().el.textContent).toContain('messages.xlf');
  });

  it('needs an id without spaces and a source text before Create is enabled', () => {
    const { el, type, createButton } = mount();
    expect(createButton().disabled).toBe(true);

    type(0, 'has space');
    type(1, 'Hello');
    expect(createButton().disabled).toBe(true);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('spaces');

    type(0, 'checkout.hello');
    expect(createButton().disabled).toBe(false);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('sends the trimmed id, the group and only the notes that were filled in, then closes with the answer', async () => {
    const { fixture, type, createButton } = mount();
    type(0, '  checkout.hello ');
    type(1, 'Hello');
    type(2, 'Greeting on the checkout page');
    createButton().click();

    const req = http.expectOne('/api/units');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      unitId: 'checkout.hello',
      group: 'messages',
      source: 'Hello',
      description: 'Greeting on the checkout page',
    });
    const res: UnitCreateResponse = {
      rowId: 'messages\u001fcheckout.hello',
      written: 'messages.xlf',
      unsavedCount: 0,
    };
    req.flush(res);
    await fixture.whenStable();

    expect(closed).toEqual(res);
  });

  it('stays open on a refusal and shows the server’s message', async () => {
    const { fixture, el, type, createButton } = mount();
    type(0, 'pay');
    type(1, 'Pay');
    createButton().click();

    http
      .expectOne('/api/units')
      .flush(
        { error: { code: 'conflict', message: '"pay" already exists in messages.xlf' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(closeCalls).toBe(0);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      '"pay" already exists in messages.xlf',
    );
    expect(createButton().disabled).toBe(false);
  });
});
