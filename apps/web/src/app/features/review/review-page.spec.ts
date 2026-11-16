// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import type { Finding, UnitDetail, UnitTarget } from '@lexi/shared';

import { ReviewStore } from '../../core/stores/review-store.js';

import { ReviewPage, busiestLocale, scopeFrom } from './review-page.js';

/**
 * S11's decision rules, and the one that costs most if it is wrong: a blocking
 * finding must not be acceptable with the primary button (FR-8.4).
 *
 * The spec also exists for a second reason — a
 * component no spec imports is never compiled by `ng test`, so its template is
 * type-checked at build time and nowhere else.
 */

const params = (record: Record<string, string>) => ({
  get: (name: string): string | null => record[name] ?? null,
});

const loc = (locale: string, draftMachine = 0, needsReview = 0) => ({
  locale,
  draftMachine,
  needsReview,
});

describe('busiestLocale', () => {
  it('picks the locale with the most waiting, not the first in the list', () => {
    // The tab carries no parameters, and a project's first target locale
    // alphabetically is very often one nobody has drafted anything for — the
    // screen would say "nothing to review" while the title bar's own pill said
    // five drafts were pending.
    expect(busiestLocale([loc('ar'), loc('de', 5), loc('fr', 1, 1)])).toBe('de');
  });

  it('counts needs-review alongside machine drafts, since both are in the queue', () => {
    expect(busiestLocale([loc('ar', 0, 4), loc('de', 3)])).toBe('ar');
  });

  it('falls back to the first locale when nothing is waiting anywhere', () => {
    expect(busiestLocale([loc('ar'), loc('de')])).toBe('ar');
  });

  it('is null for a project with no target locales', () => {
    expect(busiestLocale([])).toBeNull();
  });
});

describe('scopeFrom', () => {
  it('reads a locale queue off the query string', () => {
    expect(scopeFrom(params({ locale: 'de' }), [loc('de'), loc('fr')])).toEqual({
      kind: 'locale',
      locale: 'de',
    });
  });

  it('reads a one-unit queue, which is what a single draft links to', () => {
    expect(scopeFrom(params({ rowId: 'messagespay', locale: 'de' }), [loc('de')])).toEqual({
      kind: 'unit',
      rowId: 'messagespay',
      locale: 'de',
    });
  });

  it('lets a job win over a locale, because the job carries its own', () => {
    expect(scopeFrom(params({ job: 'j1', locale: 'fr' }), [loc('de')])).toEqual({
      kind: 'job',
      jobId: 'j1',
      locale: 'fr',
    });
  });

  it('falls back to the busiest locale when the URL says nothing', () => {
    // Reachable from the tab, which carries no parameters at all.
    expect(scopeFrom(params({}), [loc('ar'), loc('de', 5)])).toEqual({
      kind: 'locale',
      locale: 'de',
    });
  });

  it('is null when the project has no target locale to review', () => {
    expect(scopeFrom(params({}), [])).toBeNull();
  });

  it('ignores a rowId with no locale rather than guessing one', () => {
    // A one-unit queue for the wrong locale would show a target nobody drafted.
    expect(scopeFrom(params({ rowId: 'messagespay' }), [loc('de')])).toEqual({
      kind: 'locale',
      locale: 'de',
    });
  });
});

/**
 * A stand-in for `ReviewStore`, faked rather than driven: reaching a loaded
 * draft for real would need a queue query, a row window and a detail fetch, for
 * a test about which button is disabled. The same call `job-card.spec.ts` makes
 * about `JobsStore`.
 */
function fakeStore(
  over: {
    findings?: readonly Finding[];
    complete?: boolean;
    error?: string;
    unitError?: unknown;
  } = {},
) {
  const findings = over.findings ?? [];
  const target: UnitTarget = {
    locale: 'de',
    isRtl: false,
    state: 'draftMachine',
    missing: false,
    noFile: false,
    newFile: null,
    segments: [{ k: 't', v: 'Jetzt bezahlen' }],
    findings: [...findings],
    missingPlaceholders: [],
    charCount: 14,
    previous: { segments: [{ k: 't', v: 'Sofort zahlen' }], state: 'reviewed' },
    origin: { at: '2026-09-17T14:07:00Z', model: 'qwen2.5:14b', style: 'masked' },
    reviewReasons: [],
  };
  const detail: UnitDetail = {
    rowId: 'messagespay',
    unitId: 'pay',
    group: 'messages',
    customId: true,
    isIcu: false,
    sourceLocale: 'en-GB',
    source: [{ k: 't', v: 'Pay now' }],
    notes: [],
    locations: [],
    targets: [target],
    files: { de: 'messages.de.xlf' },
    notesFile: 'messages.xlf',
    notesFileIsTemplate: true,
    notesPending: false,
  };
  return {
    scope: signal(null),
    ids: signal(['messagespay']),
    decided: signal(new Map()),
    busy: signal(false),
    error: signal(over.error ?? null),
    resource: { error: signal(over.unitError) },
    fellBackToLocale: signal(false),
    locale: signal('de'),
    selectedIndex: signal(0),
    selectedRowId: signal('messagespay'),
    detail: signal(detail),
    isLoading: signal(false),
    target: signal(target),
    openIds: signal(['messagespay']),
    doneCount: signal(0),
    acceptedCount: signal(0),
    rejectedCount: signal(0),
    openPosition: signal(1),
    editRate: signal(undefined),
    blocked: signal(findings.some((f) => f.severity === 'error')),
    complete: signal(over.complete ?? false),
    decisionFor: () => undefined,
    enter: async () => undefined,
    reload: async () => undefined,
    approve: async () => undefined,
    acceptNeedsReview: async () => undefined,
    editCommit: async () => undefined,
    reject: async () => undefined,
    redraft: async () => undefined,
    revert: async () => undefined,
    skip: () => undefined,
    previous: () => undefined,
    next: () => undefined,
    select: () => undefined,
    bulkApprove: async () => null,
    clearError: () => undefined,
    reset: () => undefined,
  };
}

