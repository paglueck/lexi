// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The zod-free half of the contract.
 *
 * Every vocabulary the client needs AT RUNTIME lives here, and this module
 * imports nothing. That is not tidiness — `z.enum(...)` at module scope is not
 * provably pure, so esbuild cannot drop it, and a single value import from the
 * schema barrel pulls all of zod into the browser bundle (measured: 190 kB →
 * 646 kB raw). The client imports values from `@lexi/shared/constants` and
 * types from `@lexi/shared` with `import type`; only the server needs schemas.
 */

/** Error codes carried by every non-2xx `/api` response. */
export const ERROR_CODES = [
  'bad_request',
  'forbidden',
  'not_found',
  'conflict',
  'stale_file',
  /** A service lexi talks to on the user's behalf (Phrase) refused or failed. */
  'upstream',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Mirrors `UNIT_STATES` in `@lexi/xliff` (state.ts). */
export const UNIT_STATES = [
  'untranslated',
  'draftMachine',
  'needsReview',
  'reviewed',
  'final',
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/** Mirrors `WRITE_STATE_MODES` in `@lexi/xliff` (state.ts). */
export const WRITE_STATE_MODES = ['auto', 'always', 'never'] as const;
export type WriteStateMode = (typeof WRITE_STATE_MODES)[number];

/**
 * Mirrors `ESCAPE_POLICIES` in `@lexi/xliff` (escape.ts).
 *
 * `angular` escapes all five predefined entities, matching what
 * `@angular/compiler` writes, so an edited target does not diverge from the next
 * `ng extract-i18n` and produce churn in every later diff (NFR-8).
 */
export const ESCAPE_POLICIES = ['angular', 'minimal'] as const;
export type EscapePolicy = (typeof ESCAPE_POLICIES)[number];

/** Mirrors `RULE_IDS` in `@lexi/xliff` (validate.ts). */
export const RULE_IDS = [
  'placeholder.mismatch',
  'placeholder.pairing',
  'icu.structure',
  'icu.pluralCoverage',
  'icu.deadCategory',
  'target.empty',
  'target.identicalToSource',
  'whitespace.edges',
  'punctuation.terminal',
  'language.script',
  'xml.wellFormed',
  'glossary.term',
  'glossary.dnt',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Mirrors `Severity` in `@lexi/xliff` (validate.ts). Configurable per rule. */
export const SEVERITIES = ['error', 'warning', 'off'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Mirrors `DEFAULT_SEVERITIES` in `@lexi/xliff` (validate.ts).
 *
 * The Settings validation pane (FR-8.2) needs these client-side to render a
 * rule's severity control before a project has ever set one — `.lexi/project.json`
 * is a partial map, and a rule it has never configured falls back to this.
 * Checked against the engine's copy at both compile and run time in
 * `xliff-compat.test.ts` so the two cannot silently drift.
 */
export const DEFAULT_SEVERITIES: Readonly<Record<RuleId, Severity>> = {
  'placeholder.mismatch': 'error',
  'placeholder.pairing': 'error',
  'icu.structure': 'error',
  'icu.pluralCoverage': 'error',
  'icu.deadCategory': 'warning',
  'target.empty': 'error',
  'target.identicalToSource': 'warning',
  'whitespace.edges': 'warning',
  'punctuation.terminal': 'warning',
  'language.script': 'warning',
  'xml.wellFormed': 'error',
  'glossary.term': 'warning',
  'glossary.dnt': 'warning',
};

/** Mirrors `FIX_KINDS` in `@lexi/xliff` (fixes.ts). The deterministic fixes the Issues screen offers. */
export const FIX_KINDS = ['whitespace', 'rename', 'insert-edge'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/** How the Issues screen groups a rule's findings. */
export const ISSUE_GROUPINGS = ['file', 'locale', 'none'] as const;
export type IssueGrouping = (typeof ISSUE_GROUPINGS)[number];

/** Mirrors `LocaleSource` in `@lexi/xliff` (locate.ts). How a file's locale was found. */
export const LOCALE_SOURCES = ['filename', 'directory', 'attribute', 'none'] as const;
export type LocaleSource = (typeof LOCALE_SOURCES)[number];

/**
 * Locales written right to left. Drives the `RTL` badge in the setup wizard and
 * the editor's `dir` (FR-3.10). Matched on the language subtag alone.
 */
export const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb'] as const;

export const isRtlLocale = (locale: string): boolean =>
  (RTL_LANGUAGES as readonly string[]).includes(locale.toLowerCase().split('-')[0] ?? '');

export const FS_ENTRY_KINDS = ['dir', 'file', 'symlink'] as const;
export type FsEntryKind = (typeof FS_ENTRY_KINDS)[number];

export const SSE_EVENT_TYPES = [
  'hello',
  'heartbeat',
  'file-changed',
  'save-complete',
  'job-progress',
  'job-state',
  'job-log',
] as const;

/* ---- the grid (M5) ------------------------------------------------------- */

/**
 * The left rail's filter set (FR-3.4). They combine with AND.
 *
 * `machineDrafts` is in the vocabulary but has no data source yet: nothing
 * writes machine origin until `.lexi/state.json` arrives with the LLM
 * milestones, and `readUnitState` can only return `draftMachine` for a state a
 * human could equally have written. The rail renders it disabled rather than
 * reporting a count it cannot honestly compute.
 */
export const GRID_FILTERS = [
  'untranslated',
  'needsReview',
  'machineDrafts',
  /**
   * `needsReview` OR `machineDrafts` for the scoped locale — M12's review
   * queue (FR-7.1). A composite rather than a query-level OR combinator: every
   * other filter is already an arbitrary predicate over a row, so nothing about
   * the AND-only combination of filters is violated by one filter's own
   * predicate being an OR internally.
   */
  'toReview',
  'hasErrors',
  'stale',
  'noNote',
  'icuOnly',
] as const;
export type GridFilter = (typeof GRID_FILTERS)[number];

/**
 * Filters with no data source until a later milestone. Rendered, not counted.
 *
 * Empty since M9: `machineDrafts` finally has one. XLIFF 1.2 has no `subState`,
 * so "a model wrote this" cannot be read back out of a file — the origin is
 * recorded in `.lexi/state.json` when a draft is written and the index folds it
 * back in, which is option (a) of requirements §4.2.
 */
export const UNAVAILABLE_FILTERS: readonly GridFilter[] = [];

/** Where full-text search looks (FR-3.5). */
export const SEARCH_SCOPES = ['all', 'key', 'source', 'target', 'notes'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/**
 * A unit id is unique within a file group, not within a project: the same id
 * legitimately appears in two `<file>` elements (FR-1.4), which is why
 * `edge/two-files.xlf` is in the corpus. The grid's row key therefore carries
 * both halves.
 *
 * The separator is the ASCII unit-separator control character, which is illegal
 * in an XML Name and never occurs in a path — so it cannot collide with either
 * half — and it percent-encodes cleanly for the detail route's URL.
 */
export const ROW_ID_SEP = String.fromCharCode(31);

export const rowIdOf = (group: string, unitId: string): string => group + ROW_ID_SEP + unitId;

/**
 * What a new key's id may be (`POST /api/units`): anything `ng extract-i18n`
 * would accept for `@@id`, except whitespace and control characters — the row
 * id separator is one of those.
 */
// eslint-disable-next-line no-control-regex -- excluding them is the point
export const UNIT_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

export const splitRowId = (rowId: string): { group: string; unitId: string } => {
  const at = rowId.indexOf(ROW_ID_SEP);
  // A group name never contains the separator, so the FIRST one is the split.
  return at === -1
    ? { group: '', unitId: rowId }
    : { group: rowId.slice(0, at), unitId: rowId.slice(at + 1) };
};

/**
 * Text runs longer than this are truncated by the SERVER before they reach the
 * grid. The row is one line, fixed at 34 px and ellipsised (deviation 2), so
 * the bytes past this point can never be seen; shipping them would cost a
 * megabyte per screen and buy nothing. The detail panel fetches untruncated.
 */
export const GRID_TEXT_LIMIT = 140;

/* ---- the LLM endpoint (M8) ----------------------------------------------- */

/**
 * The adapter vocabulary (FR-6.2).
 *
 * `openai` is the OpenAI-compatible `/v1/chat/completions` shape, which covers
 * Ollama, LM Studio, llama.cpp server, vLLM, LocalAI and Jan — one adapter for
 * every server the team is likely to run. `ollama` is its native `/api/chat`
 * and is explicitly out of the MVP; the seam exists so adding it is
 * an afternoon rather than a refactor, and S7 draws the card either way.
 *
 * `copilot` is GitHub Copilot through the official Copilot SDK — for the
 * people who cannot run a local model, where Copilot is the one approved
 * cloud tool. It has no base URL: the SDK knows where GitHub is, and the
 * user's Copilot login (or a GitHub token in the API key field) is the
 * credential.
 */
export const LLM_ADAPTERS = ['openai', 'copilot', 'ollama'] as const;
export type LlmAdapter = (typeof LLM_ADAPTERS)[number];

/** Adapters that are not addressed by a base URL. */
export const URLLESS_ADAPTERS: readonly LlmAdapter[] = ['copilot'];

/**
 * Whether enough is stored to send a request: a model, and an endpoint where
 * the adapter needs one. The one definition of "configured" — the server's
 * guards, the prompt preview and S1/S7 all ask it.
 */
export function isLlmConfigured(llm: {
  readonly adapter: LlmAdapter;
  readonly baseUrl: string;
  readonly model: string;
}): boolean {
  if (llm.model.trim() === '') return false;
  return URLLESS_ADAPTERS.includes(llm.adapter) || llm.baseUrl.trim() !== '';
}

/**
 * How much the model may think before it answers (FR-6.4).
 *
 * Reasoning models bill their deliberation to the same token budget as the
 * answer and, on an OpenAI-compatible server, hide it in a channel the answer
 * never shows: `message.reasoning_content`, counted under
 * `usage.completion_tokens_details.reasoning_tokens`. Nothing in `content`
 * reveals it, so a model that thinks for four hundred seconds and a model that
 * is simply unreachable look identical from here — a timeout, with no clue.
 *
 * `'server'` is the one value that is never sent. It means "say nothing about
 * reasoning and let the endpoint decide", which is the only honest option for a
 * server that has never heard of the field.
 */
export const LLM_REASONING_EFFORTS = ['server', 'none', 'low', 'medium', 'high'] as const;
export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

/** Adapters with no implementation behind them. Rendered, never selectable. */
export const UNAVAILABLE_ADAPTERS: readonly LlmAdapter[] = ['ollama'];

/**
 * The three things "Test connection" answers separately (FR-6.3).
 *
 * Reported one by one on purpose: a wrong port, a server that answers but has
 * no such model, and a model that loads but cannot complete all look identical
 * to a user ("nothing happened") and have three different fixes.
 */
export const LLM_PROBE_STEPS = ['reachable', 'models', 'completion'] as const;
export type LlmProbeStep = (typeof LLM_PROBE_STEPS)[number];

export const THEME_MODES = ['dark', 'light', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/**
 * `LxSegmentEditor`'s two rendering modes, promoted to a stored preference.
 *
 * `'text'` is the documented fallback if chip editing misbehaves in a browser
 * the chip editor has not been verified in yet (Safari, Firefox): this is the
 * escape hatch, made real as a personal Settings choice.
 */
export const EDITOR_MODES = ['chips', 'text'] as const;
export type EditorMode = (typeof EDITOR_MODES)[number];

/** Which settings nav section the page is showing. Mirrors S7's 220px rail. */
export const SETTINGS_SECTIONS = [
  'model',
  'phrase',
  'validation',
  'xliff',
  'editor',
  'appearance',
  'shortcuts',
  'updates',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Generation defaults (FR-6.4), low-temperature because this is translation and
 * not prose: the same source string should come back the same way twice.
 *
 * `concurrency` defaults to 2 rather than 1 because a local server queues
 * anyway and two in flight hides the round trip; `unitsPerRequest` defaults to
 * 1 because batching risks the model drifting or misaligning outputs (FR-6.8),
 * which is silent damage rather than a visible failure.
 *
 * `reasoningEffort` defaults to `'none'` because deliberation is not what this
 * task is short of. A UI string is a handful of words with its context already
 * in the prompt; a reasoning model given one spends minutes weighing synonyms
 * and can fall into a loop it never leaves — the observed failure was a button
 * label that burned ten thousand tokens arguing with itself and never answered.
 * A user who wants the deliberation can still ask for it.
 */
export const DEFAULT_LLM_PARAMS = {
  temperature: 0.2,
  topP: 0.9,
  maxTokens: 512,
  seed: 7,
  reasoningEffort: 'none' as LlmReasoningEffort,
  contextWindow: 8192,
  requestTimeoutSeconds: 120,
  concurrency: 2,
  unitsPerRequest: 1,
} as const;

/** Bounds the server enforces, and the ones the number fields advertise. */
export const LLM_PARAM_LIMITS = {
  temperature: { min: 0, max: 2, step: 0.05 },
  topP: { min: 0, max: 1, step: 0.05 },
  maxTokens: { min: 1, max: 32_768, step: 1 },
  contextWindow: { min: 512, max: 1_000_000, step: 1 },
  requestTimeoutSeconds: { min: 1, max: 1_800, step: 5 },
  concurrency: { min: 1, max: 8, step: 1 },
  unitsPerRequest: { min: 1, max: 20, step: 1 },
} as const;

/**
 * Reachability and the model list must be quick; a completion may not be.
 *
 * The probe's timeout stays fixed because it answers "is anything listening on
 * this port": every server that is up answers `/v1/models` in milliseconds, and
 * a generous timeout there would only make a wrong port take longer to report.
 *
 * How long a COMPLETION may take is a fact about the user's machine and model —
 * a 27B model on CPU, or one that has to be loaded into VRAM first, is slow in
 * a way no constant can predict — so it is a setting
 * (`params.requestTimeoutSeconds`) rather than a number in this file. What
 * remains here is the fallback for a caller that has no settings to read.
 */
export const LLM_PROBE_TIMEOUT_MS = 5_000;
export const LLM_COMPLETION_TIMEOUT_MS = DEFAULT_LLM_PARAMS.requestTimeoutSeconds * 1000;

/**
 * True for `localhost`, `127.0.0.0/8`, `::1` and `*.localhost`.
 *
 * Not a gate — FR-6.1 lets the user configure any endpoint, and a second
 * machine on the LAN running the GPU is a legitimate setup. It is what lets S7
 * say so out loud instead of printing the privacy promise over a URL that
 * quietly breaks it.
 */
export function isLoopbackUrl(url: string): boolean {
  // Parsed by hand rather than with `new URL`: this module is imported by the
  // browser bundle AND compiled without the DOM lib, and its one rule is that
  // it imports nothing.
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]*)/i.exec(url.trim());
  const host = (match?.[1] ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/* ---- the prompt (M9) ----------------------------------------------------- */

/**
 * How placeholders are rendered to the model (FR-PH-7, requirements Appendix A).
 *
 * `masked` substitutes each `<x/>` with a short `[[n]]` token and restores it
 * mechanically afterwards; `raw` sends the element as written. Appendix A
 * argues for masking and says to confirm it against a real local model before
 * committing — so both paths ship, gated equally hard on the way back, and S5
 * is the screen that compares them on the same unit.
 */
export const PLACEHOLDER_STYLES = ['masked', 'raw'] as const;
export type PlaceholderStyle = (typeof PLACEHOLDER_STYLES)[number];

/**
 * The prompt's named blocks, in the order requirements §6 fixes them.
 *
 * The order is the contract, and it lives here rather than in the composer so
 * that the preview, the composer and any later test all read it from one place.
 * A locale style guide's block id is `styleguide.<locale>`, which is why the
 * list carries `styleguide.locale` as its shape rather than a literal.
 */
export const PROMPT_BLOCK_KINDS = [
  'role',
  'invariants',
  'styleguide',
  'terminology',
  'user',
] as const;
export type PromptBlockKind = (typeof PROMPT_BLOCK_KINDS)[number];

/** S5's segmented control: which half of the composed prompt is on screen. */
export const PROMPT_VIEWS = ['system', 'user', 'schema'] as const;
export type PromptView = (typeof PROMPT_VIEWS)[number];

/** The model's own self-report, asked for in the response schema (FR-6.9). */
export const LLM_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type LlmConfidence = (typeof LLM_CONFIDENCES)[number];

/**
 * How tolerant parsing arrived at the translation (FR-6.9), which the run log
 * records because it is the cheapest signal of whether a model can be trusted
 * with a JSON contract at all.
 */
export const LLM_PARSE_MODES = [
  'json',
  'fenced',
  'embedded',
  'retried',
  'plain',
  /** No model was asked: the source IS a Term Base term, and its entry is the answer. */
  'termbase',
] as const;
export type LlmParseMode = (typeof LLM_PARSE_MODES)[number];

/* ---- review (M14) ---------------------------------------------------------- */

/**
 * What a reviewer just did to a machine draft (S11).
 *
 * STATED rather than inferred, and that is the point of the field existing at
 * all. M12 worked out approve-vs-correct by hashing what came back against the
 * bytes the model wrote, which is right for an ordinary grid edit — there is no
 * reviewer there to ask. But once Reject restores the previous target, a model
 * that happened to reproduce that target verbatim would submit the draft's own
 * hash and be recorded as "approved unchanged" for a REJECTION, inverting the
 * one number the MVP exists to produce. A PATCH that carries no decision keeps
 * the hash comparison and therefore behaves exactly as it did before.
 */
export const REVIEW_DECISIONS = ['approve', 'edit', 'reject'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * S11's reject-reason chips. The vocabulary is fixed so the chips render from
 * one list and a stored reason stays readable; free text goes in its own chip.
 */
export const REJECT_REASONS = [
  'wrong-term',
  'ignores-glossary',
  'too-long',
  'wrong-register',
  'placeholder-misplaced',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/* ---- jobs (M11) ------------------------------------------------------------ */

/**
 * A job's lifecycle (FR-6.7). One job runs at a time — `queued` jobs wait
 * behind it — and `paused`/`cancel` both stop after the in-flight unit rather
 * than mid-request, so there is no `cancelling` state to render.
 */
export const JOB_STATUSES = ['queued', 'running', 'paused', 'done', 'cancelled', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * What a job does to the units it was handed. Only `draft` exists for now — the
 * design's "Re-draft units in review" task is still a single-unit action in
 * S11 — but the field is on every job so that locking ("this locale is already
 * in an active job") compares like with like once a second task arrives.
 */
export const JOB_TASKS = ['draft'] as const;
export type JobTask = (typeof JOB_TASKS)[number];

/**
 * One locale's lifecycle INSIDE a job (S14). The locales of a job run one after
 * another, so at most one of them is `running`/`paused` at a time.
 *
 * `skipped` here means the USER skipped the whole locale before it started —
 * not the unit outcome `skipped` below, which is the overwrite guard refusing
 * one unit. A skipped locale is left untouched and drops out of the job's
 * totals; it can be put back (`queued`) while the job has not finished.
 */
export const JOB_LOCALE_STATUSES = [
  'queued',
  'running',
  'paused',
  'done',
  'skipped',
  'cancelled',
  'failed',
] as const;
export type JobLocaleStatus = (typeof JOB_LOCALE_STATUSES)[number];

/**
 * One run-log entry's outcome (FR-6.14), matching a job's four counters 1:1:
 * `rejected` is a restore-gate failure (FR-6.11), `skipped` is FR-6.10's
 * overwrite guard (a human translation was in the way), `failed` is anything
 * else — the endpoint was unreachable, the row no longer exists. S8's "N
 * flagged" is `rejected + skipped` computed on the client, because both need a
 * human look even though only one is the model's fault.
 */
export const JOB_LOG_OUTCOMES = ['accepted', 'rejected', 'skipped', 'failed'] as const;
export type JobLogOutcome = (typeof JOB_LOG_OUTCOMES)[number];

/**
 * What a finished job can be exported as: the HTML review report, or a CSV of
 * unit id, description and translation that a market reviewer edits in Excel
 * and that is meant to be imported back later.
 */
export const REPORT_FORMATS = ['html', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** `;` is what Excel splits on in most European locales, `,` everywhere else. */
export const CSV_DELIMITERS = [';', ','] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/**
 * How a job's CSV export is cut: one file holding every locale, or one file
 * per locale for a market reviewer who only sees their own language.
 */
export const CSV_SPLITS = ['single', 'perLocale'] as const;
export type CsvSplit = (typeof CSV_SPLITS)[number];

/**
 * Average characters per token, for the estimate FR-5.4 wants BEFORE anything
 * has run.
 *
 * Four is the usual figure quoted for English prose; this is lower because a
 * translation prompt is not prose — it carries identifiers like
 * `INTERPOLATION_1`, file paths and punctuation, all of which tokenize worse.
 * It is an estimate and is labelled as one everywhere it appears; the real
 * figure replaces it from the server's `usage` as soon as a request has
 * actually run.
 */
export const CHARS_PER_TOKEN = 3.7;

/** CJK codepoints run roughly one token per character, not four. */
const isCjk = (cp: number): boolean =>
  (cp >= 0x3040 && cp <= 0x30ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xac00 && cp <= 0xd7af) ||
  (cp >= 0xf900 && cp <= 0xfaff);

/**
 * A character-based token estimate, shared by the server's meter and the style
 * guide editor's live count so the two can never disagree.
 *
 * Deliberately not a real tokenizer: shipping one would mean vendoring a
 * vocabulary per model family, and the number is only ever used to warn that a
 * prompt is approaching a context window.
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk += 1;
    else rest += 1;
  }
  return Math.ceil(cjk + rest / CHARS_PER_TOKEN);
}

/* ---- M10: style guides and the term base ---------------------------------- */

/**
 * The key the global guide is addressed by, in the URL and in the locale bar.
 *
 * Style guides are `.md` files named after their locale (`de.md`, `pt-BR.md`),
 * so the global one needs a name that cannot collide with a locale tag —
 * `global` is not a well-formed BCP-47 primary subtag, which is exactly why it
 * is safe as the reserved word (see `looksLikeLocaleTag`).
 */
export const GLOBAL_GUIDE_KEY = 'global';

/**
 * The cap on one style guide, in UTF-8 bytes.
 *
 * Not a storage concern — 256 kB of Markdown is nothing on disk. It is a
 * refusal to accept something that cannot possibly be a style guide, since the
 * whole file is injected verbatim into every prompt (FR-5.3) and a context
 * window of 8k is roughly 30 kB.
 */
export const STYLEGUIDE_MAX_BYTES = 256 * 1024;

/**
 * The Markdown vocabulary the preview renders (FR-5.4).
 *
 * Deliberately small: this is the subset a style guide is written in, not a
 * general Markdown implementation. Anything outside it stays literal text,
 * which is the entire safety argument — see `MdBlock`.
 */
export const MD_BLOCK_KINDS = [
  'heading',
  'para',
  'quote',
  'list',
  'code',
  'rule',
  'table',
] as const;
export type MdBlockKind = (typeof MD_BLOCK_KINDS)[number];

/** Inline emphasis within one span. `plain` is the default and the fallback. */
export const MD_SPAN_STYLES = ['plain', 'strong', 'em', 'code'] as const;
export type MdSpanStyle = (typeof MD_SPAN_STYLES)[number];

/** A table column's alignment, from the delimiter row's `:---:` markers. */
export const MD_TABLE_ALIGNS = ['none', 'left', 'center', 'right'] as const;
export type MdTableAlign = (typeof MD_TABLE_ALIGNS)[number];

/** The Term Base's file inside `.lexi/` (FR-5.8). */
export const TERMBASE_FILE = 'termbase.csv';

/** Where the glossary lived before the Term Base; read once and migrated. */
export const LEGACY_GLOSSARY_FILE = 'glossary.json';

/**
 * FR-5.6's starter template for the global guide — requirements Appendix B, verbatim.
 *
 * Headings and nothing else, on purpose. The guide is injected verbatim into
 * every prompt, so prefilled prose would be advice nobody chose being sent to
 * the model under the team's name. The skeleton says which questions to answer.
 */
export const STYLEGUIDE_TEMPLATE_GLOBAL = `# Global style guide

## Audience and register

## Tone

## Sentence case and capitalization

## Punctuation

## Numbers, dates, currency

## Placeholders and variables

## Terminology and product names

## Length and truncation

## UI element conventions

- Button labels
- Error messages
- Empty states
- Tooltips

## What never to translate
`;

/**
 * FR-5.6's starter template for a locale extension — requirements Appendix C, with the
 * locale filled in.
 *
 * The blockquote is not decoration: FR-5.3 requires the composed prompt to say
 * that locale rules override the global guide, and a guide that opens by
 * saying the same thing reads consistently with what the model is told.
 */
export function styleGuideTemplateFor(locale: string): string {
  return `# ${locale} — style guide extension

> These rules extend and, where they conflict, override the global style guide.

## Form of address

## Compound nouns

## Gender-inclusive language

## Capitalization specifics

## Quotation marks

## Number and date formats

## Terms that stay in English

## Known length pitfalls
`;
}

/* ---- Phrase (S17–S19) ------------------------------------------------------ */

/**
 * Phrase data centers. The token decides which one: a token from the US data
 * center is unknown to the EU API and vice versa.
 */
export const PHRASE_REGIONS = ['EU', 'US'] as const;
export type PhraseRegionCode = (typeof PHRASE_REGIONS)[number];

/** The API base per data center — the same shape as `.phrase.yml`'s `host`. */
export const PHRASE_HOSTS: Readonly<Record<PhraseRegionCode, string>> = {
  EU: 'https://api.phrase.com/v2',
  US: 'https://api.us.app.phrase.com/v2',
};

export const PHRASE_TOKEN_STATUSES = ['ok', 'bad', 'unchecked'] as const;
export type PhraseTokenStatus = (typeof PHRASE_TOKEN_STATUSES)[number];

/** The six log rows of the checkout's step 4, in order. */
export const PHRASE_CHECKOUT_STEPS = [
  'fetch-keys',
  'fetch-base',
  'write-base',
  'write-targets',
  'write-origin',
  'add-recent',
] as const;
export type PhraseCheckoutStep = (typeof PHRASE_CHECKOUT_STEPS)[number];

export const PHRASE_CHECKOUT_STEP_STATES = ['running', 'waiting', 'done', 'failed'] as const;
export type PhraseCheckoutStepState = (typeof PHRASE_CHECKOUT_STEP_STATES)[number];
