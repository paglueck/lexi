// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  type Project,
  type PromptPreviewResponse,
  type Term,
  type TermBaseResponse,
  type TermImportResponse,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { exactTermMatch } from '../src/services/termbase.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * The Term Base (FR-5.8, formerly the glossary) and the matching that decides
 * what reaches the prompt (FR-5.9).
 *
 * The question this file is really about is the last describe block. Storing
 * terms is easy and nothing depends on it; what the milestone is for is that
 * the right subset of them lands in the system message a model is actually
 * sent — so the final test asks the model what it received rather than asking
 * the composer what it intended.
 */

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

const unit = (id: string, source: string, target?: string): string =>
  `      <trans-unit id="${id}" datatype="html">
        <source>${source}</source>${target === undefined ? '' : `\n        <target>${target}</target>`}
      </trans-unit>`;

const UNITS = [
  unit('basket', 'Your basket is empty'),
  unit('carton', 'Ships in a carton'),
  unit('pay', 'Pay now'),
].join('\n');

let root: string;
let stateDir: string;
let app: FastifyInstance;

const BASKET = rowIdOf('messages', 'basket');
const CARTON = rowIdOf('messages', 'carton');
const PAY = rowIdOf('messages', 'pay');

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-termbase-')));
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
  for (const name of await readdir(root)) {
    if (name.endsWith('.xlf')) await rm(join(root, name), { force: true });
  }
  await writeFile(join(root, 'messages.xlf'), xlf('en-GB', UNITS), 'utf8');
  await writeFile(join(root, 'messages.de.xlf'), xlf('de', UNITS), 'utf8');
  await writeFile(join(root, 'messages.fr.xlf'), xlf('fr', UNITS), 'utf8');

  app = await buildApp(testConfig({ roots: [root], stateDir }), {
    logger: false,
    projects: new ProjectService(),
  });
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
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Project>();
}

const add = async (term: Record<string, unknown>): Promise<Term> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/termbase',
    headers: goodHeaders(),
    payload: term,
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Term>();
};

