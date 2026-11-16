// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Dialog } from '@angular/cdk/dialog';

import { LxMenu } from './menu.js';
import { LxModalService, LxModalShell } from './modal.js';
import { LxRadioCard, LxRadioCardGroup } from './radio-card.js';
import { LxSegmentedControl, type SegmentOption } from './segmented-control.js';
import { LxToastHost } from './toast.js';

/**
 * M13's keyboard and screen-reader contract for the kit's composite widgets.
 *
 * What jsdom can prove honestly: which element has focus, which value a key
 * chose, and which ARIA attributes name what. It cannot prove that a screen
 * reader then announces them — that needs a manual pass with a real screen reader.
 */

const key = (el: Element, k: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
};

@Component({
  imports: [LxMenu],
  template: `
    <button id="trigger" type="button" (click)="open.set(true)">open</button>
    @if (open()) {
      <div lxMenu aria-label="Things" (lxMenuClose)="open.set(false)">
        <button type="button" role="menuitem">one</button>
        <button type="button" role="menuitem" disabled>two</button>
        <button type="button" role="menuitemcheckbox" aria-checked="false">three</button>
      </div>
    }
  `,
})
class MenuHost {
  readonly open = signal(false);
}

describe('lxMenu', () => {
  async function opened() {
    const fixture = TestBed.createComponent(MenuHost);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const trigger = el.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, el, trigger, menu: el.querySelector('[role="menu"]')! };
  }

  it('moves focus to the first item when it opens', async () => {
    const { el } = await opened();
    expect(document.activeElement?.textContent).toBe('one');
    expect(el.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Things');
  });

  it('wraps with the arrows and skips a disabled item', async () => {
    const { menu } = await opened();
    key(menu, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('three');
    key(menu, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('one');
    key(menu, 'ArrowUp');
    expect(document.activeElement?.textContent).toBe('three');
    key(menu, 'Home');
    expect(document.activeElement?.textContent).toBe('one');
  });

  it('does not let a handled arrow reach the page behind it', async () => {
    const { menu, el } = await opened();
    const seen: string[] = [];
    el.addEventListener('keydown', (e) => seen.push(e.key));
    key(menu, 'ArrowDown');
    expect(seen).toEqual([]);
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    const { fixture, menu, trigger, el } = await opened();
    key(menu, 'Escape');
    fixture.detectChanges();
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

@Component({
  imports: [LxRadioCard, LxRadioCardGroup],
  template: `
    <lx-radio-card-group aria-label="Theme">
      @for (v of values; track v) {
        <lx-radio-card
          [title]="v"
          [selected]="value() === v"
          [disabled]="v === 'off'"
          (click)="value.set(v)"
        />
      }
    </lx-radio-card-group>
  `,
})
class RadioHost {
  readonly values = ['dark', 'off', 'light', 'system'];
  readonly value = signal('dark');
}

describe('LxRadioCardGroup', () => {
  function mount() {
    const fixture = TestBed.createComponent(RadioHost);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, cards: [...el.querySelectorAll<HTMLElement>('lx-radio-card')] };
  }

  it('is one tab stop: only the checked card is focusable by Tab', () => {
    const { cards } = mount();
    expect(cards.map((c) => c.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });

  it('selects the next choosable card with the arrows, skipping a disabled one', async () => {
    const { fixture, cards } = mount();
    cards[0]!.focus();
    key(cards[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('light');
    key(cards[2]!, 'ArrowLeft');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('dark');
    key(cards[0]!, 'ArrowUp');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('system');
    await fixture.whenStable();
    expect(document.activeElement).toBe(cards[3]);
  });

  it('makes the first choosable card the tab stop while none is checked', () => {
    const { fixture, cards } = mount();
    fixture.componentInstance.value.set('');
    fixture.detectChanges();
    expect(cards.map((c) => c.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    key(cards[0]!, ' ');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('dark');

    fixture.componentInstance.value.set('');
    fixture.detectChanges();
    key(cards[0]!, 'ArrowRight');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('light');
    expect(cards.map((c) => c.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
  });

  it('selects with Space, and never selects a disabled card', () => {
    const { fixture, cards } = mount();
    key(cards[2]!, ' ');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('light');
    key(cards[1]!, ' ');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('light');
    expect(cards[1]!.getAttribute('aria-disabled')).toBe('true');
  });
});

@Component({
  imports: [LxSegmentedControl],
  template: `<lx-segmented-control
    ariaLabelledby="rule-x"
    [options]="options"
    [(value)]="value"
  />`,
})
class SegHost {
  readonly options: SegmentOption[] = [
    { value: 'error', label: 'Error' },
    { value: 'warning', label: 'Warning', disabled: true },
    { value: 'off', label: 'Off' },
  ];
  readonly value = signal('error');
}

describe('LxSegmentedControl', () => {
  it('is named by the label it points at, and moves with ←/→ past a disabled option', () => {
    const fixture = TestBed.createComponent(SegHost);
    fixture.detectChanges();
    const group = (fixture.nativeElement as HTMLElement).querySelector('lx-segmented-control')!;
    expect(group.getAttribute('aria-labelledby')).toBe('rule-x');

    key(group, 'ArrowRight');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('off');
    key(group, 'ArrowRight');
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('error');
  });
});

@Component({
  imports: [LxModalShell],
  template: `<lx-modal-shell title="Composed prompt"><input aria-label="Term" /></lx-modal-shell>`,
})
class ModalContent {}

describe('LxModalShell', () => {
  it('names its dialog by its own title, and offers a visible way out', async () => {
    const modal = TestBed.inject(LxModalService);
    const ref = modal.open(ModalContent);
    await new Promise((r) => setTimeout(r));
    TestBed.tick();

    const container = document.querySelector('.cdk-dialog-container')!;
    const title = container.querySelector('h2')!;
    expect(title.id).not.toBe('');
    expect(container.getAttribute('aria-labelledby')).toBe(title.id);

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    expect(close).not.toBeNull();
    // CDK focuses the first tabbable element on open; that must be the
    // dialog's own first field, never the way out.
    expect(
      container
        .querySelector('button, input, textarea, select, a[href]')
        ?.getAttribute('aria-label'),
    ).toBe('Term');
    let closed = false;
    ref.closed.subscribe(() => (closed = true));
    close.click();
    expect(closed).toBe(true);
    TestBed.inject(Dialog).closeAll();
  });
});

describe('LxToastHost', () => {
  it('keeps its live region in the DOM before the first toast, so that toast is announced', () => {
    const fixture = TestBed.createComponent(LxToastHost);
    fixture.detectChanges();
    const region = (fixture.nativeElement as HTMLElement).querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.children).toHaveLength(0);
  });
});
