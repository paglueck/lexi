// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { ServerConfig } from './config.js';
import type { Updater } from './lib/updater.js';
import { registerErrors } from './plugins/errors.js';
import { registerSecurity } from './plugins/security.js';
import { registerStatic } from './plugins/static.js';
import { registerEvents } from './routes/events.js';
import { registerFs } from './routes/fs.js';
import { registerHealth } from './routes/health.js';
import { registerIssues } from './routes/issues.js';
import { registerJobs } from './routes/jobs.js';
import { registerCsvImport } from './routes/csv-import.js';
import { registerProjects } from './routes/projects.js';
import { registerPhrase, type PhraseRouteOptions } from './routes/phrase.js';
import { registerPhraseCheckout } from './routes/phrase-checkout.js';
import { registerPhraseTokens } from './routes/phrase-tokens.js';
import { registerPrompt } from './routes/prompt.js';
import { registerStyleguides } from './routes/styleguides.js';
import { registerTermBase } from './routes/termbase.js';
import { registerRecents } from './routes/recents.js';
import { registerSettings } from './routes/settings.js';
import { registerSharedSources } from './routes/shared-sources.js';
import { registerUnits } from './routes/units.js';
import { registerUpdate } from './routes/update.js';
import { registerEdit } from './routes/edit.js';
import { registerHistory } from './routes/history.js';
import { stopCopilot } from './services/copilot-client.js';
import { FileWatcher } from './services/file-watcher.js';
import { JobQueue } from './services/job-queue.js';
import { ProjectService } from './services/project-service.js';
import { SettingsService } from './services/settings-service.js';
import { SharedSourceWatcher } from './services/shared-source-watcher.js';

/**
 * Builds the app WITHOUT listening, so tests can drive it through
 * `app.inject()` — which is the right tool for the security matrix, because it
 * forges `Host`, `Origin` and `Sec-Fetch-Site` freely where curl cannot.
 *
 * The "plugins" are plain functions rather than `fastify-plugin` wrappers, so
 * hook ordering is the literal order of the calls below with no encapsulation
 * surprises. Security must stay first.
 */
export interface BuildAppOptions {
  /** Tests pass `false` to keep the matrix output readable. */
  readonly logger?: FastifyServerOptions['logger'] | undefined;
  /** Injected so a test can inspect or preload the open project. */
  readonly projects?: ProjectService | undefined;
  /** Likewise for the machine settings, which a test may want pre-filled. */
  readonly settings?: SettingsService | undefined;
  /**
   * Reopen the most recent project before the first request — only when the
   * launch menu is switched off in the settings. `startServer` sets it; tests
   * leave it off so a stray `~/.lexi` can never open anything.
   */
  readonly restoreLastProject?: boolean | undefined;
  /** A fake Phrase server for the tests; production talks to the real one. */
  readonly phrase?: PhraseRouteOptions | undefined;
  /** The desktop shell's updater; see `ServerOptions.updater`. */
  readonly updater?: Updater | undefined;
}

export async function buildApp(
  cfg: ServerConfig,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? (cfg.devMode ? { level: 'info' } : { level: 'warn' }),
    bodyLimit: 1_048_576,
    trustProxy: false,
    // An open SSE stream is never "idle", so Fastify 5's default close
    // behaviour would hang forever on Ctrl-C. See closeGracefully in main.ts.
    forceCloseConnections: true,
    // No `disableRequestLogging`: it is deprecated in Fastify 5.12, and
    // redundant anyway — per-request logs are `info`, which the production
    // `warn` level already suppresses.
  });

  // One per process. Passed by argument rather than decorated onto the
  // instance, matching how `cfg` already travels.
  const projects = opts.projects ?? new ProjectService();

  // Read once at boot. `~/.lexi/settings.json` is small, and a settings screen
  // that had to wait for a file read would flash its defaults first.
  const settings = opts.settings ?? new SettingsService();
  await settings.load(cfg);

  registerSecurity(app, cfg);
  registerErrors(app, cfg);
  registerHealth(app, cfg, projects, settings);
  registerFs(app, cfg);
  // The bus's return value used to be discarded, which meant nothing in the
  // server could publish anything. M6's save is the first thing that needs to.
  // It now has to be created before the routes, because M7's watcher publishes
  // into it and `registerProjects` is what starts the watcher.
  const bus = registerEvents(app, cfg);
  const watcher = new FileWatcher({
    projects,
    bus,
    onError: (error) => app.log.warn({ err: error }, 'file watcher stopped'),
  });
  // The shared style guide and Term Base folders, which live outside the project.
  const sharedWatcher = new SharedSourceWatcher({
    projects,
    bus,
    onError: (error) => app.log.warn({ err: error }, 'shared source watcher stopped'),
  });
  app.addHook('preClose', async () => {
    watcher.stop();
    sharedWatcher.stop();
  });
  // The Copilot runtime is a child process; it must not outlive the server.
  app.addHook('onClose', async () => {
    await stopCopilot();
  });

  const jobQueue = new JobQueue({ cfg, projects, settings, bus });
  // A job's record is written in the background; let the last one land.
  app.addHook('onClose', async () => {
    await jobQueue.settled();
  });

  const { reopenLast } = registerProjects(app, cfg, projects, watcher, jobQueue, sharedWatcher);
  registerUnits(app, projects);
  registerRecents(app, cfg);
  registerEdit(app, cfg, projects, bus);
  registerHistory(app, cfg, projects);
  registerSettings(app, settings);
  registerPrompt(app, cfg, projects, settings);
  registerStyleguides(app, cfg, projects, sharedWatcher);
  registerTermBase(app, cfg, projects);
  registerSharedSources(app, cfg, projects, bus, sharedWatcher);
  registerJobs(app, cfg, jobQueue, projects);
  registerCsvImport(app, cfg, projects, bus);
  registerIssues(app, cfg, projects);
  registerPhrase(app, cfg, projects, settings, bus, opts.phrase);
  registerPhraseTokens(app, settings, opts.phrase);
  registerPhraseCheckout(app, cfg, settings, bus, opts.phrase);
  registerUpdate(app, cfg, bus, opts.updater);
  // Last: it owns the 404 handler, which doubles as the SPA fallback.
  await registerStatic(app, cfg);

  await app.ready();

  // After `ready`, so the watcher and the job queue exist. A failure is logged
  // and swallowed: like the recents list itself, this is a convenience, and a
  // project that will not open must never stop the server from starting.
  // With the launch menu on (the default), the menu is where the user picks;
  // reopening behind its back would make Continue a lie about what is open.
  if (opts.restoreLastProject && !settings.showLaunchMenu) {
    try {
      await reopenLast();
    } catch (err) {
      app.log.warn({ err }, 'could not reopen the last project');
    }
  }

  return app;
}
