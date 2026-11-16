// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeSegments } from '@lexi/xliff';
import {
  rowIdOf,
  type BulkApproveResponse,
  type Project,
  type TargetPatchResponse,
  type UnitDetail,
  type UnitState,
  type UnitTarget,
  type UnitsQueryResponse,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { originKey, targetHash } from '../src/lib/machine-origin.js';
import { classifyReviewOutcome, recordOutcome, type ReviewStats } from '../src/lib/review-stats.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M12: FR-7.4's edit-rate counter, the `toReview` review queue (FR-7.1) and
 * bulk approve (FR-7.3).
 *
 * Machine-origin markers are seeded directly through `ProjectService`, the same
 * access `edit.test.ts` has, rather than through a real LLM round trip
 * (`prompt.test.ts`/`jobs.test.ts` already cover that pipeline) — what these
 * tests are actually about is the classification and the queue, not drafting.
 */

const unit = (id: string, source: string, target?: string, state?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${
          target === undefined
            ? ''
            : `\n        <target${state === undefined ? '' : ` state="${state}"`}>${target}</target>`
        }
      </trans-unit>`;

const xlf = (targetLanguage: string | null, units: string): string => {
  const attr = targetLanguage === null ? '' : ` target-language="${targetLanguage}"`;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template"${attr}>
    <body>
${units}
    </body>
  </file>
</xliff>
`;
};

const sourceXlf = xlf(
  'en-GB',
  [unit('pay', 'Pay now'), unit('review', 'Reviewed later'), unit('done', 'Already done')].join(
    '\n',
  ),
);

const deXlf = xlf(
  'de',
  [
    unit('pay', 'Pay now', 'Jetzt bezahlen'),
    unit('review', 'Reviewed later', 'Später geprüft', 'needs-review-translation'),
    unit('done', 'Already done', 'Bereits erledigt', 'translated'),
  ].join('\n'),
);

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

const PAY = rowIdOf('messages', 'pay');
const REVIEW = rowIdOf('messages', 'review');
const DONE = rowIdOf('messages', 'done');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-review-')));
  root = join(base, 'app');
  stateDir = join(base, 'state');
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await app?.close();
  await rm(join(root, '..'), { recursive: true, force: true });
});

beforeEach(async () => {
  await app?.close();
  await rm(join(root, '.lexi'), { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), deXlf, 'utf8');

  projects = new ProjectService();
  app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
  await open();
});

async function open(): Promise<Project> {
  const scan = await app.inject({
    method: 'POST',
    url: '/api/projects/scan',
    headers: goodHeaders(),
    payload: { path: root },
  });
  const files = scan.json<{
    files: Array<{ path: string; fileIndex: number; locale: string | null }>;
  }>().files;
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects/open',
    headers: goodHeaders(),
    payload: {
      path: root,
      sourceLocale: 'en-GB',
      mapping: files
        .filter((f) => f.locale !== null)
        .map((f) => ({
          path: f.path,
          fileIndex: f.fileIndex,
          locale: f.locale,
          fixTargetLanguage: false,
        })),
    },
  });
  return res.json<Project>();
}

/**
 * `pay`'s current German bytes ("Jetzt bezahlen") are marked as a machine draft.
 *
 * `previous` is what the draft is recorded as having displaced. It is a
 * SNAPSHOT rather than something the server could look up, because a saved
 * draft has already overwritten the file it would have looked in — so these
 * tests seed it the same way `translateUnit` writes it.
 */
function markPayAsMachineDraft(previous?: { text: string; state: UnitState } | null): void {
  const hash = targetHash(composeSegments([{ k: 't', v: 'Jetzt bezahlen' }], 'angular'));
  projects.setMachineOrigin(PAY, 'de', {
    at: new Date().toISOString(),
    model: 'test-model',
    style: 'raw',
    hash,
    previous:
      previous === undefined || previous === null
        ? null
        : { segments: [{ k: 't', v: previous.text }], state: previous.state },
    temperature: 0.2,
    styleGuide: 'de.md',
    glossaryInjected: 3,
    glossaryApplied: 2,
    glossaryTotal: 148,
    confidence: 'high',
    notesForReviewer: 'Kept the formal register.',
  });
  projects.rebuildIndex();
}

const detail = async (rowId: string): Promise<UnitDetail> =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    })
  ).json<UnitDetail>();