const patch = async (id: string, body: Record<string, unknown>): Promise<Term> => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/termbase/${id}`,
    headers: goodHeaders(),
    payload: body,
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Term>();
};

const all = async (): Promise<TermBaseResponse> => {
  const res = await app.inject({ method: 'GET', url: '/api/termbase', headers: goodHeaders() });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<TermBaseResponse>();
};

const preview = async (rowId: string): Promise<PromptPreviewResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/prompt/preview',
    headers: goodHeaders(),
    payload: { rowId, locale: 'de' },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<PromptPreviewResponse>();
};

const termBaseFile = (): Promise<string> => readFile(join(root, '.lexi', 'termbase.csv'), 'utf8');

/* -- storage --------------------------------------------------------------- */

describe('terms are stored in a CSV the team can commit', () => {
  it('adds a term at the top, gives it an id and writes one column per locale', async () => {
    await add({ term: 'invoice' });
    const term = await add({ term: 'basket', translations: { de: 'Warenkorb' } });
    expect(term.id).toBeTruthy();
    expect(term.dnt).toBe(false);
    expect(term.note).toBe('');

    const lines = (await termBaseFile()).trim().split('\r\n');
    expect(lines[0]).toBe('id,term,note,dnt,de,fr');
    expect(lines[1]).toBe(`${term.id},basket,,no,Warenkorb,`);
    expect((await all()).terms.map((t) => t.term)).toEqual(['basket', 'invoice']);
  });

  it('accepts an untitled term, which "Add term" creates', async () => {
    const term = await add({});
    expect(term.term).toBe('');
    expect((await all()).terms).toHaveLength(1);
  });

  it('round-trips quotes, commas, newlines and RTL text', async () => {
    const term = await add({
      term: 'promo, code',
      note: 'He said "use it"\nat checkout',
      translations: { de: 'سلة' },
    });
    expect((await all()).terms).toEqual([term]);
  });

  it('patches only the fields it was given, and DNT keeps the stored translations', async () => {
    const term = await add({ term: 'basket', translations: { de: 'Warenkorb' }, note: 'checkout' });
    const patched = await patch(term.id, { dnt: true });
    expect(patched.dnt).toBe(true);
    expect(patched.note).toBe('checkout');
    expect(patched.translations.de).toBe('Warenkorb');
    expect((await all()).terms[0]?.translations.de).toBe('Warenkorb');
    expect((await patch(term.id, { dnt: false })).translations.de).toBe('Warenkorb');
  });

  it('deletes a term', async () => {
    const term = await add({ term: 'basket' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/termbase/${term.id}`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect((await all()).terms).toHaveLength(0);
  });

  it('404s on a term that is not there, rather than inventing one', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/termbase/nope',
      headers: goodHeaders(),
      payload: { dnt: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a payload carrying a field it does not recognise', async () => {
    for (const payload of [
      { term: 'basket', translation: 'Warenkorb' },
      { term: 'Pay', caseSensitive: true },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/termbase',
        headers: goodHeaders(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('migrates an old glossary.json once, dropping what a term no longer carries', async () => {
    await mkdir(join(root, '.lexi'), { recursive: true });
    await writeFile(
      join(root, '.lexi', 'glossary.json'),
      JSON.stringify({
        version: 1,
        terms: [
          {
            id: 'g1',
            term: 'basket',
            translations: { de: 'Warenkorb' },
            caseSensitive: true,
            dnt: false,
            note: 'n',
          },
          {
            id: 'g2',
            term: 'Northwind',
            translations: {},
            caseSensitive: false,
            dnt: true,
            note: '',
          },
        ],
      }),
      'utf8',
    );
    const listing = await all();
    expect(listing.path).toBe('.lexi/termbase.csv');
    expect(listing.terms).toEqual([
      { id: 'g1', term: 'basket', translations: { de: 'Warenkorb' }, dnt: false, note: 'n' },
      { id: 'g2', term: 'Northwind', translations: {}, dnt: true, note: '' },
    ]);
    expect(await termBaseFile()).toContain('g1,basket,n,no,Warenkorb');
  });
});

/* -- import ---------------------------------------------------------------- */

describe('CSV import', () => {
  const importRows = async (
    rows: unknown[],
    mode: 'overwrite' | 'keep',
    locales?: string[],
  ): Promise<TermImportResponse> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/termbase/import',
      headers: goodHeaders(),
      payload: { rows, mode, ...(locales === undefined ? {} : { locales }) },
    });
    expect(res.statusCode, res.payload).toBe(200);
    return res.json<TermImportResponse>();
  };
  const rows = [
    { term: 'invoice', note: '', dnt: false, translations: { de: 'Rechnung', es: 'Factura' } },
    { term: 'Basket', note: 'header', dnt: false, translations: { de: 'Korb' } },
  ];

  it('adds new terms on top and overwrites existing ones, ignoring non-project locales', async () => {
    await add({ term: 'basket', translations: { de: 'Warenkorb', fr: 'Panier' } });
    const result = await importRows(rows, 'overwrite');
    expect([result.added, result.updated, result.unchanged]).toEqual([1, 1, 0]);
    expect(result.terms.map((t) => [t.term, t.translations, t.note])).toEqual([
      ['invoice', { de: 'Rechnung' }, ''],
      ['basket', { de: 'Korb' }, 'header'],
    ]);
    expect((await all()).terms).toEqual(result.terms);
  });

  it('leaves a locale alone when the file had no column for it', async () => {
    await add({ term: 'basket', translations: { de: 'Warenkorb', fr: 'Panier' } });
    const result = await importRows(rows, 'overwrite', ['de']);
    expect(result.terms.find((t) => t.term === 'basket')?.translations).toEqual({
      de: 'Korb',
      fr: 'Panier',
    });
  });

  it('only adds in keep-existing mode', async () => {
    await add({ term: 'basket', translations: { de: 'Warenkorb' } });
    const result = await importRows(rows, 'keep');
    expect([result.added, result.updated, result.unchanged]).toEqual([1, 0, 1]);
    expect(result.terms[1]?.translations).toEqual({ de: 'Warenkorb' });
  });
});

