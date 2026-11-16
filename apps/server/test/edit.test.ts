// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  rowIdOf,
  type EditSegmentDto,
  type Project,
  type SaveResponse,
  type TargetPatchResponse,
  type UnitCreateResponse,
  type UnitDeleteResponse,
  type UnitDetail,
} from '@lexi/shared';

import { buildApp } from '../src/app.js';
import { ProjectService } from '../src/services/project-service.js';
import { goodHeaders, testConfig } from './helpers.js';

/**
 * M6's write path: PATCH a target, copy the source, discard a draft, save.
 *
 * The assertions that matter are about BYTES, not about JSON. NFR-8 says a
 * one-word change produces a one-line diff, and NFR-5 says a file nobody edited
 * is never rewritten — those are the two promises the whole splice design exists
 * to keep, and this is the first milestone that can break them.
 *
 * The fixture is shaped around the cases that are easy to get wrong: a unit with
 * a placeholder, one with no `<target>` at all, one with a SELF-CLOSED target
 * carrying a state, an orphan, and a second file group reusing a unit id.
 */

const INTERP = '<x id="INTERPOLATION" equiv-text="{{ count }}"/>';

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

let root: string;
let stateDir: string;
let app: FastifyInstance;
let projects: ProjectService;

const DE = join('messages.de.xlf');

const sourceXlf = xlf(
  'en-GB',
  [
    unit('pay', 'Pay now'),
    unit('invoices', `You have ${INTERP} invoices`),
    unit('untouched', 'Leave me alone'),
    unit('fresh', 'Newly added string'),
  ].join('\n'),
);

/** `fresh` has NO target; `stateful` carries a self-closed one; `ghost` is an orphan. */
const deXlf = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="de">
    <body>
${unit('pay', 'Pay now', 'Jetzt bezahlen')}
${unit('invoices', `You have ${INTERP} invoices`, `Sie haben ${INTERP} Rechnungen`)}
${unit('untouched', 'Leave me alone', 'Lass mich in Ruhe')}
      <trans-unit id="fresh" datatype="html">
        <source>Newly added string</source>
      </trans-unit>
${unit('ghost', 'Removed string', 'Entfernte Zeichenkette')}
    </body>
  </file>
