// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The one automated gate M2 ships: dark/light token parity.
 *
 * A light theme rots in exactly one way — someone adds a token to the dark file
 * and forgets the light one. It looks fine, because they only ever test in
 * dark, and the missing variable resolves to nothing months later in front of
 * someone else. This test is cheap and catches precisely that.
 *
 * It also enforces the two-layer rule: components read semantic tokens,
 * semantic tokens read primitives, and nothing reaches past that.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Resolved from the working directory, not import.meta.url: the Angular test
// builder bundles specs and virtualises their module URLs to /src/....
const SRC = join(process.cwd(), 'src');
const STYLES = join(SRC, 'styles');

const read = (rel: string): string => readFileSync(join(STYLES, rel), 'utf8');

/** Custom-property DEFINITIONS (`--x:`), not references (`var(--x)`). */
function definitions(css: string): string[] {
  return [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
}

function references(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = [], exts: readonly string[] = ['.css']): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, exts);
    else if (exts.some((e) => p.endsWith(e)) && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/**
 * Custom properties a component sets at runtime (`--lx-grid-cols`, through
 * `style.setProperty` in grid-table.ts), so no stylesheet defines them. Listed rather
 * than inferred: a new one should be a decision someone can see.
 */
const RUNTIME_TOKENS = new Set(['--lx-grid-cols', '--lx-issues-cols', '--lx-issues-min']);

const dark = read('tokens/semantic.dark.css');
const light = read('tokens/semantic.light.css');
const primitives = read('tokens/primitives.css');

describe('semantic token parity', () => {
  const darkTokens = definitions(dark).filter((t) => t.startsWith('--lx-'));
  const lightTokens = definitions(light).filter((t) => t.startsWith('--lx-'));

  it('defines at least the full documented ramp set', () => {
    expect(darkTokens.length).toBeGreaterThan(60);
  });

  it('defines every dark token in light too', () => {
    expect([...darkTokens].sort()).toEqual([...lightTokens].sort());
  });

  it('defines no token twice within one theme', () => {
    expect(darkTokens.length).toBe(new Set(darkTokens).size);
    expect(lightTokens.length).toBe(new Set(lightTokens).size);
  });
});

describe('the kitchen sink swatch list', () => {
  it('covers exactly the tokens the themes define', async () => {
    const { SEMANTIC_TOKENS } = await import('../app/dev/kitchen-sink/ks-tokens.js');
    const themed = definitions(dark).filter((t) => t.startsWith('--lx-'));
    expect([...SEMANTIC_TOKENS].sort()).toEqual([...themed].sort());
  });
});

describe('the two-layer rule', () => {
  it('references no primitive that is not defined', () => {
    const defined = new Set(definitions(primitives));
    const used = [...references(dark), ...references(light)].filter((t) => t.startsWith('--p-'));
    expect([...new Set(used)].filter((t) => !defined.has(t))).toEqual([]);
  });

  it('defines no primitive that nothing uses', () => {
    const used = new Set([...references(dark), ...references(light)]);
    expect(definitions(primitives).filter((t) => !used.has(t))).toEqual([]);
  });

  it('reaches primitives only from the semantic layer', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.includes('/tokens/semantic.'))
      .filter((f) => !f.endsWith('primitives.css'))
      .filter((f) => references(readFileSync(f, 'utf8')).some((t) => t.startsWith('--p-')));
    expect(offenders).toEqual([]);
  });

  it('references no --lx- token that no theme defines', () => {
    const themed = new Set([
      ...definitions(dark),
      ...definitions(light),
      ...walk(join(STYLES, 'tokens')).flatMap((f) => definitions(readFileSync(f, 'utf8'))),
    ]);
    const missing = new Set<string>();
    // `.ts` too: most components keep their styles inline, and M13 found five
    // references there (`--lx-danger-text`, `--lx-border`, `--lx-text`,
    // `--lx-sp-9`) that had resolved to nothing since the day they were typed —
    // a colour that silently fell back to `currentColor` in both themes.
    for (const file of walk(SRC, [], ['.css', '.ts'])) {
      for (const ref of references(readFileSync(file, 'utf8'))) {
        if (ref.startsWith('--lx-') && !themed.has(ref) && !RUNTIME_TOKENS.has(ref)) {
          missing.add(`${file.slice(SRC.length + 1)}: ${ref}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
