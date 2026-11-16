// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventsStore, parseEvent } from './events-store.js';

/**
 * The one place in the client where data crosses a boundary without a schema
 * behind it.
 *
 * `LexiEventSchema` cannot be used here — importing it would pull zod into the
 * browser bundle, which docs/architecture.md keeps out of it — so the narrowing is hand-written
 * and therefore worth asserting. The stream stays open across a server restart,
 * so "a frame from a version that is not this one" is an ordinary event, not a
 * hypothetical: every malformed shape below must come back as null rather than
 * as a half-built object the store then acts on.
 */
const RUN = {
  at: '2026-09-16T12:00:00Z',
  model: 'qwen2.5:14b',
  placeholderStyle: 'masked',
  latencyMs: 9,
  promptTokens: null,
  completionTokens: null,
  parse: 'json',
  confidence: 'high',
  notesForReviewer: null,
  raw: '{"translation":"x"}',
};

const ACCEPTED_ENTRY = {
  seq: 0,
  at: '2026-09-16T12:00:00Z',
  rowId: 'messagesa',
  locale: 'de',
  outcome: 'accepted',
  run: RUN,
  rejection: null,
  message: null,
  findings: [],
};

describe('parseEvent', () => {
  it('accepts the frames the client acts on', () => {
    expect(parseEvent('{"type":"hello","serverId":"abc","at":1}')).toEqual({
      type: 'hello',
      serverId: 'abc',
      at: 1,
    });
    expect(parseEvent('{"type":"file-changed","paths":["/a.xlf","/b.xlf"]}')).toEqual({
      type: 'file-changed',
      paths: ['/a.xlf', '/b.xlf'],
    });
    expect(
      parseEvent('{"type":"save-complete","written":["/a.xlf"],"at":"2026-09-16T12:00:00Z"}'),
    ).toEqual({ type: 'save-complete', written: ['/a.xlf'], at: '2026-09-16T12:00:00Z' });
  });

  it('accepts a job-progress frame, currentRowId null included (a job that just finished)', () => {
    const frame =
      '{"type":"job-progress","jobId":"j1","locale":"de","jobAvgMsPerUnit":14,"currentIndex":2,"currentRowId":null,' +
      '"accepted":1,"rejected":0,"skipped":1,"failed":0,"avgMsPerUnit":12.5}';
    expect(parseEvent(frame)).toEqual({
      type: 'job-progress',
      jobId: 'j1',
      locale: 'de',
      jobAvgMsPerUnit: 14,
      currentIndex: 2,
      currentRowId: null,
      accepted: 1,
      rejected: 0,
      skipped: 1,
      failed: 0,
      avgMsPerUnit: 12.5,
    });
  });

  it('refuses a job-progress frame that does not say which locale it is about', () => {
    const frame =
      '{"type":"job-progress","jobId":"j1","jobAvgMsPerUnit":null,"currentIndex":2,"currentRowId":null,' +
      '"accepted":1,"rejected":0,"skipped":1,"failed":0,"avgMsPerUnit":12.5}';
    expect(parseEvent(frame)).toBeNull();
  });

  it('accepts a job-locale-state frame for every locale status, and refuses an unknown one', () => {
    for (const status of [
      'queued',
      'running',
      'paused',
      'done',
      'skipped',
      'cancelled',
      'failed',
    ]) {
      expect(
        parseEvent(
          `{"type":"job-locale-state","jobId":"j1","locale":"fr","status":"${status}","startedAt":null,"finishedAt":null}`,
        ),
      ).toEqual({
        type: 'job-locale-state',
        jobId: 'j1',
        locale: 'fr',
        status,
        startedAt: null,
        finishedAt: null,
      });
    }
    expect(
      parseEvent(
        '{"type":"job-locale-state","jobId":"j1","locale":"fr","status":"exploded","startedAt":null,"finishedAt":null}',
      ),
    ).toBeNull();
  });

  it('accepts a job-removed frame', () => {
    expect(parseEvent('{"type":"job-removed","jobId":"j1"}')).toEqual({
      type: 'job-removed',
      jobId: 'j1',
    });
    expect(parseEvent('{"type":"job-removed"}')).toBeNull();
  });

  const jobState = (extra: string): string => `{"type":"job-state","jobId":"j1",${extra}}`;

  it('accepts a job-state frame for every status the vocabulary allows', () => {
    for (const status of ['queued', 'running', 'paused', 'done', 'cancelled', 'failed']) {
      expect(
        parseEvent(jobState(`"status":"${status}","startedAt":null,"finishedAt":null`)),
      ).toEqual({
        type: 'job-state',
        jobId: 'j1',
        status,
        startedAt: null,
        finishedAt: null,
      });
    }
  });

  it('carries the timestamps a job-state frame brings with it', () => {
    expect(
      parseEvent(
        jobState(
          '"status":"done","startedAt":"2026-09-21T11:34:00Z","finishedAt":"2026-09-21T11:36:14Z"',
        ),
      ),
    ).toMatchObject({ startedAt: '2026-09-21T11:34:00Z', finishedAt: '2026-09-21T11:36:14Z' });
  });

  it('rejects a job-state frame whose status is not in the vocabulary', () => {
    expect(
      parseEvent(jobState('"status":"exploding","startedAt":null,"finishedAt":null')),
    ).toBeNull();
  });

  it('rejects a job-state frame whose timestamps are the wrong shape', () => {
    // This file narrows SSE by hand to keep zod out of the bundle, so every new
    // field needs its own check — a missing one would let `undefined` through
    // as a timestamp and render "Invalid Date".
    expect(parseEvent(jobState('"status":"done","finishedAt":null'))).toBeNull();
    expect(parseEvent(jobState('"status":"done","startedAt":12345,"finishedAt":null'))).toBeNull();
  });

  it('accepts a job-log frame and passes the entry through untouched', () => {
    expect(
      parseEvent(JSON.stringify({ type: 'job-log', jobId: 'j1', entry: ACCEPTED_ENTRY })),
    ).toEqual({
      type: 'job-log',
      jobId: 'j1',
      entry: ACCEPTED_ENTRY,
    });
  });

  it('rejects a job-log frame whose entry is missing its routing fields', () => {
    expect(
      parseEvent(JSON.stringify({ type: 'job-log', jobId: 'j1', entry: { seq: 0 } })),
    ).toBeNull();
    expect(parseEvent(JSON.stringify({ type: 'job-log', jobId: 'j1', entry: null }))).toBeNull();
    expect(parseEvent('{"type":"job-log","jobId":"j1"}')).toBeNull();
    expect(
      parseEvent(
        JSON.stringify({
          type: 'job-log',
          jobId: 'j1',
          entry: { ...ACCEPTED_ENTRY, outcome: 'exploded' },
        }),
      ),
    ).toBeNull();
  });

  it('accepts an empty written list — a save that rewrote nothing (FR-1.6)', () => {
    expect(parseEvent('{"type":"save-complete","written":[],"at":"x"}')).toEqual({
      type: 'save-complete',
      written: [],
      at: 'x',
    });
  });

  it('rejects anything that is not one of them', () => {
    // Heartbeats are not subscribed to, and an unknown type is a newer server
    // — `index-updated` (M5) is real in the vocabulary but has no schema yet.
    expect(parseEvent('{"type":"heartbeat","at":1}')).toBeNull();
    expect(parseEvent('{"type":"index-updated"}')).toBeNull();
  });

  it('rejects a frame whose fields are the wrong shape', () => {
    expect(parseEvent('{"type":"file-changed"}')).toBeNull();
    expect(parseEvent('{"type":"file-changed","paths":"/a.xlf"}')).toBeNull();
    expect(parseEvent('{"type":"file-changed","paths":[1,2]}')).toBeNull();
    expect(parseEvent('{"type":"save-complete","written":["/a.xlf"]}')).toBeNull();
    expect(parseEvent('{"type":"hello","serverId":"abc"}')).toBeNull();
    expect(parseEvent('{"type":"job-progress","jobId":"j1"}')).toBeNull();
  });

  it('survives a payload that is not an object at all', () => {
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent('null')).toBeNull();
    expect(parseEvent('[]')).toBeNull();
    expect(parseEvent('"file-changed"')).toBeNull();
  });

  it('reads a Phrase push frame, and refuses an unknown stage', () => {
    const frame = (stage: string) =>
      `{"type":"phrase-push-progress","index":1,"total":3,"relPath":"messages.de.xlf","localeId":"de","stage":"${stage}"}`;
    expect(parseEvent(frame('processing'))).toEqual({
      type: 'phrase-push-progress',
      index: 1,
      total: 3,
      relPath: 'messages.de.xlf',
      localeId: 'de',
      stage: 'processing',
    });
    expect(parseEvent(frame('exploding'))).toBeNull();
  });

  it('reads a Phrase checkout frame, and refuses an unknown step or state', () => {
    expect(
      parseEvent(
        '{"type":"phrase-checkout-progress","step":"fetch-keys","state":"waiting","detail":"Waiting for Phrase rate limit…"}',
      ),
    ).toEqual({
      type: 'phrase-checkout-progress',
      step: 'fetch-keys',
      state: 'waiting',
      detail: 'Waiting for Phrase rate limit…',
    });
    expect(
      parseEvent(
        '{"type":"phrase-checkout-progress","step":"fetch-all","state":"done","detail":""}',
      ),
    ).toBeNull();
    expect(
      parseEvent(
        '{"type":"phrase-checkout-progress","step":"fetch-keys","state":"late","detail":""}',
      ),
    ).toBeNull();
    expect(
      parseEvent('{"type":"phrase-checkout-progress","step":"fetch-keys","state":"done"}'),
    ).toBeNull();
  });

  it('reads a shared-source frame, and refuses an unknown source', () => {
    expect(parseEvent('{"type":"shared-source-changed","source":"termbase"}')).toEqual({
      type: 'shared-source-changed',
      source: 'termbase',
    });
    expect(parseEvent('{"type":"shared-source-changed","source":"styleguides"}')).toEqual({
      type: 'shared-source-changed',
      source: 'styleguides',
    });
    expect(parseEvent('{"type":"shared-source-changed","source":"glossary"}')).toBeNull();
    expect(parseEvent('{"type":"shared-source-changed"}')).toBeNull();
  });
});

describe('EventsStore.connect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('listens for every job frame the job queue folds', () => {
    // SSE frames are NAMED events, so a type the store can parse but never
    // subscribes to is silently dropped — which is how S14's locale chips
    // once stayed on "queued" while their locale ran.
    const types: string[] = [];
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener(type: string): void {
          types.push(type);
        }
        close(): void {}
      },
    );
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    TestBed.inject(EventsStore).connect();
    expect(types).toEqual(
      expect.arrayContaining([
        'job-progress',
        'job-state',
        'job-locale-state',
        'job-removed',
        'job-log',
        'shared-source-changed',
        'phrase-push-progress',
        'phrase-checkout-progress',
      ]),
    );
  });
});
