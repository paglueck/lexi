// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  type Project,
  type PromptPreviewResponse,
  type SaveResponse,
  type TranslateUnitResponse,
  type UnitDetail,
  type UnitsQueryResponse,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M9: the composed prompt (S5, FR-5.7) and the first real translation (FR-6.5).
 *
 * Everything here runs against a REAL HTTP server standing in for the local
 * model, not a stubbed client. That is deliberate: the two guarantees worth
 * testing at this level are that the request goes to the configured endpoint
 * and nowhere else (FR-6.15) and that what comes back is gated before it can
 * reach a file — and both of those live in the layers a stub would skip.
 */

const INTERP = '<x id="INTERPOLATION" equiv-text="{{ count }}"/>';

const unit = (id: string, source: string, target?: string, extra = ''): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}${extra}
      </trans-unit>`;

const NOTES = `
        <context-group purpose="location">
          <context context-type="sourcefile">src/app/billing/summary.component.html</context>
          <context context-type="linenumber">42</context>
        </context-group>
        <note priority="1" from="description">Shown above the invoice table.</note>
        <note priority="1" from="meaning">billing.period-summary</note>`;

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
  [
    unit('invoices', `You have ${INTERP} invoices`, undefined, NOTES),
    unit('pay', 'Pay now'),
    unit('greeting', 'Welcome back to your account overview'),
  ].join('\n'),
);

/** `invoices` and `greeting` are untranslated; `pay` carries a human translation. */
const deXlf = xlf(
  'de',
  [
    unit('invoices', `You have ${INTERP} invoices`),
    unit('pay', 'Pay now', 'Jetzt bezahlen'),
    unit('greeting', 'Welcome back to your account overview'),
  ].join('\n'),
);

/**
 * French has a file, but only one of the three units — the ordinary state of a
 * hand-maintained translation file some strings were added to since (FR-1.9).
 * Polish has no file at all, which is the other half of the same requirement.
 */
const frXlf = xlf('fr', unit('pay', 'Pay now', 'Payer maintenant'));

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

const INVOICES = rowIdOf('messages', 'invoices');
const PAY = rowIdOf('messages', 'pay');
const GREETING = rowIdOf('messages', 'greeting');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-prompt-')));
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
  // Locale files CREATED by a test would otherwise survive into the next one —
  // and a project with an unexpected `messages.pl.xlf` in it is a fixture
  // nobody wrote.
  for (const name of await readdir(root)) {
    if (name.endsWith('.xlf')) await rm(join(root, name), { force: true });
  }
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), deXlf, 'utf8');
  await writeFile(join(root, 'messages.fr.xlf'), frXlf, 'utf8');

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
  expect(res.statusCode).toBe(200);
  return res.json<Project>();
}

const preview = async (payload: Record<string, unknown>): Promise<PromptPreviewResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/prompt/preview',
    headers: goodHeaders(),
    payload,
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<PromptPreviewResponse>();
};

const translate = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/translate/unit', headers: goodHeaders(), payload });

const detailOf = async (rowId: string): Promise<UnitDetail> =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    })
  ).json<UnitDetail>();

/**
 * Masking on: the translate tests answer with `[[n]]` tokens, which is the
 * masked path. Raw is the default since masking became opt-in; the raw path
 * has tests of its own that pass `placeholderStyle: 'raw'` explicitly.
 */
const configure = (origin: string, model = 'qwen2.5:14b') =>
  app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: goodHeaders(),
    payload: { baseUrl: `${origin}/v1`, model, maskPlaceholders: true },
  });

/* -- a stand-in for the local model ---------------------------------------- */

interface FakeModel {
  readonly origin: string;
  /** Every request body the model was sent, parsed. */
  readonly prompts: Array<{ system: string; user: string }>;
  /** The same requests, whole — for the assertions that are about parameters. */
  readonly bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * One answer per request, so a retry can be given a different one.
 *
 * A `string` is the ordinary case and is wrapped in a well-formed completion.
 * A whole object is the response body verbatim, which is how a test says
 * something the wrapper cannot — an empty `content` with `finish_reason:
 * 'length'`, or a `usage` that splits reasoning out from the total.
 */
type FakeAnswer = string | Record<string, unknown>;

async function fakeModel(...answers: FakeAnswer[]): Promise<FakeModel> {
  const prompts: Array<{ system: string; user: string }> = [];
  const bodies: Array<Record<string, unknown>> = [];
  let next = 0;

  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      if ((req.url ?? '').endsWith('/chat/completions')) {
        const parsed = JSON.parse(body) as {
          messages: Array<{ role: string; content: string }>;
        };
        bodies.push(parsed as unknown as Record<string, unknown>);
        prompts.push({
          system: parsed.messages.find((m) => m.role === 'system')?.content ?? '',
          // The LAST user turn: a retry carries the original request plus the
          // stricter instruction, and it is the instruction we are asking about.
          user: parsed.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '',
        });
        const answer = answers[Math.min(next, answers.length - 1)] ?? '';
        next += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            typeof answer === 'string'
              ? {
                  choices: [{ message: { role: 'assistant', content: answer } }],
                  usage: { prompt_tokens: 210, completion_tokens: 12 },
                }
              : answer,
          ),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    prompts,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => resolve(raw));
  });

const json = (translation: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ translation, confidence: 'high', notes_for_reviewer: null, ...extra });

let model: FakeModel | null = null;
afterEach(async () => {
  await model?.close();
  model = null;
});

/* -- the preview ----------------------------------------------------------- */

describe('POST /api/prompt/preview', () => {
  it('composes the blocks in the order requirements §6 fixes', async () => {
    const result = await preview({ rowId: INVOICES, locale: 'de' });
    expect(result.blocks.map((b) => b.id)).toEqual([
      'role',
      'invariants',
      'styleguide.global',
      'styleguide.de',
      'terminology',
      'user',
    ]);
    expect(result.blocks.filter((b) => b.role === 'user').map((b) => b.id)).toEqual(['user']);
  });

  it('keeps markup that is part of the source text when masking, rather than forbidding all markup', async () => {
    const result = await preview({ rowId: INVOICES, locale: 'de', placeholderStyle: 'masked' });
    const invariants = result.blocks.find((b) => b.id === 'invariants')?.content ?? '';
    expect(invariants).toContain(
      'keep any markup that is part of the source text exactly as written',
    );
    expect(invariants).not.toContain('Never write XML or HTML markup of any kind');
  });

  it('composes with raw markup when the settings say nothing', async () => {
    const result = await preview({ rowId: INVOICES, locale: 'de' });
    expect(result.placeholderStyle).toBe('raw');
  });

  it('masks placeholders as [[n]] and says what each one stands for', async () => {
    const result = await preview({ rowId: INVOICES, locale: 'de', placeholderStyle: 'masked' });
    const user = result.blocks.find((b) => b.id === 'user')?.content ?? '';
    expect(user).toContain('You have [[0]] invoices');
    expect(user).toContain('[[0]] = {{ count }}');
    expect(result.placeholders).toEqual([
      { token: '[[0]]', label: '{{ count }}', id: 'INTERPOLATION' },
    ]);
  });

  it('keeps the raw-markup path, so the two prompts can be compared on one unit', async () => {
    const result = await preview({ rowId: INVOICES, locale: 'de', placeholderStyle: 'raw' });
    const user = result.blocks.find((b) => b.id === 'user')?.content ?? '';
    expect(user).toContain(INTERP);
    expect(user).not.toContain('[[0]]');
  });

  it('carries the context Angular already wrote: location, description and meaning', async () => {
    const user =
      (await preview({ rowId: INVOICES, locale: 'de' })).blocks.find((b) => b.id === 'user')
        ?.content ?? '';
    // FR-4.3b: the template path is cheap, reliable context.
    expect(user).toContain('src/app/billing/summary.component.html (line 42)');
    expect(user).toContain('Shown above the invoice table.');
    expect(user).toContain('billing.period-summary');
    expect(user).toContain('messages.de.xlf');
  });

  /**
   * FR-4.5. A silently missing field is what makes a small model invent one, so
   * the absence is stated rather than omitted.
   */
  it('says out loud when a unit has no note at all', async () => {
    const user =
      (await preview({ rowId: PAY, locale: 'de' })).blocks.find((b) => b.id === 'user')?.content ??
      '';
    expect(user).toContain('No context note was provided for this string');
  });

  it('reports an absent style guide as an empty block rather than dropping it', async () => {
    const result = await preview({ rowId: PAY, locale: 'de' });
    const global = result.blocks.find((b) => b.id === 'styleguide.global');
    expect(global).toMatchObject({ empty: true, content: '', source: null });
    expect(global?.caption).toContain('No global style guide yet');
  });

  it('injects the style guides verbatim once they exist, locale after global', async () => {
    await mkdir(join(root, '.lexi', 'styleguides'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'styleguides', 'global.md'),
      '# Global\nSentence case.',
      'utf8',
    );
    await writeFile(
      join(root, '.lexi', 'styleguides', 'de.md'),
      '# Deutsch\nImmer siezen.',
      'utf8',
    );

    const result = await preview({ rowId: PAY, locale: 'de' });
    const global = result.blocks.find((b) => b.id === 'styleguide.global');
    const locale = result.blocks.find((b) => b.id === 'styleguide.de');

    expect(global).toMatchObject({ empty: false, source: 'global.md' });
    expect(global?.content).toContain('Sentence case.');
    expect(locale).toMatchObject({ empty: false, source: 'de.md' });
    expect(locale?.content).toContain('Immer siezen.');
    // FR-5.3: the locale guide must say that it wins on conflict.
    expect(locale?.content).toContain('take precedence over the global style guide');
    // And the global guide comes first in the message that is actually sent.
    expect(result.blocks.findIndex((b) => b.id === 'styleguide.global')).toBeLessThan(
      result.blocks.findIndex((b) => b.id === 'styleguide.de'),
    );
  });

  it('estimates tokens per block and totals them against the context window', async () => {
    const result = await preview({ rowId: INVOICES, locale: 'de' });
    const sum = result.blocks.reduce((n, b) => n + b.tokens, 0);
    expect(result.totals.tokens).toBeGreaterThan(0);
    expect(result.totals.estimated).toBe(true);
    expect(result.totals.contextWindow).toBe(8192);
    // Block counts and the totals measure the same text; blocks are counted one
    // by one and the totals over the joined message, so they agree to within the
    // rounding of each block.
    expect(Math.abs(sum - result.totals.tokens)).toBeLessThanOrEqual(result.blocks.length);
  });

  it('is reachable with nothing configured, and says what would stop a run', async () => {
    const result = await preview({ rowId: PAY, locale: 'de' });
    expect(result.blocked).toContain('No endpoint is configured');

    model = await fakeModel(json('Jetzt bezahlen'));
    await configure(model.origin);
    expect((await preview({ rowId: PAY, locale: 'de' })).blocked).toBe('');
  });

  it('refuses a unit or locale it does not have', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/prompt/preview',
      headers: goodHeaders(),
      payload: { rowId: rowIdOf('messages', 'nope'), locale: 'de' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

/* -- the run --------------------------------------------------------------- */

describe('POST /api/translate/unit', () => {
  it('answers a string that IS a Term Base term from its entry, final, with no model configured', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'termbase.csv'),
      'id,term,note,dnt,de\nt1,Welcome back to your account overview,,no,Willkommen zurück\n',
      'utf8',
    );
    // No endpoint and no model: the request must not need either.
    const res = await translate({ rowId: GREETING, locale: 'de' });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<TranslateUnitResponse>();
    expect(body.ok).toBe(true);
    expect(body.target?.state).toBe('final');
    expect(body.target?.segments).toEqual([{ k: 't', v: 'Willkommen zurück' }]);
    expect(body.run.parse).toBe('termbase');
    expect(body.run.model).toBe('Term Base');
    expect(projects.machineOrigins.size).toBe(0);
  });

  it('drafts a unit, lands it in Draft (machine), and writes no file', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);

    const res = await translate({ rowId: INVOICES, locale: 'de' });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<TranslateUnitResponse>();

    expect(body.ok).toBe(true);
    expect(body.rejection).toBeNull();
    expect(body.target?.state).toBe('draftMachine');
    expect(body.unsavedCount).toBe(1);
    // FR-6.10: never final, never saved behind the user's back.
    expect(await readFile(join(root, 'messages.de.xlf'), 'utf8')).toBe(deXlf);

    // The placeholder came back as the source's own bytes, not the model's idea
    // of them — the chip is restored, not re-serialized.
    expect(body.target?.segments).toEqual([
      { k: 't', v: 'Sie haben ' },
      { k: 'p', id: 'INTERPOLATION', equivText: '{{ count }}' },
      { k: 't', v: ' Rechnungen' },
    ]);
  });

  it('records the run: latency, the model, how it parsed, and the raw answer', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen', { confidence: 'medium' }));
    await configure(model.origin, 'phi4');

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.run.model).toBe('phi4');
    expect(body.run.parse).toBe('json');
    expect(body.run.confidence).toBe('medium');
    expect(body.run.promptTokens).toBe(210);
    expect(body.run.raw).toContain('Sie haben');
    expect(body.run.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the composed prompt, and only the composed prompt', async () => {
    model = await fakeModel(json('Willkommen zurück'));
    await configure(model.origin);
    await translate({ rowId: GREETING, locale: 'de' });

    expect(model.prompts).toHaveLength(1);
    const sent = model.prompts[0]!;
    const composed = await preview({ rowId: GREETING, locale: 'de' });
    // The whole point of S5: what the preview shows IS what the request carried.
    expect(sent.user).toBe(composed.blocks.find((b) => b.id === 'user')?.content);
    expect(sent.system).toContain('professional software localization specialist');
    expect(sent.system).toContain('en-GB to de');
  });

  /* -- tolerant parsing, FR-6.9 -- */

  it.each([
    ['```json\n{"translation":"Willkommen zurück"}\n```', 'fenced'],
    ['Sure! Here you go: {"translation":"Willkommen zurück"} — hope that helps.', 'embedded'],
    ['{"translation":"Willkommen zurück"}', 'json'],
  ])('recovers a translation from %s', async (answer, mode) => {
    model = await fakeModel(answer);
    await configure(model.origin);
    const body = (await translate({ rowId: GREETING, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(true);
    expect(body.run.parse).toBe(mode);
  });

  it('asks once more, more strictly, before giving up on the format', async () => {
    model = await fakeModel('Willkommen zurück', json('Willkommen zurück'));
    await configure(model.origin);

    const body = (await translate({ rowId: GREETING, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.run.parse).toBe('retried');
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]!.user).toContain('not valid JSON');
    // The retry is about the FORMAT, so the original request is still in it.
    expect(body.ok).toBe(true);
  });

  it('falls back to reading the whole answer as the translation', async () => {
    model = await fakeModel('Willkommen zurück', 'still not JSON');
    await configure(model.origin);

    const body = (await translate({ rowId: GREETING, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.run.parse).toBe('plain');
    expect(body.ok).toBe(true);
    expect(body.target?.segments).toEqual([{ k: 't', v: 'Willkommen zurück' }]);
  });

  /* -- the restore gate, FR-PH-7 and FR-6.11 -- */

  it('refuses a draft that dropped a placeholder, and writes nothing', async () => {
    model = await fakeModel(json('Sie haben Rechnungen'));
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection).toMatchObject({ reason: 'placeholder-missing' });
    expect(body.rejection?.missing).toEqual(['INTERPOLATION']);
    expect(body.target).toBeNull();
    expect(body.unsavedCount).toBe(0);
    // Flagged, never discarded: the answer is still there to look at.
    expect(body.run.raw).toContain('Sie haben Rechnungen');
  });

  it('refuses a draft that invented markup instead of using the token', async () => {
    model = await fakeModel(json('Sie haben <x id="INTERPOLATION"/> Rechnungen'));
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection?.reason).toBe('invented-markup');
  });

  it('gates the raw-markup path just as hard', async () => {
    model = await fakeModel(json('Sie haben <x id="NOPE"/> Rechnungen'));
    await configure(model.origin);

    const body = (
      await translate({ rowId: INVOICES, locale: 'de', placeholderStyle: 'raw' })
    ).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection?.reason).toBe('unknown-placeholder');
  });

  /**
   * A blank completion is the one rejection whose likely cause Lexi guesses
   * at, and only when the estimate itself says the prompt was over budget —
   * a user who sees a translation work with no style guide and then always
   * fail the moment one is added is seeing exactly this (a local server
   * answering with nothing rather than erroring once a prompt leaves no room
   * for an answer), and the empty-model-text message alone gives them nothing
   * to act on.
   */
  it('names a likely cause for an empty answer when the prompt is over budget', async () => {
    // A global guide alone, well past the default 8,192-token window — the
    // scenario reported from use: translation works with no style guide and
    // stops the moment one is added, because now the prompt leaves the model
    // no room for an answer.
    await mkdir(join(root, '.lexi', 'styleguides'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'styleguides', 'global.md'),
      '# Guide\n' + 'word '.repeat(8000),
      'utf8',
    );

    model = await fakeModel(json(''));
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection?.reason).toBe('empty');
    expect(body.rejection?.detail).toContain('The model returned no text.');
    expect(body.rejection?.detail).toContain('context window');
    expect(body.rejection?.detail).toContain('Shorten the style guides');
  });

  it('does not guess at a cause when an empty answer is well within budget', async () => {
    model = await fakeModel(json(''));
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection).toMatchObject({
      reason: 'empty',
      detail: 'The model returned no text.',
    });
  });

  /* -- the reasoning budget (the "Try another method" loop) ---------------- */

  it('asks for no reasoning by default', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);

    await translate({ rowId: INVOICES, locale: 'de' });
    expect(model.bodies[0]?.['reasoning_effort']).toBe('none');
  });

  it('sends no reasoning_effort at all when the user defers to the server', async () => {
    // The whole point of the `'server'` value, and the one assertion standing
    // between this change and an endpoint that rejects a key it has never heard
    // of. `seed` has the same contract, for the same reason.
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: goodHeaders(),
      payload: { params: { reasoningEffort: 'server' } },
    });

    await translate({ rowId: INVOICES, locale: 'de' });
    expect('reasoning_effort' in (model.bodies[0] ?? {})).toBe(false);
  });

  it('passes a chosen effort through verbatim', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: goodHeaders(),
      payload: { params: { reasoningEffort: 'high' } },
    });

    await translate({ rowId: INVOICES, locale: 'de' });
    expect(model.bodies[0]?.['reasoning_effort']).toBe('high');
  });

  it('names reasoning when the model spends its whole budget thinking', async () => {
    // The reported failure, reduced: gemma-4-12b on "Try another method" loops
    // in `reasoning_content` until the ceiling stops it, and `content` comes
    // back empty. Without `finish_reason` the symptom and the cause have no
    // visible connection — the old message blamed the context window.
    model = await fakeModel({
      choices: [
        {
          message: { role: 'assistant', content: '', reasoning_content: 'Wait, I will use…' },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 210,
        completion_tokens: 10_000,
        completion_tokens_details: { reasoning_tokens: 10_000 },
      },
    });
    await configure(model.origin);

    const res = await translate({ rowId: INVOICES, locale: 'de' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      '10000 tokens thinking',
    );
    expect(res.json<{ error: { message: string } }>().error.message).toContain('Reasoning');
  });

  it('still says "no message content" when an empty answer simply stopped', async () => {
    // `finish_reason: 'stop'` is a model with nothing to say, which is the
    // older diagnosis and must not be swallowed by the newer one.
    model = await fakeModel({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 210, completion_tokens: 0 },
    });
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection?.reason).toBe('empty');
  });

  it('refuses a half-written answer instead of committing the fragment', async () => {
    // The quiet damage: `{"translation": "Sie haben ` parses as nothing, falls
    // back to `plain`, and a fragment carrying no placeholders sails through
    // the restore gate as a plausible half-sentence.
    model = await fakeModel({
      choices: [
        {
          message: { role: 'assistant', content: '{"translation": "Sie haben ' },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 210, completion_tokens: 512 },
    });
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(false);
    expect(body.rejection?.reason).toBe('truncated');
    expect(body.rejection?.detail).toContain('Max tokens');
    expect(body.target).toBeNull();
    // And the stricter retry was NOT spent on a ceiling that would stop it again.
    expect(model.bodies.length).toBe(1);
  });

  it('records reasoning tokens and the finish reason on the run', async () => {
    model = await fakeModel({
      choices: [
        {
          message: {
            role: 'assistant',
            content: json('Sie haben [[0]] Rechnungen'),
            reasoning_content: 'thinking out loud',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 210,
        completion_tokens: 300,
        completion_tokens_details: { reasoning_tokens: 275 },
      },
    });
    await configure(model.origin);

    const body = (await translate({ rowId: INVOICES, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(true);
    expect(body.run.reasoningTokens).toBe(275);
    expect(body.run.finishReason).toBe('stop');
  });

  it('attaches validation findings to an accepted draft without blocking it', async () => {
    // Right placeholders, wrong script — FR-6.11's "did it answer in the right
    // language", as much of it as a codepoint range can honestly answer.
    model = await fakeModel(json('Welcome back to your account overview'));
    await configure(model.origin);

    const body = (await translate({ rowId: GREETING, locale: 'de' })).json<TranslateUnitResponse>();
    expect(body.ok).toBe(true);
    expect(body.findings.map((f) => f.rule)).toContain('target.identicalToSource');
    expect(body.findings.every((f) => f.severity !== 'error')).toBe(true);
  });

  /* -- FR-6.10, the overwrite guard -- */

  it('refuses to replace a human translation without an explicit confirmation', async () => {
    model = await fakeModel(json('Jetzt zahlen'));
    await configure(model.origin);

    const refused = await translate({ rowId: PAY, locale: 'de' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain(
      'written by a person',
    );
    // And it did not even ask the model.
    expect(model.prompts).toHaveLength(0);

    const confirmed = await translate({ rowId: PAY, locale: 'de', overwrite: true });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<TranslateUnitResponse>().target?.state).toBe('draftMachine');
  });

  it('re-drafts its own earlier draft without asking, because that is a retry', async () => {
    model = await fakeModel(
      json('Sie haben [[0]] Rechnungen'),
      json('Sie haben [[0]] offene Rechnungen'),
    );
    await configure(model.origin);

    expect((await translate({ rowId: INVOICES, locale: 'de' })).statusCode).toBe(200);
    const second = await translate({ rowId: INVOICES, locale: 'de' });
    expect(second.statusCode).toBe(200);
    expect(second.json<TranslateUnitResponse>().target?.segments).toContainEqual({
      k: 't',
      v: ' offene Rechnungen',
    });
  });

  it('passes a retry instruction through to the prompt (FR-6.12)', async () => {
    model = await fakeModel(json('Kurz'));
    await configure(model.origin);
    await translate({ rowId: GREETING, locale: 'de', instruction: 'shorter, max 12 characters' });
    expect(model.prompts[0]!.user).toContain('shorter, max 12 characters');
  });

  /* -- the machine-origin marker, requirements §4.2 -- */

  it('marks the draft as machine-written, survives a save, and feeds the grid filter', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);
    await translate({ rowId: INVOICES, locale: 'de' });

    const save = await app.inject({
      method: 'POST',
      url: '/api/save',
      headers: goodHeaders(),
      payload: {},
    });
    expect(save.json<SaveResponse>().written).toHaveLength(1);

    // The marker is committed, not hidden in a cache.
    const state = JSON.parse(await readFile(join(root, '.lexi', 'state.json'), 'utf8')) as {
      groups: Record<string, Record<string, Record<string, { model: string }>>>;
    };
    expect(state.groups['messages']?.['invoices']?.['de']?.model).toBe('qwen2.5:14b');

    // After the save the state comes from the file plus the marker, and the
    // filter that had no data source until M9 finally counts something.
    const q = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: { locales: ['de'], filters: ['machineDrafts'] },
    });
    const body = q.json<UnitsQueryResponse>();
    expect(body.ids).toEqual([INVOICES]);
    expect(body.facets.machineDrafts).toBe(1);
  });

  /* -- what the Review screen reads off the marker, M14 -- */

  it('snapshots the human target it displaced, because a save destroys the original', async () => {
    model = await fakeModel(json('Sofort bezahlen'));
    await configure(model.origin);
    // `pay` already has a hand-written German target, so this needs FR-6.10's
    // explicit confirmation — and that is exactly the case S11 diffs.
    await translate({ rowId: PAY, locale: 'de', overwrite: true });

    await app.inject({ method: 'POST', url: '/api/save', headers: goodHeaders(), payload: {} });

    // The file on disk now holds the draft; the displaced text exists nowhere
    // else. Deriving the diff from the overlay would produce nothing here, and
    // "batch job, then save" is the ordinary way into the review queue.
    const state = JSON.parse(await readFile(join(root, '.lexi', 'state.json'), 'utf8')) as {
      groups: Record<string, Record<string, Record<string, { previous: unknown }>>>;
    };
    expect(state.groups['messages']?.['pay']?.['de']?.previous).toEqual({
      segments: [{ k: 't', v: 'Jetzt bezahlen' }],
      state: 'reviewed',
    });

    const target = (await detailOf(PAY)).targets.find((t) => t.locale === 'de');
    expect(target?.previous).toEqual({
      segments: [{ k: 't', v: 'Jetzt bezahlen' }],
      state: 'reviewed',
    });
  });

  it('records nothing to diff against when the draft filled an empty cell', async () => {
    model = await fakeModel(json('Willkommen zurück'));
    await configure(model.origin);
    await translate({ rowId: GREETING, locale: 'de' });

    const target = (await detailOf(GREETING)).targets.find((t) => t.locale === 'de');
    expect(target?.previous).toBeNull();
  });

  it('keeps the ORIGINAL snapshot across a re-draft', async () => {
    model = await fakeModel(json('Sofort bezahlen'));
    await configure(model.origin);
    await translate({ rowId: PAY, locale: 'de', overwrite: true });

    model = await fakeModel(json('Gleich bezahlen'));
    await configure(model.origin);
    // A re-draft is an ordinary retry over our own draft. Letting it overwrite
    // the snapshot would silently replace the human target the reviewer is
    // judging against with the machine's own previous attempt.
    await translate({ rowId: PAY, locale: 'de', instruction: 'shorter' });

    const target = (await detailOf(PAY)).targets.find((t) => t.locale === 'de');
    expect(target?.segments).toEqual([{ k: 't', v: 'Gleich bezahlen' }]);
    expect(target?.previous).toEqual({
      segments: [{ k: 't', v: 'Jetzt bezahlen' }],
      state: 'reviewed',
    });
  });

  it('records how the draft was made — model, temperature, guide, term base, confidence', async () => {
    await mkdir(join(root, '.lexi', 'styleguides'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'styleguides', 'de.md'),
      '# Deutsch\nImmer siezen.',
      'utf8',
    );
    await writeFile(
      join(root, '.lexi', 'glossary.json'),
      JSON.stringify({
        version: 1,
        terms: [
          {
            id: 'a',
            term: 'invoices',
            translations: { de: 'Rechnungen' },
            dnt: false,
            caseSensitive: false,
            note: '',
          },
          {
            id: 'b',
            term: 'account',
            translations: { de: 'Konto' },
            dnt: false,
            caseSensitive: false,
            note: '',
          },
        ],
      }),
      'utf8',
    );

    model = await fakeModel(
      json('Willkommen zurück in Ihrer Kontoübersicht', {
        notes_for_reviewer: 'Formal register kept.',
      }),
    );
    await configure(model.origin);
    await translate({ rowId: GREETING, locale: 'de' });

    const origin = (await detailOf(GREETING)).targets.find((t) => t.locale === 'de')?.origin;
    expect(origin).toMatchObject({
      model: 'qwen2.5:14b',
      temperature: 0.2,
      styleGuide: 'de.md',
      confidence: 'high',
      notesForReviewer: 'Formal register kept.',
      // Read from a pre-Term-Base glossary.json, which still counts. Only
      // "account" appears in the string, so only it was injected — and used.
      glossaryTotal: 2,
      glossaryInjected: 1,
      glossaryApplied: 1,
    });
  });

  /**
   * The marker must not outlive the text. Otherwise a reviewed, corrected
   * string would go on calling itself a machine draft for ever.
   */
  it('forgets the marker as soon as a person edits the draft', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);
    await translate({ rowId: INVOICES, locale: 'de' });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(INVOICES)}/targets/de`,
      headers: goodHeaders(),
      payload: {
        segments: [
          { k: 't', v: 'Sie haben ' },
          { k: 'p', id: 'INTERPOLATION' },
          { k: 't', v: ' offene Rechnungen' },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ target: { state: string } }>().target.state).toBe('reviewed');

    // The marker is gone from the file, not merely from memory.
    const state = JSON.parse(await readFile(join(root, '.lexi', 'state.json'), 'utf8')) as {
      groups: Record<string, unknown>;
    };
    expect(state.groups).toEqual({});
  });

  it('ignores a marker whose bytes no longer match what the model wrote', async () => {
    model = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    await configure(model.origin);
    await translate({ rowId: INVOICES, locale: 'de' });
    await app.inject({ method: 'POST', url: '/api/save', headers: goodHeaders(), payload: {} });

    // Somebody edits the file outside Lexi — an editor, a merge, a teammate.
    const edited = (await readFile(join(root, 'messages.de.xlf'), 'utf8')).replace(
      'Rechnungen',
      'Rechnungen insgesamt',
    );
    await writeFile(join(root, 'messages.de.xlf'), edited, 'utf8');

    await app.close();
    app = await buildApp(testConfig({ roots: [root], stateDir }), {
      logger: false,
      projects: new ProjectService(),
    });
    await open();

    const q = await app.inject({
      method: 'POST',
      url: '/api/units/query',
      headers: goodHeaders(),
      payload: { locales: ['de'], filters: ['machineDrafts'] },
    });
    expect(q.json<UnitsQueryResponse>().ids).toEqual([]);
  });

  /* -- FR-1.9, the other half: a locale with no file -- */

  it('starts a locale from the source file, and then drafts into it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/locales/file',
      headers: goodHeaders(),
      payload: { group: 'messages', locale: 'pl' },
    });
    expect(created.statusCode, created.payload).toBe(200);
    expect(created.json<{ created: string }>().created).toBe('messages.pl.xlf');

    // Copied from the source file and emptied: same prolog, same namespace,
    // same indentation, no units, and the new language.
    const text = await readFile(join(root, 'messages.pl.xlf'), 'utf8');
    expect(text).toContain('<?xml version="1.0" encoding="UTF-8" ?>');
    expect(text).toContain('xmlns="urn:oasis:names:tc:xliff:document:1.2"');
    expect(text).toContain('target-language="pl"');
    expect(text).not.toContain('<trans-unit');

    // And the locale is live: it can be drafted into immediately.
    model = await fakeModel(json('Masz [[0]] faktur'));
    await configure(model.origin);
    const res = await translate({ rowId: INVOICES, locale: 'pl' });
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json<TranslateUnitResponse>().ok).toBe(true);

    await app.inject({ method: 'POST', url: '/api/save', headers: goodHeaders(), payload: {} });
    expect(await readFile(join(root, 'messages.pl.xlf'), 'utf8')).toContain('Masz');
  });

  it('follows the naming convention the project already uses', async () => {
    // The siblings are `messages.<locale>.xlf`, so the new one is too — not
    // `pl/messages.xlf`, which the build would never look at.
    await app.inject({
      method: 'POST',
      url: '/api/locales/file',
      headers: goodHeaders(),
      payload: { group: 'messages', locale: 'nl' },
    });
    expect(await readFile(join(root, 'messages.nl.xlf'), 'utf8')).toContain('target-language="nl"');
  });

  it('refuses to start a locale that already has a file, or the source locale', async () => {
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/locales/file',
      headers: goodHeaders(),
      payload: { group: 'messages', locale: 'de' },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json<{ error: { message: string } }>().error.message).toContain('already has');

    const source = await app.inject({
      method: 'POST',
      url: '/api/locales/file',
      headers: goodHeaders(),
      payload: { group: 'messages', locale: 'en-GB' },
    });
    expect(source.statusCode).toBe(400);
  });

  /* -- FR-6.15 -- */

  /**
   * The flow that sent this back as a bug report: a string that is not in the
   * locale's file yet is exactly the string worth drafting, and refusing made
   * the feature useless for the case it exists for.
   */
  it('drafts into a locale whose file does not have the unit yet', async () => {
    model = await fakeModel(json('Vous avez [[0]] factures'));
    await configure(model.origin);

    const res = await translate({ rowId: INVOICES, locale: 'fr' });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<TranslateUnitResponse>();
    expect(body.ok).toBe(true);
    expect(body.target?.state).toBe('draftMachine');
    expect(body.target?.missing).toBe(false);

    // Still nothing on disk until the user saves, like every other draft.
    expect(await readFile(join(root, 'messages.fr.xlf'), 'utf8')).toBe(frXlf);

    await app.inject({ method: 'POST', url: '/api/save', headers: goodHeaders(), payload: {} });
    const after = await readFile(join(root, 'messages.fr.xlf'), 'utf8');
    expect(after).toContain('<trans-unit id="invoices"');
    expect(after).toContain(`<target>Vous avez ${INTERP} factures</target>`);
  });

  it('refuses, and says what would fix it, when the locale has no file at all', async () => {
    model = await fakeModel(json('cokolwiek'));
    await configure(model.origin);

    const res = await translate({ rowId: INVOICES, locale: 'pl' });
    expect(res.statusCode).toBe(400);
    const error = res.json<{ error: { message: string; details?: { reason?: string } } }>().error;
    expect(error.message).toContain('no pl file');
    expect(error.details?.reason).toBe('no-locale-file');
    // And it did not spend a local GPU's time finding that out.
    expect(model.prompts).toHaveLength(0);
  });

  it('reports an unreachable endpoint as a message, not as a rejected draft', async () => {
    const dead = await fakeModel(json('x'));
    const origin = dead.origin;
    await dead.close();
    await configure(origin);

    const res = await translate({ rowId: INVOICES, locale: 'de' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('Could not reach');
  });

  it('refuses to be redirected off the configured endpoint, prompt and all', async () => {
    const elsewhere = await fakeModel(json('Sie haben [[0]] Rechnungen'));
    const redirector: Server = createServer((_req, res) => {
      res.writeHead(302, { location: `${elsewhere.origin}/v1/chat/completions` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const address = redirector.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      await configure(`http://127.0.0.1:${port}`);
      const res = await translate({ rowId: INVOICES, locale: 'de' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { message: string } }>().error.message).toContain('redirected');
      // The assertion that actually proves FR-6.15: the second server never saw
      // the prompt.
      expect(elsewhere.prompts).toHaveLength(0);
    } finally {
      redirector.closeAllConnections();
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
      await elsewhere.close();
    }
  });
});
