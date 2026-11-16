// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ProjectScanResponse, ScannedFile } from '@lexi/shared';

import { ProjectApi } from '../../core/api/project-api.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { WizardStore } from '../../core/stores/wizard-store.js';
import { LxBadge, LxButton, LxCombobox, LxRadioCard, LxRadioCardGroup } from '../../ui/index.js';
import { LxPhraseConnect } from '../phrase/phrase-connect.js';

/** One editable row of the mapping table. */
export interface MappingRow {
  readonly file: ScannedFile;
  locale: string;
  /** The amber "Fix to pt-BR" action, armed by the user (FR-1.2b). */
  fixTargetLanguage: boolean;
}

/**
 * S2 — the setup wizard (FR-1.3).
 *
 * Steps in one route, not one route each: the scan result is the state all
 * three share, and re-running it on a back-navigation would be slow and
 * surprising. The step indicator lives in the title bar, fed by `WizardStore`.
 *
 * The rule the screen exists to enforce: nothing about the mapping is
 * authoritative until the user confirms it. Detection is shown with its
 * reasoning ("Detected from filename"), disagreements are shown as
 * disagreements, and every locale cell is editable.
 */
@Component({
  selector: 'lx-setup-page',
  imports: [LxButton, LxBadge, LxCombobox, LxRadioCard, LxRadioCardGroup, LxPhraseConnect],
  templateUrl: './setup-page.html',
  styleUrl: './setup-page.css',
})
export class SetupPage {
  readonly #api = inject(ProjectApi);
  readonly #router = inject(Router);
  readonly #projects = inject(ProjectStore);
  protected readonly wizard = inject(WizardStore);

  protected readonly scan = signal<ProjectScanResponse | null>(null);
  protected readonly rows = signal<readonly MappingRow[]>([]);
  protected readonly sourceLocale = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly conflicts = computed(() =>
    this.rows().filter((r) => r.file.conflictingTargetLanguage !== null),
  );

  /** Every locale seen, plus whatever the user has typed. Feeds the combobox. */
  protected readonly localeOptions = computed(() => {
    const seen = new Set<string>();
    for (const row of this.rows()) if (row.locale !== '') seen.add(row.locale);
    for (const file of this.scan()?.files ?? []) if (file.locale) seen.add(file.locale);
    return [...seen].sort();
  });

  /** Source-locale candidates for step 3: the template's language leads. */
  protected readonly sourceCandidates = computed(() => {
    const files = this.scan()?.files ?? [];
    const template = files.find((f) => f.isTemplate);
    const candidates = new Set<string>();
    if (template?.sourceLanguage) candidates.add(template.sourceLanguage);
    for (const file of files) if (file.sourceLanguage) candidates.add(file.sourceLanguage);
    for (const row of this.rows()) if (row.locale !== '') candidates.add(row.locale);
    return [...candidates];
  });

  protected readonly mappedCount = computed(
    () => this.rows().filter((r) => r.locale !== '').length,
  );

  protected readonly canConfirm = computed(() => this.mappedCount() > 0 && !this.busy());

  constructor() {
    this.wizard.enter();
    void this.#load();
  }

  protected setLocale(row: MappingRow, locale: string): void {
    this.rows.update((rows) =>
      rows.map((r) => (r === row ? { ...r, locale, fixTargetLanguage: r.fixTargetLanguage } : r)),
    );
  }

  protected toggleFix(row: MappingRow): void {
    this.rows.update((rows) =>
      rows.map((r) => (r === row ? { ...r, fixTargetLanguage: !r.fixTargetLanguage } : r)),
    );
  }

  protected note(file: ScannedFile): string {
    if (file.isTemplate) return 'Extraction template — no targets. Proposed as source locale.';
    if (file.conflictingTargetLanguage !== null) return 'Stale attribute from a copied file';
    if (file.relPath.includes('/')) return 'Split by feature module — keyed by path';
    switch (file.localeSource) {
      case 'filename':
        return 'Detected from filename';
      case 'directory':
        return 'Detected from the parent folder';
      case 'attribute':
        return 'Detected from target-language';
      default:
        return 'No locale detected — set one to include this file';
    }
  }

  protected toStep(step: 0 | 1 | 2): void {
    this.wizard.go(step);
  }

  protected back(): void {
    if (this.wizard.step() === 2) this.wizard.go(1);
    else void this.#router.navigate(['/start']);
  }

  protected async confirm(): Promise<void> {
    const scan = this.scan();
    if (!scan) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const project = await this.#api.open({
        path: scan.root,
        sourceLocale: this.sourceLocale(),
        mapping: this.rows()
          .filter((r) => r.locale !== '')
          .map((r) => ({
            path: r.file.path,
            fileIndex: r.file.fileIndex,
            locale: r.locale,
            fixTargetLanguage: r.fixTargetLanguage,
          })),
      });
      this.#projects.set(project);
      // The Phrase step needs the project open — its calls are about the open
      // project — so it comes after opening, and only on a first open: a
      // re-map from the project menu has been through it before.
      if (scan.saved === null) this.wizard.go(3);
      else await this.finish();
    } catch {
      this.error.set('Could not open the project. The files may have changed on disk.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Leave the wizard for the dashboard — after the Phrase step, connected or skipped. */
  protected async finish(): Promise<void> {
    this.wizard.leave();
    await this.#router.navigate(['/dashboard']);
  }

  async #load(): Promise<void> {
    const path = new URLSearchParams(location.search).get('path');
    if (path === null) {
      await this.#router.navigate(['/start']);
      return;
    }

    try {
      const scan = await this.#api.scan(path);
      this.scan.set(scan);
      // A re-map from the project menu starts from what was confirmed last time.
      const saved = new Map(
        (scan.saved?.mapping ?? []).map((m) => [`${m.relPath}#${m.fileIndex}`, m.locale]),
      );
      this.rows.set(
        scan.files.map((file) => ({
          file,
          locale: saved.get(`${file.relPath}#${file.fileIndex}`) ?? file.locale ?? '',
          // Armed by default when there IS a conflict: the stale attribute is
          // almost always a mistake, and the user can still untick it.
          fixTargetLanguage: file.conflictingTargetLanguage !== null,
        })),
      );
      this.sourceLocale.set(scan.saved?.sourceLocale ?? scan.suggestedSourceLocale ?? '');
      this.wizard.go(1);
    } catch {
      this.error.set('Could not scan that folder.');
    }
  }
}