const targetOf = (d: UnitDetail, locale: string): UnitTarget =>
  d.targets.find((t) => t.locale === locale) as UnitTarget;

const reject = (rowId: string, locale: string, reasons: string[] = []) =>
  app.inject({
    method: 'PATCH',
    url: url(rowId, locale),
    headers: goodHeaders(),
    payload: { segments: [], review: { decision: 'reject', reasons } },
  });

const url = (rowId: string, locale: string, suffix = '') =>
  `/api/units/${encodeURIComponent(rowId)}/targets/${locale}${suffix}`;

const patch = (
  rowId: string,
  locale: string,
  segments: Array<{ k: 't'; v: string }>,
  state?: string,
) =>
  app.inject({
    method: 'PATCH',
    url: url(rowId, locale),
    headers: goodHeaders(),
    payload: state === undefined ? { segments } : { segments, state },
  });

const project = async (): Promise<Project> =>
  (
    await app.inject({ method: 'GET', url: '/api/project', headers: goodHeaders() })
  ).json<Project>();

const editRateOf = async (locale: string) =>
  (await project()).editRate.find((e) => e.locale === locale);

describe('classifyReviewOutcome (pure)', () => {
  it('is approvedClean only when the submitted bytes match the draft exactly', () => {
    expect(classifyReviewOutcome('abc', 'abc')).toBe('approvedClean');
    expect(classifyReviewOutcome('abc', 'def')).toBe('corrected');
  });
});

describe('recordOutcome (pure)', () => {
  it('accumulates per locale without touching others', () => {
    let stats: ReviewStats = new Map();
    stats = recordOutcome(stats, 'de', 'approvedClean');
    stats = recordOutcome(stats, 'de', 'corrected');
    stats = recordOutcome(stats, 'fr', 'approvedClean');
    expect(stats.get('de')).toEqual({ approvedClean: 1, corrected: 1 });
    expect(stats.get('fr')).toEqual({ approvedClean: 1, corrected: 0 });
  });
});

describe('the toReview review queue (FR-7.1)', () => {
  it('matches machine drafts and needs-review, nothing else, for the scoped locale', async () => {
    markPayAsMachineDraft();
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: { locales: ['de'], filters: ['toReview'] },
    });
    const body = res.json<UnitsQueryResponse>();
    expect(new Set(body.ids)).toEqual(new Set([PAY, REVIEW]));
    expect(body.ids).not.toContain(DONE);
  });
});

describe('Approve (FR-7.3) resubmits the unchanged draft', () => {
  it('records approvedClean and advances the state to reviewed', async () => {
    markPayAsMachineDraft();
    const res = await patch(PAY, 'de', [{ k: 't', v: 'Jetzt bezahlen' }], 'reviewed');
    expect(res.statusCode).toBe(200);
    expect(res.json<TargetPatchResponse>().target.state).toBe('reviewed');

    const rate = await editRateOf('de');
    expect(rate).toMatchObject({ approvedClean: 1, corrected: 0, rate: 100 });
    // The origin is forgotten the same way a typed edit already forgets it.
    expect(projects.machineOrigins.has(originKey(PAY, 'de'))).toBe(false);
  });
});