</xliff>
`;

/** A file that already uses `state`, so `writeState: auto` resolves to ON for it. */
const frXlf = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en-GB" datatype="plaintext" original="ng2.template" target-language="fr">
    <body>
      <trans-unit id="pay" datatype="html">
        <source>Pay now</source>
        <target state="translated">Payer maintenant</target>
      </trans-unit>
      <trans-unit id="fresh" datatype="html">
        <source>Newly added string</source>
        <target state="new"/>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

/**
 * A SECOND file group, in the shape a real project turned up in: every
 * `<source>` and `<target>` carries `xml:lang`, which Angular never writes.
 * `privacy` exists in German with a stale `xml:lang`; `accessibility` does not
 * exist there at all, so writing it goes down the unit-creation path (FR-1.9).
 */
const legalSourceXlf = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">
  <file original="ng2.template" datatype="plaintext" source-language="en-GB" target-language="en-GB">
    <body>
      <trans-unit id="privacy">
        <source xml:lang="en-GB">Additional Privacy Information</source>
        <target xml:lang="en-GB">Additional Privacy Information</target>
        <note>Links to some extra privacy notices</note>
      </trans-unit>
      <trans-unit id="accessibility">
        <source xml:lang="en-GB">Accessibility Statement.</source>
        <target xml:lang="en-GB">Accessibility Statement.</target>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

const legalDeXlf = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">
  <file original="ng2.template" datatype="plaintext" source-language="en-GB" target-language="de-DE">
    <body>
      <trans-unit id="privacy">
        <source xml:lang="en-GB">Additional Privacy Information</source>
        <target xml:lang="en-GB">Zus\u00e4tzliche Datenschutzhinweise</target>
        <note>Links to some extra privacy notices</note>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lexi-edit-')));
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
  // Rewritten every time: these tests mutate the fixture on purpose.
  await writeFile(join(root, 'messages.xlf'), sourceXlf, 'utf8');
  await writeFile(join(root, DE), deXlf, 'utf8');
  await writeFile(join(root, 'messages.fr.xlf'), frXlf, 'utf8');
  await writeFile(join(root, 'legal.xlf'), legalSourceXlf, 'utf8');
  await writeFile(join(root, 'legal.de-DE.xlf'), legalDeXlf, 'utf8');

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

const url = (unitId: string, locale: string, suffix = '', group = 'messages'): string =>
  `/api/units/${encodeURIComponent(rowIdOf(group, unitId))}/targets/${locale}${suffix}`;

const patch = (unitId: string, locale: string, segments: EditSegmentDto[], state?: string) =>
  app.inject({
    method: 'PATCH',
    url: url(unitId, locale),
    headers: goodHeaders(),
    payload: state === undefined ? { segments } : { segments, state },
  });

const save = (paths?: string[]) =>
  app.inject({
    method: 'POST',
    url: '/api/save',
    headers: goodHeaders(),
    payload: paths ? { paths } : {},
  });

const readDe = () => readFile(join(root, DE), 'utf8');

/** Lines that differ between two texts: (changed, added, removed). */
function diffCounts(
  before: string,
  after: string,
): { changed: number; added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  const common = new Set(a.filter((line) => b.includes(line)));
  const removed = a.filter((line) => !common.has(line)).length;
  const added = b.filter((line) => !common.has(line)).length;
  const changed = Math.min(added, removed);
  return { changed, added: added - changed, removed: removed - changed };
}

describe('PATCH a target', () => {
  it('shows the draft in the detail panel before anything is saved', async () => {
    const res = await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    expect(res.statusCode).toBe(200);
    const body = res.json<TargetPatchResponse>();
    expect(body.unsavedCount).toBe(1);
    expect(body.target.charCount).toBe('Sofort bezahlen'.length);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'pay'))}?locales=de`,
      headers: goodHeaders(),
    });
    const de = detail.json<UnitDetail>().targets.find((t) => t.locale === 'de');
    expect(de?.segments).toEqual([{ k: 't', v: 'Sofort bezahlen' }]);
  });

  it('leaves the file on disk untouched until save', async () => {
    const before = await readDe();
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    // The overlay is the whole point: pending edits never touch the documents,
    // which is what keeps `saveDocument`'s staleness check meaningful.
    expect(await readDe()).toBe(before);
  });

  it('re-attaches the original bytes of a placeholder the client only named', async () => {
    await patch('invoices', 'de', [
      { k: 't', v: 'Rechnungen: ' },
      { k: 'p', id: 'INTERPOLATION' },
    ]);
    await save();
    const after = await readDe();
    // Byte for byte, including attribute order and the equiv-text escaping.
    expect(after).toContain(`<target>Rechnungen: ${INTERP}</target>`);
  });

  it('refuses a placeholder the unit does not have, rather than inventing a tag', async () => {
    const res = await patch('pay', 'de', [{ k: 'p', id: 'INVENTED' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/INVENTED/);
  });

  it('rejects a segment carrying `clipped`, which is a truncated view and not content', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: url('pay', 'de'),
      headers: goodHeaders(),
      // The grid's own outbound shape. Accepting it back would splice a
      // 140-character prefix over somebody's full translation.
      payload: { segments: [{ k: 't', v: 'Jetzt', clipped: true }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a dropped placeholder as a validation error without refusing the edit', async () => {
    const res = await patch('invoices', 'de', [{ k: 't', v: 'Sie haben Rechnungen' }]);
    expect(res.statusCode).toBe(200);
    const target = res.json<TargetPatchResponse>().target;
    expect(target.findings.some((f) => f.rule === 'placeholder.mismatch')).toBe(true);
    expect(target.missingPlaceholders).toEqual(['INTERPOLATION']);
  });

  /**
   * FR-1.9. Until M9 this was a refusal — and it is exactly the string the
   * drafting feature exists to write: without `ng-extract-i18n-merge` a new
   * English string lands only in `messages.xlf`, so "translate this into
   * French" routinely means "put it into the French file first".
   *
   * The file stays untouched until save, like every other edit.
   */
  it('creates the unit in a locale file that does not have it yet', async () => {
    const before = await readFile(join(root, 'messages.fr.xlf'), 'utf8');

    const res = await app.inject({
      method: 'PATCH',
      url: url('invoices', 'fr'),
      headers: goodHeaders(),
      payload: {
        segments: [
          { k: 't', v: 'Vous avez ' },
          { k: 'p', id: 'INTERPOLATION' },
          { k: 't', v: ' factures' },
        ],
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const target = res.json<TargetPatchResponse>().target;
    // Not "missing" any more: it is about to exist, and the panel shows the text.
    expect(target.missing).toBe(false);
    expect(target.state).toBe('reviewed');
    expect(await readFile(join(root, 'messages.fr.xlf'), 'utf8')).toBe(before);

    await save();
    const after = await readFile(join(root, 'messages.fr.xlf'), 'utf8');
    expect(after).toContain('<trans-unit id="invoices"');
    // `state` because THIS file already uses it — `writeState: 'auto'` follows
    // the file it is writing into, not a global preference.
    expect(after).toContain(`<target state="translated">Vous avez ${INTERP} factures</target>`);
    // Indented like its new neighbours, not like the file it was copied from.
    expect(after).toContain('      <trans-unit id="invoices" datatype="html">\n        <source>');
    // The placeholder came out of the SOURCE file's bytes, so its equiv-text
    // survives a trip that never had them in the target file to copy.
    expect(after).toContain('equiv-text="{{ count }}"');
    // An addition and nothing else: every line that was there still is.
    for (const line of before.split('\n')) expect(after).toContain(line);
  });

  it('keeps a created unit in source order rather than in click order', async () => {
    // `untouched` comes AFTER `pay` in the source file; `pay` is the only unit
    // the French file has, so the new one must follow it.
    const res = await app.inject({
      method: 'PATCH',
      url: url('untouched', 'fr'),
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: 'Laissez-moi' }] },
    });
    expect(res.statusCode, res.payload).toBe(200);
    await save();

    const ids = [
      ...(await readFile(join(root, 'messages.fr.xlf'), 'utf8')).matchAll(
        /<trans-unit id="([^"]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(ids).toEqual(['pay', 'untouched', 'fresh']);
  });

  it('inserts two adjacent new units without the two insertions colliding', async () => {
    // Both anchor on the same existing unit, because neither is in the file yet
    // to anchor the other. Emitted as two zero-width edits at one offset,
    // `applyEdits` would refuse them — their order would decide the output.
    for (const [id, text] of [
      ['invoices', 'Vous avez des factures'],
      ['untouched', 'Laissez-moi'],
    ] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: url(id, 'fr'),
        headers: goodHeaders(),
        payload: { segments: [{ k: 't', v: text }] },
      });
      expect(res.statusCode, res.payload).toBe(200);
    }
    const saved = (await save()).json<SaveResponse>();
    expect(saved.written).toHaveLength(1);

    const after = await readFile(join(root, 'messages.fr.xlf'), 'utf8');
    const ids = [...after.matchAll(/<trans-unit id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['pay', 'invoices', 'untouched', 'fresh']);
    expect(after).toContain('Vous avez des factures');
    expect(after).toContain('Laissez-moi');
  });

  it('copies the source into a locale that does not have the unit yet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${url('invoices', 'fr')}/copy-source`,
      headers: goodHeaders(),
    });
    expect(res.statusCode, res.payload).toBe(200);
    await save();
    const after = await readFile(join(root, 'messages.fr.xlf'), 'utf8');
    expect(after).toContain(`>You have ${INTERP} invoices</target>`);
  });

  it('can edit an orphan, because a trans-unit carries its own source', async () => {
    const res = await patch('ghost', 'de', [{ k: 't', v: 'Immer noch da' }]);
    expect(res.statusCode).toBe(200);
    await save();
    expect(await readDe()).toContain('<target>Immer noch da</target>');
  });

  it('keeps two file groups that share a unit id apart', async () => {
    await mkdir(join(root, 'checkout'), { recursive: true });
    await writeFile(
      join(root, 'checkout', 'messages.xlf'),
      xlf('en-GB', unit('pay', 'Checkout: pay')),
      'utf8',
    );
    await writeFile(
      join(root, 'checkout', 'messages.de.xlf'),
      xlf('de', unit('pay', 'Checkout: pay', 'Kasse: bezahlen')),
      'utf8',
    );
    await open();

    await patch('pay', 'de', [{ k: 't', v: 'Nur im Hauptpaket' }]);
    await save();

    expect(await readDe()).toContain('Nur im Hauptpaket');
    expect(await readFile(join(root, 'checkout', 'messages.de.xlf'), 'utf8')).toContain(
      'Kasse: bezahlen',
    );
    await rm(join(root, 'checkout'), { recursive: true, force: true });
  });
});

