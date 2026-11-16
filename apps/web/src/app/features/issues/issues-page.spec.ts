// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueFinding, IssuesSummary, UnitDetail, UnitTarget } from '@lexi/shared';

import {
  IssuesStore,
  findingSummary,
  groupFindings,
  placeholderInventory,
} from '../../core/stores/issues-store.js';
import { issueTrackList } from '../../core/stores/issues-columns-store.js';
import { IssuesPage, scopeFrom } from './issues-page.js';
import { shown, targetWithAbsent } from './shown-segments.js';

/**
 * S12. The pure rules first, because each is easy to get subtly wrong and
 * invisible in a screenshot, then the page against a faked store: what is
 * offered, and what the keys do.
 */

const CLOSE = { k: 'p' as const, id: 'CLOSE_LINK', equivText: '</a>' };
const OPEN = { k: 'p' as const, id: 'START_LINK', equivText: '<a>' };

function finding(over: Partial<IssueFinding> = {}): IssueFinding {
  return {
    rule: 'placeholder.mismatch',
    severity: 'error',
    message: 'missing CLOSE_LINK',
    placeholders: { missing: ['CLOSE_LINK'], unexpected: [] },
    rowId: 'messages\u001fterms',
    unitId: 'terms',
    group: 'messages',
    locale: 'de',
    file: 'messages.de.xlf',
    state: 'draftMachine',
    excerpt: [{ k: 't', v: 'Ich akzeptiere die ' }, OPEN, { k: 't', v: 'AGB' }],
    fix: {
      kind: 'insert-edge',
      explanation: 'Add </a> after “AGB”.',
      origin: 'from source tag pairing',
      segments: [{ k: 't', v: 'Ich akzeptiere die ' }, OPEN, { k: 't', v: 'AGB' }, CLOSE],
      changed: [3],
    },
    ...over,
  };
}

describe('groupFindings', () => {
  const a = finding({ file: 'b.xlf', locale: 'fr', unitId: 'a' });
  const b = finding({ file: 'a.xlf', locale: 'de', unitId: 'b' });
  const c = finding({ file: 'b.xlf', locale: 'de', unitId: 'c' });

  it('groups by file, files in order, findings in their own order', () => {
    const groups = groupFindings([a, b, c], 'file');
    expect(groups.map((g) => g.label)).toEqual(['a.xlf', 'b.xlf']);
    expect(groups[1]?.findings.map((f) => f.unitId)).toEqual(['a', 'c']);
  });

  it('groups by locale', () => {
    expect(groupFindings([a, b, c], 'locale').map((g) => g.label)).toEqual(['de', 'fr']);
  });

  it('makes one unlabelled group when not grouping, and none for no findings', () => {
    expect(groupFindings([a, b], 'none')).toEqual([{ label: '', findings: [a, b] }]);
    expect(groupFindings([], 'none')).toEqual([]);
  });
});

describe('placeholderInventory', () => {
  it('counts each id on both sides, source order first, extras after', () => {
    const source = [OPEN, { k: 't' as const, v: 'x' }, CLOSE];
    const target = [OPEN, { k: 'p' as const, id: 'EXTRA' }, OPEN];
    expect(placeholderInventory(source, target)).toEqual([
      { id: 'START_LINK', source: 1, target: 2 },
      { id: 'CLOSE_LINK', source: 1, target: 0 },
      { id: 'EXTRA', source: 0, target: 1 },
    ]);
  });
});

describe('findingSummary', () => {
  it('says what is missing, extra or renamed', () => {
    expect(findingSummary(finding())).toBe('CLOSE_LINK missing');
    expect(
      findingSummary(finding({ placeholders: { missing: ['ICU'], unexpected: ['ICU_1'] } })),
    ).toBe('ICU renamed to ICU_1');
    expect(findingSummary(finding({ placeholders: { missing: [], unexpected: ['X', 'X'] } }))).toBe(
      'X extra ×2',
    );
  });

  it('falls back to the engine’s sentence for a rule with no ids', () => {
    expect(findingSummary({ message: 'Leading whitespace differs.' })).toBe(
      'Leading whitespace differs.',
    );
  });
});