describe('Edit corrects a machine draft', () => {
  it('records corrected when the submitted text differs from the draft', async () => {
    markPayAsMachineDraft();
    const res = await patch(PAY, 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    expect(res.statusCode).toBe(200);

    const rate = await editRateOf('de');
    expect(rate).toMatchObject({ approvedClean: 0, corrected: 1, rate: 0 });
  });
});

describe('Reject (S11) puts back what the draft displaced', () => {
  it('empties the target when the draft filled an empty cell', async () => {
    markPayAsMachineDraft(null);
    const res = await reject(PAY, 'de');
    expect(res.statusCode).toBe(200);
    expect(res.json<TargetPatchResponse>().target.state).toBe('untranslated');
    expect(res.json<TargetPatchResponse>().target.segments).toEqual([]);

    expect(await editRateOf('de')).toMatchObject({ approvedClean: 0, corrected: 1 });
  });

  it('restores the exact previous bytes AND the previous state, not "reviewed"', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'final' });
    const res = await reject(PAY, 'de');
    expect(res.statusCode).toBe(200);
    const target = res.json<TargetPatchResponse>().target;
    expect(target.segments).toEqual([{ k: 't', v: 'Sofort zahlen' }]);
    // Nobody reviewed this text — the reviewer rejected something else. Letting
    // `stateForEdit` infer `reviewed` from "there is text" would promote a
    // human translation on the strength of a rejection.
    expect(target.state).toBe('final');
  });

  it("ignores the body's segments entirely — the snapshot is the server's", async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'final' });
    const res = await app.inject({
      method: 'PATCH',
      url: url(PAY, 'de'),
      headers: goodHeaders(),
      // A browser holding something else, or nothing at all, cannot decide what
      // "put it back" means: after a save it is not holding the old text.
      payload: {
        segments: [{ k: 't', v: 'Etwas ganz anderes' }],
        state: 'reviewed',
        review: { decision: 'reject' },
      },
    });
    const target = res.json<TargetPatchResponse>().target;
    expect(target.segments).toEqual([{ k: 't', v: 'Sofort zahlen' }]);
    expect(target.state).toBe('final');
  });

  it('records corrected even when the draft reproduced the previous target verbatim', async () => {
    // The inversion a stated decision exists to prevent: restoring these bytes
    // submits the draft's own hash, which the M12 comparison would have read as
    // "approved unchanged" — for a rejection.
    markPayAsMachineDraft({ text: 'Jetzt bezahlen', state: 'reviewed' });
    const res = await reject(PAY, 'de');
    expect(res.statusCode).toBe(200);
    expect(res.json<TargetPatchResponse>().target.segments).toEqual([
      { k: 't', v: 'Jetzt bezahlen' },
    ]);
    expect(await editRateOf('de')).toMatchObject({ approvedClean: 0, corrected: 1 });
  });

  it('refuses an unknown member on the review object rather than dropping it', async () => {
    markPayAsMachineDraft();
    const res = await app.inject({
      method: 'PATCH',
      url: url(PAY, 'de'),
      headers: goodHeaders(),
      payload: { segments: [], review: { decision: 'reject', resaons: ['too-long'] } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Reject reasons (S11)', () => {
  it('persists to .lexi/review-notes.json and comes back on the target', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'reviewed' });
    await reject(PAY, 'de', ['ignores-glossary', 'too-long']);

    expect(targetOf(await detail(PAY), 'de').reviewReasons).toEqual([
      'ignores-glossary',
      'too-long',
    ]);

    const onDisk = JSON.parse(await readFile(join(root, '.lexi', 'review-notes.json'), 'utf8')) as {
      groups: Record<string, Record<string, Record<string, string[]>>>;
    };
    // Nested by group, then unit, then locale — a unit id is unique within a
    // file group, not within a project, and the nesting is what merges cleanly.
    expect(onDisk.groups.messages?.pay?.de).toEqual(['ignores-glossary', 'too-long']);
  });

  it('is cleared by the next decision that settles the string', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'reviewed' });
    await reject(PAY, 'de', ['too-long']);

    markPayAsMachineDraft();
    const res = await app.inject({
      method: 'PATCH',
      url: url(PAY, 'de'),
      headers: goodHeaders(),
      payload: {
        segments: [{ k: 't', v: 'Jetzt bezahlen' }],
        state: 'reviewed',
        review: { decision: 'approve' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<TargetPatchResponse>().target.reviewReasons).toEqual([]);
  });

  it('survives a close and reopen, because it is a note to the next person', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'reviewed' });
    await reject(PAY, 'de', ['wrong-register']);

    await app.inject({ method: 'POST', url: '/api/projects/close', headers: goodHeaders() });
    await open();
    expect(targetOf(await detail(PAY), 'de').reviewReasons).toEqual(['wrong-register']);
  });

  it('is left alone by an ordinary grid PATCH, which states no decision', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'reviewed' });
    await reject(PAY, 'de', ['too-long']);
    await patch(PAY, 'de', [{ k: 't', v: 'Jetzt zahlen' }]);
    expect(targetOf(await detail(PAY), 'de').reviewReasons).toEqual(['too-long']);
  });
});