/* -- matching (FR-5.9) ----------------------------------------------------- */

describe('only the terms that appear in the string are injected', () => {
  const terms = (p: PromptPreviewResponse): string[] => p.terminology.matched.map((t) => t.term);

  it('matches a term that appears and leaves out one that does not, however small the term base', async () => {
    await add({ term: 'basket', translations: { de: 'Warenkorb' } });
    await add({ term: 'invoice', translations: { de: 'Rechnung' } });

    const p = await preview(BASKET);
    expect(terms(p)).toEqual(['basket']);
    expect(p.terminology.total).toBe(2);
  });

  it('does NOT match a term inside a longer word', async () => {
    // "Ships in a carton" must not drag in the term "cart".
    await add({ term: 'cart', translations: { de: 'Wagen' } });
    expect(terms(await preview(CARTON))).toEqual([]);
  });

  it('matches case-sensitively', async () => {
    const term = await add({ term: 'Pay', translations: { de: 'Bezahlen' } });
    expect(terms(await preview(PAY))).toEqual(['Pay']);
    await patch(term.id, { term: 'pay' });
    expect(terms(await preview(PAY))).toEqual([]);
  });

  it('injects a do-not-translate term with no translation, and its note', async () => {
    await add({ term: 'basket', dnt: true, translations: { de: 'Warenkorb' }, note: 'brand' });
    const p = await preview(BASKET);
    expect(p.terminology.matched).toEqual([
      { term: 'basket', translation: '', dnt: true, note: 'brand' },
    ]);
  });

  it('injects a term without a translation for this locale as "keep as written"', async () => {
    await add({ term: 'basket', translations: { fr: 'panier' } });
    const p = await preview(BASKET);
    expect(p.terminology.matched).toEqual([
      { term: 'basket', translation: '', dnt: false, note: '' },
    ]);
    expect(p.blocks.find((b) => b.kind === 'terminology')?.content).toContain(
      '- "basket": keep as written (no de translation)',
    );
  });

  it('never matches an untitled term', async () => {
    await add({});
    expect(terms(await preview(BASKET))).toEqual([]);
  });

  it('sorts the longest term first, so the specific rule reads above the general one', async () => {
    await add({ term: 'basket', translations: { de: 'Warenkorb' } });
    await add({ term: 'basket is empty', translations: { de: 'Warenkorb ist leer' } });
    expect(terms(await preview(BASKET))).toEqual(['basket is empty', 'basket']);
  });
});

/* -- validation (FR-8.1) --------------------------------------------------- */