const buttonNamed = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('ReviewPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
  });

  const mount = () => {
    const fixture = TestBed.createComponent(ReviewPage);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  const mountWith = (store: ReturnType<typeof fakeStore>) => {
    TestBed.overrideProvider(ReviewStore, { useValue: store });
    return mount();
  };

  it('says the queue is empty rather than rendering an empty decision surface', () => {
    const el = mount();
    expect(el.textContent).toContain('Nothing to review');
  });

  it('says why the surface is empty when the queue failed to load (M13)', () => {
    const el = mountWith(fakeStore({ error: 'No project is open.' }));
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('No project is open.');
    expect(el.textContent).not.toContain('every draft has been decided');
  });

  it("reports a failed unit read in the server's words", () => {
    const el = mountWith(
      fakeStore({ unitError: { error: { error: { message: 'Unit not found' } } } }),
    );
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Unit not found');
  });

  it('mounts the queue rail and the context rail either way', () => {
    // Both rails are part of the screen's shape, not of the selected draft:
    // a queue that empties under the reviewer must not collapse the layout.
    const el = mount();
    expect(el.querySelector('lx-review-queue')).not.toBeNull();
    expect(el.querySelector('lx-review-context')).not.toBeNull();
  });

  it('shows the source, the draft and the diff against what was there before', () => {
    const el = mountWith(fakeStore());
    expect(el.textContent).toContain('Pay now');
    expect(el.textContent).toContain('Jetzt bezahlen');
    // The previous target is a snapshot the server took at draft time — after a
    // save it exists nowhere else, which is why the diff cannot be derived.
    expect(el.textContent).toContain('Against previous target');
    expect(el.textContent).toContain('Sofort zahlen');
  });

  it('leaves plain Accept available when the checks are clean', () => {
    const el = mountWith(fakeStore());
    expect(buttonNamed(el, 'Accept & next')?.disabled).toBe(false);
  });

  it('disables plain Accept on a blocking finding, and only that button (FR-8.4)', () => {
    const el = mountWith(
      fakeStore({
        findings: [
          {
            rule: 'placeholder.mismatch',
            severity: 'error',
            message: 'target is missing INTERPOLATION',
          },
        ],
      }),
    );
    // A draft that would not survive as Final must not be acceptable in one
    // click — but it may still be the most useful thing on the screen, so
    // "Accept & mark needs review" and Reject stay open.
    expect(buttonNamed(el, 'Accept & next')?.disabled).toBe(true);
    expect(buttonNamed(el, 'Accept & mark needs review')?.disabled).toBe(false);
    expect(buttonNamed(el, 'Reject')?.disabled).toBe(false);
  });

  it('leaves Accept alone for a warning, which is a thing to look at rather than a blocker', () => {
    const el = mountWith(
      fakeStore({
        findings: [{ rule: 'whitespace.edges', severity: 'warning', message: 'trailing space' }],
      }),
    );
    expect(buttonNamed(el, 'Accept & next')?.disabled).toBe(false);
  });

  it('says nothing about being finished while drafts are still open', () => {
    const el = mountWith(fakeStore());
    expect(el.querySelector('lx-review-complete')).toBeNull();
  });

  it('announces a finished queue without hiding the unit underneath it', () => {
    // The queue keeps decided rows on purpose so one can be revisited; a panel
    // that replaced the surface would fight that the moment it appeared.
    const el = mountWith(fakeStore({ complete: true }));
    expect(el.querySelector('lx-review-complete')).not.toBeNull();
    expect(el.textContent).toContain('Queue complete');
    expect(el.textContent).toContain('Jetzt bezahlen');
  });

  it('offers a way back to the grid, and to whatever is waiting next', () => {
    const el = mountWith(fakeStore({ complete: true }));
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).toContain('Back to the grid');
  });

  it('offers every reject reason as a chip that does not itself reject', () => {
    const el = mountWith(fakeStore());
    const chip = buttonNamed(el, 'Ignores term base');
    expect(chip).toBeDefined();
    expect(chip?.getAttribute('aria-pressed')).toBe('false');
  });
});