describe('copy source to target (FR-3.12)', () => {
  it('copies the source, placeholders and all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: url('invoices', 'de', '/copy-source'),
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(200);
    await save();
    expect(await readDe()).toContain(`<target>You have ${INTERP} invoices</target>`);
  });
});

describe('discarding a draft', () => {
  it('puts the cell back to what is in the file', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Etwas anderes' }]);
    const res = await app.inject({
      method: 'DELETE',
      url: url('pay', 'de', '/draft'),
      headers: goodHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<TargetPatchResponse>();
    expect(body.unsavedCount).toBe(0);
    expect(body.target.segments).toEqual([{ k: 't', v: 'Jetzt bezahlen' }]);
  });
});

describe('POST /api/save', () => {
  it('turns a one-word change into a one-line diff (NFR-8)', async () => {
    const before = await readDe();
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    const res = await save();

    expect(res.statusCode).toBe(200);
    expect(res.json<SaveResponse>().written).toEqual([join(root, DE)]);

    const diff = diffCounts(before, await readDe());
    expect(diff).toEqual({ changed: 1, added: 0, removed: 0 });
  });

  it('never rewrites a file with no pending edits (FR-1.6)', async () => {
    const path = join(root, 'messages.fr.xlf');
    const before = await stat(path);
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    await save();
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('skips rather than rewrites when an edit composes back to the existing text', async () => {
    const before = await readDe();
    // Typed a character and deleted it again. That must not produce a commit.
    await patch('pay', 'de', [{ k: 't', v: 'Jetzt bezahlen' }]);
    const res = await save();

    expect(res.json<SaveResponse>()).toMatchObject({ written: [], skipped: [join(root, DE)] });
    expect(await readDe()).toBe(before);
  });

  it('leaves every other unit in the file byte-identical', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    await save();
    const after = await readDe();
    expect(after).toContain('<target>Lass mich in Ruhe</target>');
    expect(after).toContain(`<target>Sie haben ${INTERP} Rechnungen</target>`);
  });

  it('creates a <target> that did not exist, in whole lines at the right indent', async () => {
    const before = await readDe();
    await patch('fresh', 'de', [{ k: 't', v: 'Neu hinzugefügt' }]);
    await save();
    const after = await readDe();

    expect(after).toContain(
      '        <source>Newly added string</source>\n        <target>Neu hinzugefügt</target>',
    );
    const diff = diffCounts(before, after);
    expect(diff).toEqual({ changed: 0, added: 1, removed: 0 });
  });

  it('clears the unsaved count and empties the draft buffer', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    const res = await save();
    expect(res.json<SaveResponse>().unsavedCount).toBe(0);
  });

  it('refuses to write over a file that changed on disk (409)', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    // Somebody ran `git pull` between opening and saving.
    await writeFile(join(root, DE), deXlf.replace('Jetzt bezahlen', 'Bezahlen'), 'utf8');

    const res = await save();
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('stale_file');
  });

  it('saves only the paths it was asked for', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    await patch('pay', 'fr', [{ k: 't', v: 'Payer tout de suite' }]);
    const res = await save([join(root, 'messages.fr.xlf')]);

    expect(res.json<SaveResponse>().written).toEqual([join(root, 'messages.fr.xlf')]);
    expect(await readDe()).toContain('Jetzt bezahlen');
  });
});

