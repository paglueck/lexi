// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { LxModalShell } from './modal.js';

describe('LxModalShell', () => {
  it('shows its title as the heading, not as a tooltip over the whole dialog', () => {
    @Component({
      imports: [LxModalShell],
      template: `<lx-modal-shell title="Draft with local model">Body</lx-modal-shell>`,
    })
    class Host {}

    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const shell = (fixture.nativeElement as HTMLElement).querySelector(
      'lx-modal-shell',
    ) as HTMLElement;

    expect(shell.querySelector('.title')?.textContent?.trim()).toBe('Draft with local model');
    expect(shell.hasAttribute('title')).toBe(false);
  });
});
