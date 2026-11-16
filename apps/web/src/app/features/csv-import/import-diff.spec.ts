// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { SegmentDto } from '@lexi/shared';

import { diffSegments } from '../review/diff-segments.js';
import { LxImportDiff, type ImportDiffView } from './import-diff.js';

const chip: SegmentDto = { k: 'p', id: 'X', equivText: '{{ x }}' };
const parts = diffSegments(
  [{ k: 't', v: 'Save now ' }, chip],
  [{ k: 't', v: 'Store it now ' }, chip],
  { groups: true, tidy: true },
);

const mount = (view: ImportDiffView): HTMLElement => {
  const fixture = TestBed.createComponent(LxImportDiff);
  fixture.componentRef.setInput('parts', parts);
  fixture.componentRef.setInput('view', view);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
};

describe('LxImportDiff', () => {
  it('draws removals and additions together inline', () => {
    const el = mount('inline');
    expect(el.querySelector('.del')?.textContent).toBe('Save ');
    expect(el.querySelector('.ins')?.textContent).toBe('Store it ');
    expect(el.querySelector('.lx-chip')?.textContent).toBe('{{ x }}');
  });

  it('shows no additions on the In Lexi side', () => {
    const el = mount('split-old');
    expect(el.querySelector('.del')).not.toBeNull();
    expect(el.querySelector('.ins')).toBeNull();
  });

  it('shows no deletions on the In CSV side', () => {
    const el = mount('split-new');
    expect(el.querySelector('.del')).toBeNull();
    expect(el.querySelector('.ins')?.textContent).toBe('Store it ');
  });
});