/**
 * The confirmed answer to requirements §13 Q4a: this project does NOT use
 * `ng-extract-i18n-merge`. `auto` therefore has to resolve to "never introduce a
 * state attribute" for files that have none — otherwise the first save sprays
 * `state="translated"` across every touched target and turns every one-word
 * change into two changed lines.
 */
describe('writeState', () => {
  it('writes no state into a file that has none (auto, the default)', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    await save();
    expect(await readDe()).not.toContain('state=');
  });

  it('writes state into a file that already uses it', async () => {
    await patch('pay', 'fr', [{ k: 't', v: 'Payer tout de suite' }]);
    await save();
    expect(await readFile(join(root, 'messages.fr.xlf'), 'utf8')).toContain(
      '<target state="translated">Payer tout de suite</target>',
    );
  });

  it('keeps the state of a self-closed <target state="new"/> when expanding it', async () => {
    await patch('fresh', 'fr', [{ k: 't', v: 'Nouvelle chaîne' }]);
    await save();
    const fr = await readFile(join(root, 'messages.fr.xlf'), 'utf8');
    expect(fr).toContain('<target state="translated">Nouvelle chaîne</target>');
  });

  it('honours writeState: never, and still does not delete a state somebody else wrote', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/project',
      headers: goodHeaders(),
      payload: { writeState: 'never' },
    });
    // `fresh` is `<target state="new"/>`. With `never` we must not UPDATE the
    // state to `translated` — but removing an attribute the user's own tooling
    // put there would be destroying their data, which is worse than leaving it
    // stale. `never` means "never write one", not "strip the ones that exist".
    await patch('fresh', 'fr', [{ k: 't', v: 'Nouvelle chaîne' }]);
    await save();
    const fr = await readFile(join(root, 'messages.fr.xlf'), 'utf8');
    expect(fr).toContain('<target state="new">Nouvelle chaîne</target>');
  });
});