describe('the fallback rule is checked', () => {
  it('flags a target that translated a term with no translation for its locale', async () => {
    await add({ term: 'basket', translations: { fr: 'panier' } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/units/${encodeURIComponent(BASKET)}/targets/de`,
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Ihr Warenkorb ist leer' }] },
    });
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.payload).toContain('has no de translation in the term base');
  });
});

/* -- what the model is actually sent --------------------------------------- */

describe('the matched terms reach the model', () => {
  it('renders the terminology lines, with notes, into the system message', async () => {
    await add({ term: 'basket', translations: { de: 'Warenkorb' }, note: 'shop header' });
    await add({ term: 'Northwind', dnt: true, note: 'product name' });

    const p = await preview(BASKET);
    const block = p.blocks.find((b) => b.kind === 'terminology');
    expect(block?.empty).toBe(false);
    expect(block?.content).toContain('- "basket" → "Warenkorb" (shop header)');
    expect(block?.content).not.toContain('Northwind');
    expect(block?.caption).toBe('1 of 2 terms matched this string.');

    const model = await fakeModel(
      JSON.stringify({ translation: 'Ihr Warenkorb ist leer', confidence: 'high' }),
    );
    try {
      await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: goodHeaders(),
        payload: { baseUrl: `${model.origin}/v1`, model: 'qwen2.5:14b' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/translate/unit',
        headers: goodHeaders(),
        payload: { rowId: BASKET, locale: 'de' },
      });
      expect(res.statusCode, res.payload).toBe(200);

      // The invariant M9 established, now covering the term base: the block the
      // preview displayed is byte-for-byte inside what the model was sent.
      expect(model.prompts).toHaveLength(1);
      expect(model.prompts[0]?.system).toContain(block?.content ?? '<nothing>');
    } finally {
      await model.close();
    }
  });

  it('says so honestly when the term base is empty', async () => {
    const block = (await preview(BASKET)).blocks.find((b) => b.kind === 'terminology');
    expect(block?.empty).toBe(true);
    expect(block?.caption).toBe('No term base yet.');
  });
});

/* -- a stand-in for the local model ---------------------------------------- */

interface FakeModel {
  readonly origin: string;
  readonly prompts: Array<{ system: string; user: string }>;
  close(): Promise<void>;
}

async function fakeModel(...answers: string[]): Promise<FakeModel> {
  const prompts: Array<{ system: string; user: string }> = [];
  let next = 0;

  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      if ((req.url ?? '').endsWith('/chat/completions')) {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        prompts.push({
          system: parsed.messages.find((m) => m.role === 'system')?.content ?? '',
          user: parsed.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '',
        });
        const content = answers[Math.min(next, answers.length - 1)] ?? '';
        next += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
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

describe('exactTermMatch: a string that IS a term is answered by the Term Base', () => {
  const text = (v: string) => [{ k: 't' as const, v }];
  const term = (over: Partial<Term>): Term => ({
    id: 'x',
    term: 'MyCompany ID',
    note: '',
    dnt: false,
    translations: {},
    ...over,
  });

  it('answers with the locale translation', () => {
    const terms = [term({ translations: { de: 'MeineFirma-ID' } })];
    expect(exactTermMatch(terms, text('MyCompany ID'), 'de')).toEqual({
      term: 'MyCompany ID',
      translation: 'MeineFirma-ID',
    });
  });

  it('falls back from the region to the language', () => {
    const terms = [term({ translations: { de: 'MeineFirma-ID' } })];
    expect(exactTermMatch(terms, text('MyCompany ID'), 'de-CH')?.translation).toBe('MeineFirma-ID');
  });

  it('answers a DNT term with the term itself', () => {
    expect(exactTermMatch([term({ dnt: true })], text('MyCompany ID'), 'de')?.translation).toBe(
      'MyCompany ID',
    );
  });

  it("keeps the source's surrounding whitespace", () => {
    const terms = [term({ translations: { de: 'X' } })];
    expect(exactTermMatch(terms, text('  MyCompany ID\n'), 'de')?.translation).toBe('  X\n');
  });

  it('keeps the term as written for a locale it has no translation for', () => {
    const terms = [term({ translations: { fr: 'Y' } })];
    expect(exactTermMatch(terms, text('MyCompany ID'), 'de')?.translation).toBe('MyCompany ID');
    expect(exactTermMatch(terms, text('MyCompany ID'), 'fr')?.translation).toBe('Y');
  });

  it('is case-sensitive and needs the whole string', () => {
    const terms = [term({ translations: { de: 'X' } })];
    expect(exactTermMatch(terms, text('mycompany id'), 'de')).toBeNull();
    expect(exactTermMatch(terms, text('Your MyCompany ID'), 'de')).toBeNull();
  });

  it('does not answer a string with a placeholder in it', () => {
    const terms = [term({ translations: { de: 'X' } })];
    const segments = [
      { k: 't' as const, v: 'MyCompany ID' },
      { k: 'p' as const, id: 'INTERPOLATION', raw: '<x id="INTERPOLATION"/>', tag: 'x' },
    ];
    expect(exactTermMatch(terms, segments as never, 'de')).toBeNull();
  });
});
