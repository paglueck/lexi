// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { PhraseToken } from '@lexi/shared';

import { PhraseTokensApi } from '../../core/api/phrase-tokens-api.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { LxModalService } from '../../ui/index.js';
import { LxPhraseTokens, hostOf } from './phrase-tokens.js';

/** S19: the list, the Verify-before-Save gating of the add form, and remove's question. */

const TOKEN: PhraseToken = {
  id: 'nw',
  note: 'Northwind product team',
  region: 'EU',
  suffix: '9f3a',
  user: 'anna@northwind.io',
  org: 'Northwind GmbH',
  scopes: '',
  projects: [{ id: 'web', name: 'northwind-web', account: null }],
  status: 'ok',
  checkedAt: new Date().toISOString(),
};

async function mount(tokens: PhraseToken[] = [TOKEN], confirm = true) {
  const api = {
    list: vi.fn().mockResolvedValue({ tokens }),
    verify: vi.fn().mockResolvedValue({
      ok: true,
      detail: '',
      user: 'anna@berg.de',
      org: 'Fabrikam',
      scopes: '',
      projects: [{ id: 'fb', name: 'fabrikam-app', account: null }],
    }),
    create: vi.fn().mockResolvedValue({ ...TOKEN, id: 'fb', note: 'Fabrikam' }),
    update: vi.fn(),
    check: vi.fn(),
    replaceSecret: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const modal = { open: vi.fn(() => ({ closed: of(confirm) })) };
  TestBed.configureTestingModule({
    providers: [
      { provide: PhraseTokensApi, useValue: api },
      { provide: SettingsStore, useValue: { reload: vi.fn().mockResolvedValue(undefined) } },
      { provide: LxModalService, useValue: modal },
    ],
  });
  const fixture = TestBed.createComponent(LxPhraseTokens);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, el, api, modal, settle };
}

const button = (el: HTMLElement, text: string): HTMLButtonElement =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('LxPhraseTokens (S19)', () => {
  it('lists tokens with their suffix and shows the selected one', async () => {
    const { el } = await mount();
    expect(el.querySelector('.token__note')?.textContent).toContain('Northwind product team');
    expect(el.querySelector('.suffix')?.textContent).toContain('…9f3a');
    expect(el.textContent).toContain('•••• •••• •••• 9f3a');
    expect(el.textContent).toContain('stored in ~/.lexi on this machine');
    expect(el.textContent).not.toContain('Keychain');
    expect(el.querySelector('.status--ok')?.textContent).toContain('Valid · checked');
    // Scopes are not reported by Phrase: a dash, not an empty cell.
    expect(el.textContent).toContain('—');
  });

  it('calls an empty note "Untitled token"', async () => {
    const { el } = await mount([{ ...TOKEN, note: '' }]);
    expect(el.querySelector('.token__note')?.textContent?.trim()).toBe('Untitled token');
  });

  it('gates Verify on the token length and Save on a verification plus a note', async () => {
    const { el, api, settle } = await mount();
    button(el, 'Add token…').click();
    await settle();

    const [note, secret] = [...el.querySelectorAll<HTMLInputElement>('.card--add input')];
    expect(button(el, 'Verify').disabled).toBe(true);
    expect(button(el, 'Save token').disabled).toBe(true);
    expect(el.querySelector('.actions__hint')?.textContent).toContain('Verify the token first.');

    type(secret!, '  1234567  ');
    await settle();
    expect(button(el, 'Verify').disabled).toBe(true);
    type(secret!, '12345678');
    await settle();
    expect(button(el, 'Verify').disabled).toBe(false);

    button(el, 'Verify').click();
    await settle();
    expect(api.verify).toHaveBeenCalledWith('12345678', 'EU');
    expect(el.querySelector('.status--ok')?.textContent).toContain(
      'Valid · anna@berg.de · Fabrikam',
    );
    expect(el.querySelector('.actions__hint')?.textContent).toContain('Add a note');
    expect(button(el, 'Save token').disabled).toBe(true);

    type(note!, 'Fabrikam');
    await settle();
    expect(button(el, 'Save token').disabled).toBe(false);

    // Editing the token throws the verification away.
    type(secret!, '123456789');
    await settle();
    expect(button(el, 'Save token').disabled).toBe(true);

    button(el, 'Verify').click();
    await settle();
    button(el, 'Save token').click();
    await settle();
    expect(api.create).toHaveBeenCalledWith({ note: 'Fabrikam', token: '123456789', region: 'EU' });
    expect(el.querySelectorAll('.token')).toHaveLength(2);
  });

  it('asks before removing a token, and keeps it when the answer is no', async () => {
    const { el, api, modal, settle } = await mount([TOKEN], false);
    button(el, 'Remove token').click();
    await settle();
    expect(modal.open).toHaveBeenCalledOnce();
    expect(api.remove).not.toHaveBeenCalled();
    expect(el.querySelectorAll('.token')).toHaveLength(1);
  });

  it('removes the token once confirmed', async () => {
    const { el, api, settle } = await mount([TOKEN], true);
    button(el, 'Remove token').click();
    await settle();
    expect(api.remove).toHaveBeenCalledWith('nw');
    expect(el.querySelectorAll('.token')).toHaveLength(0);
  });

  it('names the host of each data center', () => {
    expect(hostOf('EU')).toBe('api.phrase.com');
    expect(hostOf('US')).toBe('api.us.app.phrase.com');
  });
});