describe('the draft buffer survives a restart (NFR-4)', () => {
  it('restores pending edits from .lexi/drafts.json', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);

    await app.close();
    projects = new ProjectService();
    app = await buildApp(testConfig({ roots: [root], stateDir }), { logger: false, projects });
    await open();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'pay'))}?locales=de`,
      headers: goodHeaders(),
    });
    const de = detail.json<UnitDetail>().targets.find((t) => t.locale === 'de');
    expect(de?.segments).toEqual([{ k: 't', v: 'Sofort bezahlen' }]);
  });

  it('is covered by .lexi/.gitignore, because it is one person’s scratch state', async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    expect(await readFile(join(root, '.lexi', '.gitignore'), 'utf8')).toContain('drafts.json');
  });
});

describe('the wire still carries no bytes of the file', () => {
  it('after an edit, just as before one', async () => {
    await patch('invoices', 'de', [
      { k: 'p', id: 'INTERPOLATION' },
      { k: 't', v: ' Rechnungen' },
    ]);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'invoices'))}?locales=de`,
      headers: goodHeaders(),
    });
    const serialised = detail.body;
    expect(serialised).not.toContain('"raw"');
    expect(serialised).not.toContain('"span"');
    expect(serialised).not.toContain('<x id=');
  });
});

/**
 * `xml:lang` on a written `<target>` (reported from use).
 *
 * The bug: a unit Lexi CREATED in a `de-DE` file inherited the source unit's
 * whole `<target …>` open tag, so a German translation declared itself English.
 * The same attribute survived, stale, on every target Lexi edited.
 *
 * The rule is "match the file's own convention": correct what is there, add one
 * only where the unit's own `<source>` has one, and never introduce the
 * attribute into a file that does not use it.
 */