describe('targetWithAbsent', () => {
  it('draws the missing chip dashed where an edge fix would put it', () => {
    const f = finding();
    const out = targetWithAbsent(f.excerpt, f);
    expect(out.at(-1)).toEqual({ k: 'p', v: 'CLOSE_LINK ?', tone: 'absent' });
  });

  it('marks the chip a finding is about, and appends what it cannot place', () => {
    const f = finding({
      placeholders: { missing: ['A', 'B'], unexpected: ['START_LINK'] },
      fix: null,
    });
    const out = targetWithAbsent(f.excerpt, f);
    expect(out.find((s) => s.k === 'p' && s.v === '<a>')?.tone).toBe('danger');
    expect(out.slice(-2).map((s) => s.v)).toEqual(['A ?', 'B ?']);
  });

  it('shows a fix preview with only the inserted chip accepted', () => {
    const fix = finding().fix!;
    const out = shown(fix.segments, { changed: new Set(fix.changed), changedTone: 'accepted' });
    expect(out.filter((s) => s.tone === 'accepted').map((s) => s.v)).toEqual(['</a>']);
    expect(out.find((s) => s.v === '<a>')?.tone).toBeNull();
  });
});

describe('issueTrackList', () => {
  it('keeps the badge fixed and the target flexible, and sizes the other three', () => {
    expect(issueTrackList({})).toBe('22px 160px minmax(120px, 1fr) 240px 100px');
    expect(issueTrackList({ finding: 420 })).toBe('22px 160px minmax(120px, 1fr) 420px 100px');
  });
});

describe('scopeFrom', () => {
  const params = (record: Record<string, string>) => ({ get: (n: string) => record[n] ?? null });

  it('reads rule, locale and row', () => {
    expect(scopeFrom(params({ rule: 'whitespace.edges', locale: 'de', rowId: 'r' }))).toEqual({
      rule: 'whitespace.edges',
      locale: 'de',
      rowId: 'r',
    });
  });

  it('drops a rule it does not know rather than asking the server for it', () => {
    expect(scopeFrom(params({ rule: 'nope' })).rule).toBeNull();
  });
});

/* ---- the page ------------------------------------------------------------- */

const SUMMARY: IssuesSummary = {
  validatedAt: Date.UTC(2026, 8, 29, 12, 9),
  units: 4812,
  locales: ['de', 'fr'],
  errors: 6,
  warnings: 3,
  ignored: 5,
  rulesOff: 2,
  rules: [
    { rule: 'placeholder.mismatch', severity: 'error', count: 6, locales: ['de', 'fr'] },
    { rule: 'whitespace.edges', severity: 'warning', count: 3, locales: ['de'] },
  ],
};

function fakeStore(findings: readonly IssueFinding[]) {
  const target: UnitTarget = {
    locale: 'de',
    isRtl: false,
    state: 'draftMachine',
    missing: false,
    noFile: false,
    newFile: null,
    segments: [...findings[0]!.excerpt],
    findings: [
      { rule: 'placeholder.mismatch', severity: 'error', message: 'missing CLOSE_LINK' },
      { rule: 'glossary.term', severity: 'warning', message: '“terms” should be “AGB”.' },
    ],
    missingPlaceholders: ['CLOSE_LINK'],
    charCount: 22,
    previous: null,
    origin: null,
    reviewReasons: [],
  };
  const detail = {
    rowId: findings[0]!.rowId,
    unitId: 'terms',
    group: 'messages',
    sourceLocale: 'en-GB',
    source: [{ k: 't', v: 'I accept the ' }, OPEN, { k: 't', v: 'terms' }, CLOSE],
    locations: [{ sourcefile: 'checkout/terms.component.html', linenumber: 12 }],
    targets: [target],
  } as unknown as UnitDetail;

  const selectedIndex = signal(0);
  return {
    selectedIndex,
    active: signal(true),
    summary: signal(SUMMARY),
    rule: signal('placeholder.mismatch'),
    ruleSummary: signal(SUMMARY.rules[0]),
    locale: signal(null),
    grouping: signal('file'),
    groups: signal(groupFindings(findings, 'file')),
    findings: signal(findings),
    selected: () => findings[selectedIndex()],
    fixableCount: signal(findings.filter((f) => f.fix !== null).length),
    localeCount: signal(1),
    isLoading: signal(false),
    loadError: signal(null),
    busy: signal(false),
    error: signal(null),
    ignored: signal(null),
    detail: signal(detail),
    target: signal(target),
    inventory: signal(placeholderInventory(detail.source, target.segments)),
    others: signal([target.findings[1]]),
    detailResource: { isLoading: () => false, error: () => undefined },
    setActive: vi.fn(),
    enter: vi.fn(),
    select: vi.fn((i: number) => selectedIndex.set(i)),
    move: vi.fn(),
    stepRule: vi.fn(),
    selectRule: vi.fn(),
    setLocale: vi.fn(),
    applyFix: vi.fn(() => Promise.resolve(true)),
    applyAll: vi.fn(() => Promise.resolve(true)),
    ignore: vi.fn(() => Promise.resolve(true)),
    unignore: vi.fn(),
    loadIgnored: vi.fn(),
    closeIgnored: vi.fn(),
    revalidate: vi.fn(),
    redraft: vi.fn(),
    reload: vi.fn(),
  };
}

