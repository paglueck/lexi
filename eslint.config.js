// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import globals from 'globals';

/**
 * Three blocks: the Node half, the Angular half, and plain .mjs scripts.
 *
 * Type-checked since M13. `projectService` asks TypeScript's own project
 * service which tsconfig owns each file — the same lookup an editor does — so
 * the NodeNext/composite graph and the web half's solution-style tsconfig need
 * no hand-maintained `project` list.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.angular/**',
      '**/node_modules/**',
      'apps/server/public/**',
      'apps/web/src/styles/base/fonts.css',
      'design_*/**',
    ],
  },

  // ---- Node: the engine, the wire contract, the server ----------------------
  {
    files: ['packages/**/*.ts', 'apps/server/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Each package's vitest.config.ts sits outside its tsconfig's
          // `include` on purpose: it is not part of what gets built.
          allowDefaultProject: ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Off: a Fastify handler is `async` so that returning a value IS the
      // reply, whether or not it awaits anything (Fastify's own documented
      // style). Seventeen of this rule's first twenty-eight findings were that.
      '@typescript-eslint/require-await': 'off',
      // Off in both halves. Its autofix, run once in M13, deleted casts that
      // were the only thing typing an `any` (`res.json() as {…}`) and reported
      // needed `xs[i]!`s as redundant while the web tsconfig lacked
      // noUncheckedIndexedAccess. A rule whose fix removes type information is
      // not one to leave armed.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },

  // ---- Angular --------------------------------------------------------------
  {
    files: ['apps/web/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    processor: angular.processInlineTemplates,
    rules: {
      // In Angular 22 OnPush is the default, so this rule's meaning flipped: it
      // now forbids a component opting OUT to Eager. Same guarantee the plan
      // wanted, with no boilerplate to write.
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
      '@angular-eslint/use-component-view-encapsulation': 'error',
      '@angular-eslint/component-selector': [
        'error',
        { prefix: 'lx', style: 'kebab-case', type: ['element', 'attribute'] },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { prefix: 'lx', style: 'camelCase', type: 'attribute' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Off for the same reason as the Node half: an `async` fake or handler
      // that satisfies a Promise-returning signature without awaiting is fine.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // @lexi/xliff's barrel reaches node:crypto and node:fs/promises, so it can
      // never be bundled into the browser. Make that a lint error rather than a
      // build failure nobody can read.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@lexi/xliff',
              message:
                'Not browser-safe: its barrel reaches node:crypto and node:fs/promises. Use @lexi/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/button-has-type': 'error',
    },
  },

  // ---- plain scripts --------------------------------------------------------
  {
    files: ['**/*.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  /**
   * FR-6.15: the server never contacts any host but the configured LLM
   * endpoint. That is only a guarantee if there is exactly one place it can be
   * broken, so `fetch` is reachable from one module and lint says so — the
   * alternative is a promise defended by whoever reviews the next pull request.
   *
   * The one other module is the Phrase client: it contacts only the Phrase host
   * named by the project's `.phrase.yml` (default api.phrase.com), and only when
   * the user connects or pushes. Strings never go there implicitly.
   */
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: [
      'apps/server/src/services/llm-client.ts',
      'apps/server/src/services/phrase-client.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Every outbound request goes through llmFetch in services/llm-client.ts, which refuses any host but the configured endpoint (FR-6.15).',
        },
      ],
    },
  },

  // Same rationale as the web block, in the other direction.
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@lexi/xliff',
              message:
                'shared depends on zod and nothing else — it mirrors the engine vocabularies instead. See docs/architecture.md.',
            },
          ],
        },
      ],
    },
  },
);
