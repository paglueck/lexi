// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  Component,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  DEFAULT_SEVERITIES,
  LLM_PARAM_LIMITS,
  RULE_IDS,
  type SettingsSection,
} from '@lexi/shared/constants';
import type {
  EditorMode,
  LlmAdapter,
  LlmParams,
  LlmReasoningEffort,
  LlmProbeResult,
  RuleId,
  Severity,
  ThemeMode,
  WriteStateMode,
} from '@lexi/shared';

import { ProjectApi } from '../../core/api/project-api.js';
import { ProjectStore } from '../../core/stores/project-store.js';
import { RULE_TITLE } from '../../core/rule-titles.js';
import { SettingsStore } from '../../core/stores/settings-store.js';
import { ThemeStore } from '../../core/stores/theme-store.js';
import { UpdateStore } from '../../core/stores/update-store.js';
import {
  GLYPH,
  LxButton,
  LxCombobox,
  LxField,
  LxIcon,
  LxInput,
  LxModalService,
  LxNavRow,
  LxRadioCard,
  LxRadioCardGroup,
  LxSegmentedControl,
  LxToggle,
  type SegmentOption,
} from '../../ui/index.js';
import { LxPhraseTokens } from '../phrase/phrase-tokens.js';
import { openUpdateDialog } from '../update/update-dialog.js';

/**
 * S7 — settings and the local model (M8).
 *
 * The first screen with no read-only half: every field here changes how a later
 * request is made, which is why nothing on it is optimistic. A field is sent
 * when the user leaves it and the SERVER'S answer is what the screen then
 * shows, so "what is displayed" and "what a job will use" cannot drift apart.
 *
 * Three things about this screen are decisions rather than layout:
 *
 * - **"Test connection" probes what is stored, not what is typed.** Testing the
 *   form would let the callout go green for one endpoint while a different one
 *   is what every later request uses. The page patches, then tests.
 * - **The API key is write-only.** The server answers with `apiKeySet` and
 *   never with the key, so the field shows that one is stored rather than
 *   showing it. Typing replaces it; emptying it deletes it.
 * - **Two of the three toggles are machine settings and one is not.** "Write
 *   state attributes" belongs to the project — how a team writes `state` is a
 *   team decision that lands in `.lexi/project.json` — so it
 *   patches `/api/project` and is disabled while nothing is open. The screen
 *   says which is which rather than hiding the difference.
 */

/**
 * The `LlmParams` keys the number boxes drive.
 *
 * `param`/`saveParam` were written when every generation parameter was a
 * number, and said so only by returning one. `reasoningEffort` is a string, so
 * the assumption now has to be stated: the helpers take the numeric keys, and
 * the enum gets its own accessor rather than a `Number()` that could never have
 * meant anything for it.
 */
type NumericParam = {
  [K in keyof LlmParams]: LlmParams[K] extends number | null ? K : never;
}[keyof LlmParams];

interface NavItem {
  readonly id: SettingsSection;
  readonly label: string;
  /** Empty when the section is built. Otherwise what it is waiting for. */
  readonly pending: string;
}

const NAV: readonly NavItem[] = [
  { id: 'model', label: 'Model', pending: '' },
  { id: 'phrase', label: 'Phrase', pending: '' },
  { id: 'validation', label: 'Validation rules', pending: '' },
  {
    id: 'xliff',
    label: 'XLIFF output',
    pending:
      'Output formatting follows the file it came from: indentation, line endings and escaping are detected on read and reproduced on write. The one setting worth exposing — whether to write state attributes — is on the model pane, where the design puts it.',
  },
  { id: 'editor', label: 'Editor', pending: '' },
  { id: 'appearance', label: 'Appearance & language', pending: '' },
  { id: 'shortcuts', label: 'Shortcuts', pending: '' },
  // Desktop app only: the rail hides it where there is no updater (`navItems`).
  { id: 'updates', label: 'Updates', pending: '' },
  { id: 'about', label: 'About & license', pending: '' },
];