describe('xml:lang on a target Lexi writes', () => {
  const legalPatch = (unitId: string, text: string) =>
    app.inject({
      method: 'PATCH',
      url: url(unitId, 'de-DE', '', 'legal'),
      headers: goodHeaders(),
      payload: { segments: [{ k: 't', v: text }] },
    });

  const readLegalDe = () => readFile(join(root, 'legal.de-DE.xlf'), 'utf8');

  it('corrects a stale xml:lang on the target it is editing', async () => {
    expect(await readLegalDe()).toContain('<target xml:lang="en-GB">');

    expect((await legalPatch('privacy', 'Test')).statusCode).toBe(200);
    expect((await save()).statusCode).toBe(200);

    const out = await readLegalDe();
    expect(out).toContain('<target xml:lang="de-DE">Test</target>');
    // The SOURCE keeps its own language: it really is the English text.
    expect(out).toContain('<source xml:lang="en-GB">Additional Privacy Information</source>');
  });

  it("gives a unit it CREATES the target locale, not the source file's", async () => {
    expect(
      (await legalPatch('accessibility', 'Erkl\u00e4rung zur Barrierefreiheit.')).statusCode,
    ).toBe(200);
    expect((await save()).statusCode).toBe(200);

    const out = await readLegalDe();
    expect(out).toContain('<target xml:lang="de-DE">Erkl\u00e4rung zur Barrierefreiheit.</target>');
    expect(out).toContain('<source xml:lang="en-GB">Accessibility Statement.</source>');
  });

  it('leaves a stale xml:lang alone on a unit it did not write to', async () => {
    // The other half of the same promise. Correcting the attribute is something
    // Lexi does to a target it is ALREADY rewriting; sweeping the file for
    // wrong ones would make a one-word translation edit touch every line, which
    // is the thing the splice writer exists to avoid (NFR-8).
    await legalPatch('accessibility', 'Erkl\u00e4rung zur Barrierefreiheit.');
    await save();
    expect(await readLegalDe()).toContain(
      '<target xml:lang="en-GB">Zus\u00e4tzliche Datenschutzhinweise</target>',
    );
  });

  it('still changes exactly one line when it corrects the attribute', async () => {
    // The attribute and the text are on the same line in this shape, so the
    // FR-1.6 promise is unaffected — worth pinning, because a fix that split
    // the open tag across a second edit would quietly double the diff.
    const before = await readLegalDe();
    await legalPatch('privacy', 'Test');
    await save();
    expect(diffCounts(before, await readLegalDe())).toEqual({ changed: 1, added: 0, removed: 0 });
  });

  it('introduces no xml:lang into a file that never had one', async () => {
    // Angular's own output, which is what most projects have. The fix must be
    // completely inert there.
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    await save();
    expect(await readDe()).not.toContain('xml:lang');
  });
});

