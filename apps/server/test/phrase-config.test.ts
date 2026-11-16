// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PhraseConfigError,
  patternToRegExp,
  phraseLocaleProblem,
  readPhraseConfig,
  resolvePhraseLocale,
  resolvePhraseToken,
  resolvePushSources,
  writePhraseConfig,
} from '../src/services/phrase-config.js';

/**
 * `.phrase.yml` read the way `phrase push` reads it: placeholders, wildcards,
 * per-source params, and the sentences for what cannot be resolved.
 */

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lexi-phrase-config-')));
  await mkdir(join(root, 'src', 'locale'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
  for (const f of ['messages.xlf', 'messages.de.xlf', 'messages.fr-FR.xlf']) {
    await writeFile(join(root, 'src', 'locale', f), '<xliff/>', 'utf8');
  }
  await writeFile(join(root, 'node_modules', 'x', 'messages.es.xlf'), '<xliff/>', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const config = (yaml: string) => writeFile(join(root, '.phrase.yml'), yaml, 'utf8');

describe('readPhraseConfig', () => {
  it('is null when the project has none', async () => {
    expect(await readPhraseConfig(root)).toBeNull();
  });

  it('reads project, token, host and sources', async () => {
    await config(`phrase:
  access_token: abc
  project_id: p1
  host: https://api.us.app.phrase.com/v2
  file_format: xlf
  push:
    sources:
      - file: ./src/locale/messages.<locale_name>.xlf
        params:
          update_translations: true
`);
    expect(await readPhraseConfig(root)).toMatchObject({
      file: '.phrase.yml',
      projectId: 'p1',
      accessToken: 'abc',
      host: 'https://api.us.app.phrase.com/v2',
      fileFormat: 'xlf',
      sources: [{ file: './src/locale/messages.<locale_name>.xlf' }],
    });
  });

  it('accepts .phrase.yaml as well', async () => {
    await writeFile(join(root, '.phrase.yaml'), 'phrase:\n  project_id: p2\n', 'utf8');
    expect((await readPhraseConfig(root))?.projectId).toBe('p2');
  });

  it('explains broken YAML instead of throwing a parser stack', async () => {
    await config('phrase:\n  push: [\n');
    await expect(readPhraseConfig(root)).rejects.toBeInstanceOf(PhraseConfigError);
  });

  it('explains a file that is not a Phrase config', async () => {
    await config('something: else\n');
    await expect(readPhraseConfig(root)).rejects.toThrow(/not a Phrase config/);
  });
});

describe('resolvePushSources', () => {
  it('expands <locale_name> into one upload per file, with the locale taken from the path', async () => {
    await config(`phrase:
  project_id: p1
  file_format: xlf
  push:
    sources:
      - file: ./src/locale/messages.<locale_name>.xlf
        params:
          update_translations: true
          tags: [web]
`);
    const { files, problems } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(problems).toEqual([]);
    expect(files).toEqual([
      {
        relPath: 'src/locale/messages.de.xlf',
        localeId: 'de',
        projectId: 'p1',
        params: { file_format: 'xlf', update_translations: true, tags: ['web'] },
      },
      {
        relPath: 'src/locale/messages.fr-FR.xlf',
        localeId: 'fr-FR',
        projectId: 'p1',
        params: { file_format: 'xlf', update_translations: true, tags: ['web'] },
      },
    ]);
  });

  it('takes the locale from params.locale_id for a fixed file, and lets the source override the project', async () => {
    await config(`phrase:
  project_id: p1
  push:
    sources:
      - file: src/locale/messages.xlf
        project_id: p9
        params:
          locale_id: en-GB
          file_format: xlf
`);
    const { files } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(files).toEqual([
      {
        relPath: 'src/locale/messages.xlf',
        localeId: 'en-GB',
        projectId: 'p9',
        params: { file_format: 'xlf' },
      },
    ]);
  });

  it('walks ** but never into node_modules', async () => {
    await config(`phrase:
  project_id: p1
  push:
    sources:
      - file: ./**/messages.<locale_name>.xlf
`);
    const { files } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(files.map((f) => f.relPath)).toEqual([
      'src/locale/messages.de.xlf',
      'src/locale/messages.fr-FR.xlf',
    ]);
  });

  it('reports a source whose locale cannot be known, and one that matches nothing', async () => {
    await config(`phrase:
  project_id: p1
  push:
    sources:
      - file: ./src/locale/messages.xlf
      - file: ./i18n/<locale_name>.json
`);
    const { files, problems } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(files).toEqual([]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/locale is unknown/);
    expect(problems[1]).toMatch(/matches no file/);
  });

  it('reports a missing project_id', async () => {
    await config(`phrase:
  push:
    sources:
      - file: ./src/locale/messages.<locale_name>.xlf
`);
    const { problems } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(problems[0]).toMatch(/No project_id/);
  });
});

describe('patternToRegExp', () => {
  it('matches one segment per placeholder and requires repeats to agree', () => {
    const re = patternToRegExp('<locale_name>/messages.<locale_name>.xlf');
    expect(re.exec('de/messages.de.xlf')?.groups).toEqual({ locale_name: 'de' });
    expect(re.test('de/messages.fr.xlf')).toBe(false);
    expect(re.test('a/b/messages.a.xlf')).toBe(false);
  });
});

describe('resolvePhraseToken', () => {
  const cfg = { accessToken: 'from-config', hostSet: false, host: 'x' } as Parameters<
    typeof resolvePhraseToken
  >[1];
  const saved = { token: 's', region: 'EU' as const };

  it('prefers a saved token, then the config, then PHRASE_ACCESS_TOKEN', () => {
    expect(resolvePhraseToken(saved, cfg, { PHRASE_ACCESS_TOKEN: 'e' })).toEqual({
      token: 's',
      source: 'settings',
      host: 'https://api.phrase.com/v2',
    });
    expect(resolvePhraseToken(null, cfg, { PHRASE_ACCESS_TOKEN: 'e' })).toMatchObject({
      token: 'from-config',
      source: 'config',
    });
    expect(resolvePhraseToken(null, null, { PHRASE_ACCESS_TOKEN: 'e' })).toMatchObject({
      token: 'e',
      source: 'env',
    });
    expect(resolvePhraseToken(null, null, {})).toBeNull();
  });

  it("takes the host from the token's data center unless the config sets one", () => {
    expect(resolvePhraseToken({ token: 's', region: 'US' }, null, {})?.host).toBe(
      'https://api.us.app.phrase.com/v2',
    );
    const withHost = { ...cfg, hostSet: true, host: 'https://phrase.example/v2' } as typeof cfg;
    expect(resolvePhraseToken({ token: 's', region: 'US' }, withHost, {})?.host).toBe(
      'https://phrase.example/v2',
    );
  });
});

describe('writePhraseConfig', () => {
  it('writes one explicit source per mapped file, without a token, and reads back', async () => {
    await writePhraseConfig(root, 'p1', [
      { relPath: 'src/locale/messages.de.xlf', locale: 'de' },
      { relPath: 'src/locale/messages.xlf', locale: 'en-GB' },
    ]);
    const text = await readFile(join(root, '.phrase.yml'), 'utf8');
    expect(text).not.toMatch(/^\s*access_token:/m);

    const { files, problems } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(problems).toEqual([]);
    expect(files.map((f) => [f.relPath, f.localeId])).toEqual([
      ['src/locale/messages.de.xlf', 'de'],
      ['src/locale/messages.xlf', 'en-GB'],
    ]);
    expect(files[0]?.params).toEqual({
      file_format: 'xlf',
      update_translations: true,
      format_options: {
        override_file_language: true,
        ignore_source_translations: true,
        ignore_target_translations: false,
      },
    });
  });

  it('writes a resolved Phrase locale as its id, named in a comment', async () => {
    await writeFile(join(root, 'messages.de.xlf'), '<xliff/>', 'utf8');
    await writePhraseConfig(root, 'p1', [
      {
        relPath: 'messages.de.xlf',
        locale: 'de',
        target: { id: 'dev-de', name: 'Developer-German', code: 'de' },
      },
    ]);
    expect(await readFile(join(root, '.phrase.yml'), 'utf8')).toContain(
      'locale_id: dev-de # Developer-German (de)',
    );
    const { files } = await resolvePushSources(root, (await readPhraseConfig(root))!);
    expect(files.map((f) => f.localeId)).toEqual(['dev-de']);
  });

  it('writes tags and host when a checkout asks for them', async () => {
    await writePhraseConfig(root, 'p1', [{ relPath: 'src/locale/messages.de.xlf', locale: 'de' }], {
      tags: 'checkout-v2',
      host: 'https://api.us.app.phrase.com/v2',
    });
    const read = (await readPhraseConfig(root))!;
    expect(read).toMatchObject({ host: 'https://api.us.app.phrase.com/v2', hostSet: true });
    const { files } = await resolvePushSources(root, read);
    expect(files.map((f) => [f.relPath, f.localeId, f.params['tags']])).toEqual([
      ['src/locale/messages.de.xlf', 'de', 'checkout-v2'],
    ]);
  });

  it('never overwrites an existing config', async () => {
    await config('phrase:\n  project_id: mine\n');
    await expect(
      writePhraseConfig(root, 'p1', [{ relPath: 'a.xlf', locale: 'de' }]),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, '.phrase.yml'), 'utf8')).toBe('phrase:\n  project_id: mine\n');
  });
});

describe('resolvePhraseLocale', () => {
  const locales = [
    { id: 'loc-dede', name: 'de-DE', code: 'de-DE' },
    { id: 'dev-de', name: 'Developer-German', code: 'de' },
    { id: 'loc-fr', name: 'fr', code: 'fr-FR' },
  ];

  it('takes an id outright, else the one locale with that code or name', () => {
    expect(resolvePhraseLocale('loc-dede', locales)).toEqual({ kind: 'ok', locale: locales[0] });
    expect(resolvePhraseLocale('de', locales)).toEqual({ kind: 'ok', locale: locales[1] });
    expect(resolvePhraseLocale('Developer-German', locales)).toEqual({
      kind: 'ok',
      locale: locales[1],
    });
    expect(resolvePhraseLocale('fr', locales)).toEqual({ kind: 'ok', locale: locales[2] });
  });

  it("refuses a value that is one locale's code and another's name", () => {
    const withStray = [...locales, { id: 'stray', name: 'de', code: 'de' }];
    const match = resolvePhraseLocale('de', withStray);
    expect(match).toMatchObject({ kind: 'ambiguous' });
    expect(phraseLocaleProblem('de', match)).toMatch(
      /^"de" matches 2 Phrase locales: Developer-German \(code de, id dev-de\), de \(code de, id stray\)/,
    );
  });

  it('says a locale is missing rather than guessing', () => {
    const match = resolvePhraseLocale('ja', locales);
    expect(match).toEqual({ kind: 'missing' });
    expect(phraseLocaleProblem('ja', match)).toMatch(/no locale "ja"/);
  });
});