/** FR-7.2/FR-3.6's keyboard contract, laid out for the reference table (M13). */
const SHORTCUT_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly items: ReadonlyArray<{ key: string; text: string }>;
}> = [
  {
    title: 'Global',
    items: [
      { key: '⌘K', text: 'Open the command palette' },
      { key: '⌘,', text: 'Go to Settings' },
      { key: '⌘O', text: 'Open a project' },
      { key: '⌘⇧P', text: 'Check out from Phrase' },
    ],
  },
  {
    title: 'Launch menu',
    items: [{ key: '↵', text: 'Continue with the last project' }],
  },
  {
    title: 'Grid',
    items: [
      { key: '⌘↩', text: 'Save and move to the next filtered row' },
      { key: 'esc', text: 'Revert the current edit' },
      { key: '↑ / ↓', text: 'Move the selected row' },
      { key: 'PgUp / PgDn', text: 'Move the selection by 20 rows' },
    ],
  },
  {
    title: 'Review',
    items: [
      { key: 'A', text: 'Accept the draft as it stands' },
      { key: 'R', text: 'Reject — puts back what the draft replaced' },
      { key: 'E', text: 'Edit the draft in place' },
      { key: '⌘↩', text: 'Accept and move to the next open draft' },
      { key: '↑ / ↓', text: 'Previous / next open draft' },
    ],
  },
  {
    title: 'Segment editor',
    items: [
      { key: '⌘↩', text: 'Commit' },
      { key: 'esc', text: 'Cancel' },
    ],
  },
];

const THEMES: ReadonlyArray<{ mode: ThemeMode; label: string; hint: string }> = [
  { mode: 'dark', label: 'Dark', hint: 'The design’s primary theme.' },
  { mode: 'light', label: 'Light', hint: 'The same tokens, the light palette.' },
  { mode: 'system', label: 'Match the system', hint: 'Follows prefers-color-scheme.' },
];

const STEP_LABEL: Record<LlmProbeResult['step'], string> = {
  reachable: 'Endpoint',
  models: 'Model list',
  completion: 'Completion',
};

@Component({
  selector: 'lx-settings-page',
  imports: [
    LxPhraseTokens,
    LxButton,
    LxCombobox,
    LxField,
    LxIcon,
    LxInput,
    LxNavRow,
    LxRadioCard,
    LxRadioCardGroup,
    LxSegmentedControl,
    LxToggle,
  ],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
})
export class SettingsPage {
  readonly #projectApi = inject(ProjectApi);
  readonly #modal = inject(LxModalService);

  protected readonly store = inject(SettingsStore);
  protected readonly project = inject(ProjectStore);
  protected readonly theme = inject(ThemeStore);
  protected readonly update = inject(UpdateStore);

  /** NAV, less Updates where there is no updater (the CLI, the browser). */
  protected readonly navItems = computed(() =>
    this.update.supported() ? NAV : NAV.filter((n) => n.id !== 'updates'),
  );
  protected readonly updatePercent = computed(() => {
    const state = this.update.state();
    return state.phase === 'downloading' ? Math.round(state.percent) : 0;
  });
  protected readonly LIMITS = LLM_PARAM_LIMITS;
  protected readonly THEMES = THEMES;
  protected readonly GLYPH = GLYPH;
  protected readonly STEP_LABEL = STEP_LABEL;
  protected readonly SHORTCUT_GROUPS = SHORTCUT_GROUPS;
  protected readonly RULE_IDS = RULE_IDS;
  protected readonly RULE_TITLE = RULE_TITLE;
  protected readonly SEVERITY_OPTIONS: ReadonlyArray<SegmentOption<Severity>> = [
    { value: 'error', label: 'Error' },
    { value: 'warning', label: 'Warning' },
    { value: 'off', label: 'Off' },
  ];
  /**
   * Off first, and the default, because that is the right answer for this task
   * — see `DEFAULT_LLM_PARAMS`. "Server default" sits at the end as the escape
   * hatch for an endpoint that rejects the parameter outright.
   */
  protected readonly REASONING_OPTIONS: ReadonlyArray<SegmentOption<LlmReasoningEffort>> = [
    { value: 'none', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'server', label: 'Server default' },
  ];
  protected readonly EDITOR_MODE_OPTIONS: ReadonlyArray<{
    mode: EditorMode;
    label: string;
    hint: string;
  }> = [
    {
      mode: 'chips',
      label: 'Chip editor (default)',
      hint: 'Placeholders render as atomic, non-editable tokens.',
    },
    {
      mode: 'text',
      label: 'Plain text',
      hint: 'Placeholders show as [[0]]-style tokens you can type around. The fallback if chip editing misbehaves in your browser.',
    },
  ];