describe('DELETE a unit', () => {
  const del = (unitId: string, group = 'messages') =>
    app.inject({
      method: 'DELETE',
      url: `/api/units/${encodeURIComponent(rowIdOf(group, unitId))}`,
      headers: goodHeaders(),
    });
  const readSource = () => readFile(join(root, 'messages.xlf'), 'utf8');
  const readFr = () => readFile(join(root, 'messages.fr.xlf'), 'utf8');

  it('removes the unit from the source and every locale file, and nothing else', async () => {
    const res = await del('pay');
    expect(res.statusCode).toBe(200);
    const body = res.json<UnitDeleteResponse>();
    expect(body.skipped).toEqual([]);
    expect([...body.written].sort()).toEqual(
      [join(root, 'messages.xlf'), join(root, DE), join(root, 'messages.fr.xlf')].sort(),
    );

    const source = await readSource();
    const de = await readDe();
    const fr = await readFr();
    for (const text of [source, de, fr]) expect(text).not.toContain('id="pay"');
    // Exactly the unit's own lines went: no blank line left behind, and every
    // other byte identical.
    expect(de).toBe(deXlf.replace(`${unit('pay', 'Pay now', 'Jetzt bezahlen')}\n`, ''));
    expect(source).toBe(sourceXlf.replace(`${unit('pay', 'Pay now')}\n`, ''));
    expect(fr).toBe(frXlf.replace(/ {6}<trans-unit id="pay"[\s\S]*?<\/trans-unit>\n/, ''));
  });

  it('drops the row from the grid', async () => {
    await del('pay');
    const res = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowIdOf('messages', 'pay'))}`,
      headers: goodHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("drops the row's own pending edits and keeps everybody else's", async () => {
    await patch('pay', 'de', [{ k: 't', v: 'Sofort bezahlen' }]);
    await patch('untouched', 'de', [{ k: 't', v: 'Lass mich bitte in Ruhe' }]);

    const body = (await del('pay')).json<UnitDeleteResponse>();
    expect(body.unsavedCount).toBe(1);

    // The surviving edit was re-attached to the rewritten file and still saves.
    const saved = (await save()).json<SaveResponse>();
    expect(saved.written).toEqual([join(root, DE)]);
    expect(await readDe()).toContain('<target>Lass mich bitte in Ruhe</target>');
  });

  it('deletes an orphan from the locale file it lives in', async () => {
    const res = await del('ghost');
    expect(res.statusCode).toBe(200);
    expect(res.json<UnitDeleteResponse>().written).toEqual([join(root, DE)]);
    expect(await readDe()).not.toContain('id="ghost"');
    expect(await readSource()).toBe(sourceXlf);
  });

  it('refuses a file that changed on disk and reports it as skipped', async () => {
    await writeFile(join(root, DE), `${deXlf}\n`, 'utf8');
    const body = (await del('pay')).json<UnitDeleteResponse>();
    expect(body.skipped).toEqual([join(root, DE)]);
    expect(await readDe()).toContain('id="pay"');
    expect(await readSource()).not.toContain('id="pay"');
  });

  it('404s an unknown row', async () => {
    expect((await del('nope')).statusCode).toBe(404);
  });
});

describe('POST a unit', () => {
  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/units', headers: goodHeaders(), payload });
  const readSource = () => readFile(join(root, 'messages.xlf'), 'utf8');

  it('adds the unit to the source file only, next to its neighbour by id', async () => {
    const res = await create({
      unitId: 'payment.hint',
      group: 'messages',
      source: 'Cards & cash',
      description: 'Below the pay button',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UnitCreateResponse>()).toEqual({
      rowId: rowIdOf('messages', 'payment.hint'),
      written: 'messages.xlf',
      unsavedCount: 0,
    });

    const added = [
      '      <trans-unit id="payment.hint" datatype="html">',
      '        <source>Cards &amp; cash</source>',
      '        <note priority="1" from="description">Below the pay button</note>',
      '      </trans-unit>',
    ].join('\n');
    // A pure addition right after `pay`, the greatest id before it.
    expect(await readSource()).toBe(
      sourceXlf.replace(`${unit('pay', 'Pay now')}\n`, `${unit('pay', 'Pay now')}\n${added}\n`),
    );
    expect(await readDe()).toBe(deXlf);
  });

  it('shows up in the grid, and a translation of it creates the unit in the locale file on save', async () => {
    const { rowId } = (
      await create({ unitId: 'payment.hint', group: 'messages', source: 'Cards' })
    ).json<UnitCreateResponse>();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/units/${encodeURIComponent(rowId)}`,
      headers: goodHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<UnitDetail>().unitId).toBe('payment.hint');

    expect((await patch('payment.hint', 'de', [{ k: 't', v: 'Karten' }])).statusCode).toBe(200);
    await save();
    expect(await readDe()).toContain(
      '<trans-unit id="payment.hint" datatype="html">\n        <source>Cards</source>\n        <target>Karten</target>',
    );
  });

  it('keeps pending edits on other rows attached', async () => {
    await patch('untouched', 'de', [{ k: 't', v: 'Lass mich bitte in Ruhe' }]);
    expect(
      (
        await create({ unitId: 'aaa', group: 'messages', source: 'First' })
      ).json<UnitCreateResponse>().unsavedCount,
    ).toBe(1);
    await save();
    expect(await readDe()).toContain('<target>Lass mich bitte in Ruhe</target>');
  });

  it('mirrors the source as a <target> in a source file that carries targets', async () => {
    expect(
      (await create({ unitId: 'imprint', group: 'legal', source: 'Imprint' })).statusCode,
    ).toBe(200);
    expect(await readFile(join(root, 'legal.xlf'), 'utf8')).toContain(
      '      <trans-unit id="imprint" datatype="html">\n        <source>Imprint</source>\n        <target>Imprint</target>\n      </trans-unit>',
    );
  });

  it('409s an id the group already has, and writes nothing', async () => {
    const res = await create({ unitId: 'pay', group: 'messages', source: 'Again' });
    expect(res.statusCode).toBe(409);
    expect(await readSource()).toBe(sourceXlf);
  });

  it('400s an invalid id, a missing group in a multi-group project, and an empty source', async () => {
    expect((await create({ unitId: 'has space', group: 'messages', source: 'X' })).statusCode).toBe(
      400,
    );
    expect((await create({ unitId: 'ok', source: 'X' })).statusCode).toBe(400);
    expect((await create({ unitId: 'ok', group: 'messages', source: '' })).statusCode).toBe(400);
    expect((await create({ unitId: 'ok', group: 'nope', source: 'X' })).statusCode).toBe(404);
    expect(await readSource()).toBe(sourceXlf);
  });

  it('refuses a source file that changed on disk', async () => {
    await writeFile(join(root, 'messages.xlf'), `${sourceXlf}\n`, 'utf8');
    const res = await create({ unitId: 'payment.hint', group: 'messages', source: 'X' });
    expect(res.statusCode).toBe(409);
    expect(await readSource()).toBe(`${sourceXlf}\n`);
  });
});
