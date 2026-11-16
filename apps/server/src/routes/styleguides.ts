// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import {
  estimateTokens,
  GLOBAL_GUIDE_KEY,
  MarkdownPreviewRequestSchema,
  StyleGuideSaveRequestSchema,
  type MarkdownPreviewResponse,
  type StyleGuide,
  type StyleGuideListResponse,
} from '@lexi/shared';

import { notFound } from '../lib/http-error.js';
import { LEXI_DIR } from '../lib/lexi-dir.js';
import { readSharedSources, sourceState } from '../lib/shared-sources.js';
import {
  deleteStyleGuide,
  guideKeyToName,
  listStyleGuides,
  readStyleGuide,
  styleGuideExists,
  STYLEGUIDE_DIR,
  writeStyleGuide,
} from '../lib/styleguides.js';
import { parseMarkdown } from '../services/markdown.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';
import type { SharedSourceWatcher } from '../services/shared-source-watcher.js';

/**
 * S6 — style guides (M10, FR-5.1 through FR-5.5).
 *
 * The read half has existed since M9, because the composed prompt needed it
 * before any screen could write one. This is the other half, plus the renderer
 * behind the live preview.
 *
 * Two things here are not the house pattern, and both are deliberate:
 *
 * 1. **`:key` is validated, not cast.** Every other route parameter in this
 *    codebase is a plain cast (`req.params as {...}`), which is fine when the
 *    worst case is a lookup that misses. This one becomes a FILENAME, so it
 *    goes through `guideKeyToName`'s allowlist first.
 * 2. **The preview lives at `/api/markdown/preview`, not under this prefix.**
 *    It renders the editor's UNSAVED buffer, so it takes text rather than a
 *    key — and keeping it out of this prefix means it can never be confused
 *    with a guide called "preview".
 */
export function registerStyleguides(
  app: FastifyInstance,
  cfg: ServerConfig,
  projects: ProjectService,
  watcher?: SharedSourceWatcher,
): void {
  /** The house idiom from `units.ts`: one closure, one sentence, one place. */
  const open = () => {
    const project = projects.current;
    if (!project) throw notFound('no project is open');
    return project;
  };

  const keyOf = (req: { params: unknown }): string => {
    const { key } = req.params as { key: string };
    guideKeyToName(key); // throws `badRequest` for anything not on the allowlist
    return key;
  };

  const dtoOf = async (projectPath: string, key: string): Promise<StyleGuide> => {
    const name = guideKeyToName(key);
    const guide = await readStyleGuide(projectPath, name);
    return {
      key,
      name,
      locale: key === GLOBAL_GUIDE_KEY ? null : key,
      text: guide?.text ?? '',
      tokens: estimateTokens(guide?.text ?? ''),
      bytes: Buffer.byteLength(guide?.text ?? '', 'utf8'),
      // Not `guide !== null`: a file that exists but holds only whitespace
      // reads as no guide, and the editor must still not offer to overwrite it
      // with a template the user has already dismissed once.
      exists: await styleGuideExists(projectPath, key),
    };
  };

  app.get('/api/styleguides', async (): Promise<StyleGuideListResponse> => {
    const project = open();
    const guides = await listStyleGuides(project.path);
    const written = new Set(guides.map((g) => g.key));

    // The locales a guide could still be written FOR. The source locale is not
    // among them: nothing is ever translated into it, so a style guide for it
    // would steer no prompt (the dashboard's per-locale list leaves it out for
    // the same reason).
    const missing = (projects.index?.locales ?? [])
      .filter((locale) => locale !== project.sourceLocale && !written.has(locale))
      .sort();

    // Project-relative for `.lexi/styleguides`; absolute for a linked folder,
    // which is outside the project by design.
    const { styleguides } = await readSharedSources(project.path);
    return {
      guides,
      missing,
      dir: styleguides ?? `${LEXI_DIR}/${STYLEGUIDE_DIR}`,
      linked: styleguides !== null,
      available: (await sourceState(styleguides)).available,
    };
  });

  app.get('/api/styleguides/:key', async (req): Promise<StyleGuide> => {
    const project = open();
    return dtoOf(project.path, keyOf(req));
  });

  app.put('/api/styleguides/:key', async (req): Promise<StyleGuide> => {
    const project = open();
    const key = keyOf(req);
    const body = StyleGuideSaveRequestSchema.parse(req.body ?? {});
    await writeStyleGuide(cfg, project.path, key, body.text);
    await watcher?.remember();
    return dtoOf(project.path, key);
  });

  app.delete('/api/styleguides/:key', async (req): Promise<StyleGuide> => {
    const project = open();
    const key = keyOf(req);
    await deleteStyleGuide(cfg, project.path, key);
    await watcher?.remember();
    return dtoOf(project.path, key);
  });

  /**
   * The live preview (FR-5.4).
   *
   * No project guard: it renders text the client already has, touches no file
   * and reveals nothing. Guarding it would only mean the preview pane goes
   * blank in the one state where a user is most likely to be experimenting.
   */
  app.post('/api/markdown/preview', async (req): Promise<MarkdownPreviewResponse> => {
    const body = MarkdownPreviewRequestSchema.parse(req.body ?? {});
    return { blocks: parseMarkdown(body.text), tokens: estimateTokens(body.text) };
  });
}