  protected readonly section = signal<SettingsSection>('model');
  /** Which nav entry is showing, as the pending copy or the empty string. */
  protected readonly pending = computed(
    () => NAV.find((n) => n.id === this.section())?.pending ?? '',
  );
  protected readonly sectionLabel = computed(
    () => NAV.find((n) => n.id === this.section())?.label ?? '',
  );

  /**
   * The text fields, as local drafts.
   *
   * `linkedSignal` rather than `signal`: they follow the stored value when it
   * changes underneath — the load that fills the screen, or a patch the server
   * normalised by trimming — while staying user-controlled in between. The same
   * pairing the grid's `selectedIndex` uses.
   */
  protected readonly baseUrl = linkedSignal(() => this.store.llm()?.baseUrl ?? '');
  protected readonly model = linkedSignal(() => this.store.llm()?.model ?? '');
  protected readonly apiKey = signal('');

  /**
   * GitHub Copilot: no base URL, the API key is an optional GitHub token, and
   * the SDK has no sampling controls — the fields say so rather than pretend.
   */
  protected readonly copilot = computed(() => this.store.llm()?.adapter === 'copilot');

  /** What the last probe found, so the model field can offer it (FR-6.3). */
  protected readonly models = computed<readonly string[]>(() => this.store.probe()?.models ?? []);

  protected readonly probeTone = computed<'ok' | 'bad' | null>(() => {
    const probe = this.store.probe();
    return probe === null ? null : probe.ok ? 'ok' : 'bad';
  });

  readonly #params = toSignal(inject(ActivatedRoute).queryParamMap, { initialValue: null });

  constructor() {
    void this.store.load();
    void this.project.refresh();
    void this.update.load();

    // `?section=validation`: S12's rule-list footer links straight to a pane.
    effect(() => {
      const wanted = this.#params()?.get('section');
      const item = this.navItems().find((n) => n.id === wanted);
      if (item !== undefined) untracked(() => this.section.set(item.id));
    });
  }

  /* -- updates ------------------------------------------------------------- */

  /** In place, with no dialog: the answer shows in the pane. */
  protected checkForUpdates(): void {
    void this.update.check();
  }