function mount(findings: readonly IssueFinding[]) {
  const store = fakeStore(findings);
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  TestBed.overrideProvider(IssuesStore, { useValue: store });
  const fixture = TestBed.createComponent(IssuesPage);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const key = (k: string) => {
    host.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    fixture.detectChanges();
  };
  return { store, fixture, host, key };
}

describe('IssuesPage', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists rules by severity, with the selected one marked', () => {
    const { host } = mount([finding()]);
    const rules = [...host.querySelectorAll('lx-issues-rules .rule')];
    const text = (r: Element, sel: string) => r.querySelector(sel)?.textContent?.trim();
    expect(rules.map((r) => [text(r, '.rule__name'), text(r, '.rule__n')])).toEqual([
      ['Placeholder mismatch', '6'],
      ['Whitespace differs', '3'],
    ]);
    expect(rules[0]?.getAttribute('aria-current')).toBe('true');
    expect(host.querySelector('.foot__counts')?.textContent).toContain('2 rules off');
    expect(host.querySelector('.foot__counts')?.textContent).toContain('5 findings ignored');
  });

  it('gives every findings column a resize handle and sets the geometry once, on the host', () => {
    const { host } = mount([finding()]);
    // Unit, finding and state; the target flexes into what they leave.
    expect(host.querySelectorAll('.cols .resizer')).toHaveLength(3);
    const table = host.querySelector<HTMLElement>('lx-issues-findings');
    expect(table?.style.getPropertyValue('--lx-issues-cols')).toBe(issueTrackList({}));
  });

  it('shows the finding in short, and FR-8.4’s notice', () => {
    const { host } = mount([finding()]);
    expect(host.querySelector('.row .finding')?.textContent).toBe('CLOSE_LINK missing');
    expect(host.querySelector('.notice')?.textContent).toContain(
      'Saving is allowed with 6 errors open',
    );
  });

  it('offers the fix, the inventory and what else is wrong with the unit', () => {
    const { host } = mount([finding()]);
    expect(host.querySelector('.fix__apply')).not.toBeNull();
    expect(host.querySelector('.fix__note')?.textContent).toContain('stays a machine draft');
    const mismatched = host.querySelectorAll('.inv-row[data-mismatch="true"]');
    expect([...mismatched].map((r) => r.querySelector('.inv-id')?.textContent)).toEqual([
      'CLOSE_LINK',
    ]);
    expect(host.querySelector('.others')?.textContent).toContain('should be “AGB”');
    expect(host.querySelector('.lx-chip[data-tone="absent"]')?.textContent).toContain(
      'CLOSE_LINK ?',
    );
  });

  it('offers no fix card when there is no single right answer', () => {
    const { host } = mount([finding({ fix: null })]);
    expect(host.querySelector('.fix')).toBeNull();
    expect(host.textContent).toContain('Open in grid');
  });

  it('answers f, i, [ and ]', () => {
    const { store, key } = mount([finding()]);
    key('f');
    expect(store.applyFix).toHaveBeenCalledOnce();
    key('i');
    expect(store.ignore).toHaveBeenCalledOnce();
    key(']');
    expect(store.stepRule).toHaveBeenCalledWith(1);
    key('[');
    expect(store.stepRule).toHaveBeenCalledWith(-1);
    key('ArrowDown');
    expect(store.move).toHaveBeenCalledWith(1);
  });

  it('does not apply a fix that does not exist', () => {
    const { store, key } = mount([finding({ fix: null })]);
    key('f');
    expect(store.applyFix).not.toHaveBeenCalled();
  });

  it('opens the unit in the grid on Enter, through the URL', () => {
    const { key } = mount([finding()]);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    key('Enter');
    expect(navigate).toHaveBeenCalledWith(['/grid'], {
      queryParams: { row: 'messages\u001fterms', locale: 'de' },
    });
  });

  it('names the selected finding to a screen reader', () => {
    const { host } = mount([
      finding(),
      finding({ unitId: 'other', rowId: 'messages\u001fother', message: 'x' }),
    ]);
    const list = host.querySelector('[role="listbox"]');
    expect(list?.getAttribute('aria-activedescendant')).toBe('issue-finding-0');
    expect(host.querySelector('#issue-finding-0')?.getAttribute('aria-selected')).toBe('true');
  });
});