describe('What the Review screen reads off a target (S11)', () => {
  it('carries the provenance and the displaced text while the marker is live', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'final' });
    const target = targetOf(await detail(PAY), 'de');

    expect(target.state).toBe('draftMachine');
    expect(target.origin).toMatchObject({
      model: 'test-model',
      temperature: 0.2,
      styleGuide: 'de.md',
      glossaryInjected: 3,
      glossaryApplied: 2,
      glossaryTotal: 148,
      confidence: 'high',
      notesForReviewer: 'Kept the formal register.',
    });
    expect(target.previous).toEqual({ segments: [{ k: 't', v: 'Sofort zahlen' }], state: 'final' });
  });

  it('says nothing about a cell no model ever wrote', async () => {
    const target = targetOf(await detail(DONE), 'de');
    expect(target.origin).toBeNull();
    expect(target.previous).toBeNull();
    expect(target.reviewReasons).toEqual([]);
  });

  it('goes quiet the moment the bytes stop matching the marker', async () => {
    markPayAsMachineDraft({ text: 'Sofort zahlen', state: 'final' });
    // A hand edit anywhere — here, in an editor, in a merge — makes the record
    // a claim about bytes that are gone. Showing "here is how the model made
    // this" over somebody's correction would be a lie with no expiry.
    await patch(PAY, 'de', [{ k: 't', v: 'Von Hand geändert' }]);

    const target = targetOf(await detail(PAY), 'de');
    expect(target.state).not.toBe('draftMachine');
    expect(target.origin).toBeNull();
    expect(target.previous).toBeNull();
  });
});

describe('A commit against a cell with no machine origin', () => {
  it('touches neither counter — the metric only ever measures machine drafts', async () => {
    // `review` is needsReview but was never a machine draft.
    const res = await patch(REVIEW, 'de', [{ k: 't', v: 'Geprüft und korrigiert' }]);
    expect(res.statusCode).toBe(200);
    expect(await editRateOf('de')).toMatchObject({ approvedClean: 0, corrected: 0, rate: null });
  });
});

describe('Discard (Escape/revert) does not forget an accurate machine-origin marker', () => {
  it('leaves the marker in place — a bug this milestone bundles a fix for', async () => {
    markPayAsMachineDraft();
    const res = await app.inject({
      method: 'DELETE',
      url: url(PAY, 'de', '/draft'),
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(projects.machineOrigins.has(originKey(PAY, 'de'))).toBe(true);
  });
});

describe('Bulk approve (FR-7.3)', () => {
  it('approves every qualifying row, skips the rest, and lands only in the overlay', async () => {
    markPayAsMachineDraft();
    const res = await app.inject({
      method: 'POST',
      url: '/api/units/bulk-approve',
      headers: goodHeaders(),
      payload: { rowIds: [PAY, REVIEW, DONE], locale: 'de' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<BulkApproveResponse>();
    expect(new Set(body.approved)).toEqual(new Set([PAY, REVIEW]));
    expect(body.skipped).toEqual([DONE]);
    expect(body.unsavedCount).toBe(2);

    const rate = await editRateOf('de');
    // Only `pay` was a machine draft; `review` had no origin marker.
    expect(rate).toMatchObject({ approvedClean: 1, corrected: 0 });
  });
});

/**
 * The detail route's `?locales=` override (M15, reported from use).
 *
 * The panel beside the grid shows the row's VISIBLE columns, which is right for
 * it and wrong for the Review screen: that takes its locale from the URL and
 * may be reviewing one the grid is not showing. Without the override the unit
 * came back with no target for it at all, and the centre column fell into its
 * empty state while the queue rail — which asks for its own locale explicitly —
 * listed the drafts perfectly.
 */
describe('asking for one locale regardless of what the grid is showing', () => {
  it('returns the locale that was asked for, not the visible columns', async () => {
    // Narrow the project to `de` only, the way the grid's column menu does.
    await app.inject({
      method: 'PATCH',
      url: '/api/project',
      headers: goodHeaders(),
      payload: { visibleLocales: ['de'] },
    });

    const withoutAsking = await detail(PAY);
    expect(withoutAsking.targets.map((t) => t.locale)).toEqual(['de']);

    const asked = (
      await app.inject({
        method: 'GET',
        url: `/api/units/${encodeURIComponent(PAY)}?locales=de`,
        headers: goodHeaders(),
      })
    ).json<UnitDetail>();
    expect(asked.targets.map((t) => t.locale)).toEqual(['de']);
  });

  it('refuses a locale the project does not have rather than inventing a target', async () => {
    const res = (
      await app.inject({
        method: 'GET',
        url: `/api/units/${encodeURIComponent(PAY)}?locales=xx`,
        headers: goodHeaders(),
      })
    ).json<UnitDetail>();
    expect(res.targets).toEqual([]);
  });
});