  /** The download and install run in the dialog, which holds the app until they are done. */
  protected updateNow(): void {
    openUpdateDialog(this.#modal, 'download');
  }

  /* -- the endpoint -------------------------------------------------------- */

  protected saveBaseUrl(): void {
    const value = this.baseUrl().trim();
    if (value === (this.store.llm()?.baseUrl ?? '')) return;
    void this.store.patch({ baseUrl: value });
  }

  protected saveModel(): void {
    const value = this.model().trim();
    if (value === (this.store.llm()?.model ?? '')) return;
    void this.store.patch({ model: value });
  }

  protected saveApiKey(): void {
    const value = this.apiKey();
    if (value === '') return;
    void this.store.patch({ apiKey: value }).then(() => this.apiKey.set(''));
  }

  protected clearApiKey(): void {
    this.apiKey.set('');
    void this.store.patch({ apiKey: '' });
  }

  protected selectAdapter(adapter: LlmAdapter): void {
    // The Ollama-native card is drawn because the design draws it and the
    // adapter seam is real, but nothing implements it. The server
    // refuses it too; refusing here as well keeps the screen from flashing a
    // selection it is about to lose.
    if (adapter === 'ollama') return;
    void this.store.patch({ adapter });
  }

  protected testConnection(): void {
    void this.store.test();
  }

  /* -- generation ---------------------------------------------------------- */

  protected param(key: NumericParam): number | null {
    return this.store.llm()?.params[key] ?? null;
  }

  /**
   * "Max tokens" and "Response timeout" are one setting pretending to be two.
   *
   * A budget that cannot be spent inside the deadline is not a ceiling, it is a
   * length of rope: nothing normally generates that much, but a model that
   * loops will, and the request is then cut off rather than finished. Twenty
   * tokens a second is a pessimistic local rate and deliberately so — the
   * sentence says it is an estimate, because this process has no way to know
   * what the machine at the other end actually does.
   */
  protected readonly budgetWarning = computed<string | null>(() => {
    const params = this.store.llm()?.params;
    // Copilot takes no token budget, so there is nothing to weigh the deadline against.
    if (params === undefined || this.copilot()) return null;
    const seconds = Math.round(params.maxTokens / 20);
    if (seconds <= params.requestTimeoutSeconds) return null;
    return (
      `At roughly 20 tokens a second — a large model on modest hardware — ${params.maxTokens} ` +
      `tokens is about ${seconds} s, and the response timeout is ${params.requestTimeoutSeconds} s. ` +
      `Nothing should normally generate that much; if something does, the request is cut off ` +
      `rather than finished. This is an estimate, not a measurement.`
    );
  });

  protected reasoning(): LlmReasoningEffort {
    return this.store.llm()?.params.reasoningEffort ?? 'none';
  }

  protected setReasoning(effort: LlmReasoningEffort): void {
    if (effort === this.reasoning()) return;
    void this.store.patch({ params: { reasoningEffort: effort } });
  }

  protected saveParam(key: NumericParam, raw: string): void {
    const trimmed = raw.trim();
    // Only `seed` is nullable, and an empty seed box is how a user says "none".
    if (trimmed === '') {
      if (key === 'seed') void this.store.patch({ params: { seed: null } });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return;
    if (value === this.param(key)) return;
    void this.store.patch({ params: { [key]: value } });
  }

  protected toggleMask(on: boolean): void {
    void this.store.patch({ maskPlaceholders: on });
  }

  protected toggleFewShot(on: boolean): void {
    void this.store.patch({ fewShotExamples: on });
  }

  /**
   * The one toggle on this screen that is a project setting.
   *
   * `auto` is the default and the NFR-8 protection: state is written only into
   * files that already carry it, so a one-word change stays a one-line diff in
   * a repository that does not use `ng-extract-i18n-merge`. Turning it on means
   * `always`; turning it off means `never`, which does not strip the attributes
   * somebody else's tooling wrote.
   */
  protected readonly WRITE_STATE_OPTIONS: ReadonlyArray<SegmentOption<WriteStateMode>> = [
    { value: 'auto', label: 'Auto' },
    { value: 'always', label: 'Always' },
    { value: 'never', label: 'Never' },
  ];

  protected writeState(): WriteStateMode {
    return this.project.project()?.writeState ?? 'auto';
  }

  protected setWriteState(mode: WriteStateMode): void {
    if (mode === this.writeState()) return;
    void this.#projectApi.patch({ writeState: mode }).then((project) => this.project.set(project));
  }

  protected setTheme(mode: ThemeMode): void {
    this.theme.set(mode);
  }

  /**
   * Per-rule severity (FR-8.2) — already fully persisted server-side since M3;
   * this pane is the first client of it. A project setting, like `writeState`:
   * `.lexi/project.json` is a partial map, so a rule nobody has configured
   * falls back to the engine's own default.
   */
  protected severity(rule: RuleId): Severity {
    return this.project.project()?.severities?.[rule] ?? DEFAULT_SEVERITIES[rule];
  }

  protected setSeverity(rule: RuleId, value: Severity): void {
    if (value === this.severity(rule)) return;
    void this.#projectApi
      .patch({ severities: { [rule]: value } })
      .then((project) => this.project.set(project));
  }

  /** A machine setting, like `theme` — see `EDITOR_MODES`' own doc comment. */
  protected setEditorMode(mode: EditorMode): void {
    void this.store.patch({ editorMode: mode });
  }
}
