// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  composeSegments,
  plainText,
  segmentsOf,
  restoreRaw,
  textOnly,
  unmask,
  validateSegments,
  DEFAULT_SEVERITIES,
  type Finding,
  type Segment,
  type UnmaskFailureReason,
  type UnitState,
  type UnmaskResult,
} from '@lexi/xliff';
import {
  LLM_PARAM_LIMITS,
  type LlmConfidence,
  type LlmParseMode,
  type PlaceholderStyle,
  type PromptTerm,
  type PromptTotals,
  type TranslateRun,
  type TranslateUnitResponse,
} from '@lexi/shared';

import { commitTarget, editableCell, openRow } from '../lib/commit.js';
import { badRequest, HttpError } from '../lib/http-error.js';
import {
  originKey,
  targetHash,
  writeMachineOrigins,
  type MachineOrigin,
} from '../lib/machine-origin.js';
import { readStyleGuides } from '../lib/styleguides.js';
import {
  appliedTerms,
  exactTermMatch,
  glossaryChecks,
  matchTerms,
  readTermBase,
} from './termbase.js';
import { specOf } from '../lib/notes.js';
import { writeDrafts } from '../lib/drafts.js';
import { effectiveSegments, sourceSegmentsOf } from '../lib/unit-dto.js';
import { toEditSegments } from '../lib/wire-segments.js';
import { composeBatchPrompt, composePrompt, type ComposedPrompt } from './prompt.js';
import { createLlmClient, LlmError, type ChatMessage, type LlmClient } from './llm-client.js';
import type { ServerConfig } from '../config.js';
import type { ProjectService } from '../services/project-service.js';
import type { SettingsService } from './settings-service.js';

/**
 * One unit, one locale, drafted by the local model (FR-6.5) — M9.
 *
 * The shape of the path, and the two places it is allowed to stop:
 *
 *   compose (one place, server-side)
 *     -> chat
 *     -> tolerant parse: fences, embedded object, one stricter retry, plain text
 *     -> RESTORE GATE: unmask / restoreRaw. A failure stops here, is reported,
 *        and nothing is written.
 *     -> validate (FR-6.11). Findings are attached, never fatal — a draft that
 *        needs a look is exactly what a draft is.
 *     -> commit into the overlay as Draft (machine), and record the origin.
 *
 * Note what does NOT happen: no file is touched. A machine draft lands in the
 * same overlay a human edit does and is saved by the same `POST /api/save`, so
 * there is one way bytes reach a repository and it is the one that was already
 * tested.
 */

export interface TranslateOptions {
  readonly rowId: string;
  readonly locale: string;
  readonly placeholderStyle?: PlaceholderStyle | undefined;
  readonly instruction?: string | undefined;
  /** FR-6.10: required before a machine draft may replace a human translation. */
  readonly overwrite?: boolean | undefined;
}

export interface TranslateDeps {
  readonly cfg: ServerConfig;
  readonly projects: ProjectService;
  readonly settings: SettingsService;
  /** Injected by the tests; production uses the configured endpoint. */
  readonly client?: LlmClient | undefined;
}

/**
 * What the run records about itself, beyond the answer — S11's "How this draft
 * was made" (M14). Carried out of `buildPrompt` because that is where these
 * facts are already resolved; re-reading them off `ComposedPrompt.blocks`
 * afterwards would be a second derivation of the same thing.
 */
export interface PromptProvenance {
  /** The locale style guide's file name (`de.md`), or null when there is none. */
  readonly styleGuide: string | null;
  readonly glossaryInjected: number;
  readonly glossaryTotal: number;
  /** The injected entries, so the answer can be checked against them afterwards. */
  readonly terms: readonly PromptTerm[];
}

export interface BuiltPrompt {
  readonly prompt: ComposedPrompt;
  readonly sourceSegments: readonly Segment[];
  readonly style: PlaceholderStyle;
  readonly provenance: PromptProvenance;
  /**
   * Set when the whole source IS a Term Base term with an answer for this
   * locale (`exactTermMatch`). The run then never reaches the model: the entry
   * is written as the target, `final` (`finalizeFromTermBase`).
   */
  readonly termBaseHit: { readonly term: string; readonly translation: string } | null;
}

/** Everything the preview and the run both need, resolved from the project. */
export async function buildPrompt(
  deps: TranslateDeps,
  options: Pick<TranslateOptions, 'rowId' | 'locale' | 'placeholderStyle' | 'instruction'>,
): Promise<BuiltPrompt> {
  const { projects, settings } = deps;
  const project = projects.current;
  if (!project) throw badRequest('no project is open');

  const row = openRow(projects, options.rowId);
  const cell = row.cells.get(options.locale);
  if (!cell) throw badRequest(`this unit has no ${options.locale} column`);

  /**
   * The project's source unit where there is one, and the unit's OWN `<source>`
   * otherwise — which is what makes an orphan translatable. Angular writes the
   * source text into every translation file, so a unit whose id has vanished
   * from the template still carries the English it was written against.
   */
  const fromSourceFile = sourceSegmentsOf(row);
  const sourceSegments =
    fromSourceFile.length > 0
      ? fromSourceFile
      : cell.unit && cell.doc
        ? segmentsOf(cell.doc.raw, cell.unit.source.innerSpan)
        : [];

  const style: PlaceholderStyle =
    options.placeholderStyle ?? (settings.maskPlaceholders ? 'masked' : 'raw');

  const termBase = await readTermBase(project.path);
  const { matched, total } = matchTerms(termBase, textOnly(sourceSegments), options.locale);
  const terminology = { glossary: matched, glossaryTotal: total };
  const styleguides = await readStyleGuides(project.path, options.locale);

  // An unsaved note edit is what the panel shows, so it is what the model reads
  // (FR-4.2): drafting against a note the user just rewrote would be drafting
  // against context that no longer exists.
  const notes =
    projects.pendingNotesFor(row.rowId)?.notes ??
    ((row.sourceUnit ?? cell.unit)?.notes ?? []).map(specOf);
  const contexts = (row.sourceUnit ?? cell.unit)?.contextGroups ?? [];

  const prompt = composePrompt({
    unit: {
      unitId: row.unitId,
      sourceSegments,
      notes: notes.map((n) => ({ from: n.from, text: n.text })),
      locations: contexts
        .filter((g) => g.purpose === 'location' && g.sourcefile !== undefined)
        .map((g) => ({ sourcefile: g.sourcefile as string, linenumber: g.linenumber ?? null })),
      relPath: cell.relPath,
    },
    sourceLocale: project.sourceLocale,
    targetLocale: options.locale,
    placeholderStyle: style,
    styleguides,
    // FR-5.9: only the terms that appear in THIS string, matched against the
    // plain text of the source rather than its markup — a placeholder's
    // `equiv-text` is not prose and must not be able to pull in a term.
    ...terminology,
    instruction: options.instruction,
    contextWindow: settings.params.contextWindow,
  });

  return {
    prompt,
    sourceSegments,
    style,
    // The three facts S11's "How this draft was made" panel needs, carried out
    // of here rather than re-derived from `prompt.blocks` later. A second
    // derivation would agree with this one right up until somebody changed how
    // a block is labelled — the same argument `ComposedPrompt.terminology`
    // already makes for the terminology table itself.
    provenance: {
      styleGuide: styleguides.locale?.name ?? null,
      glossaryInjected: matched.length,
      glossaryTotal: total,
      terms: matched,
    },
    termBaseHit: exactTermMatch(termBase, sourceSegments, options.locale),
  };
}

/**
 * Everything decided about one unit BEFORE the model is asked: the guard, the
 * snapshot of what a draft would displace, and the composed prompt. Split out
 * of `translateUnit` when batching arrived (FR-6.8), so a batch of N units runs
 * exactly N of these and cannot drift from the single-unit path.
 */
interface PreparedUnit {
  readonly options: TranslateOptions;
  readonly row: ReturnType<typeof openRow>;
  readonly cell: ReturnType<typeof editableCell>;
  readonly existing: readonly Segment[];
  readonly priorOrigin: MachineOrigin | undefined;
  readonly previousState: UnitState;
  readonly built: BuiltPrompt;
}

async function prepareUnit(deps: TranslateDeps, options: TranslateOptions): Promise<PreparedUnit> {
  const { projects } = deps;
  if (!projects.current) throw badRequest('no project is open');

  const row = openRow(projects, options.rowId);
  // Resolves where the target goes, and refuses early when the locale has no
  // file for this group at all — the one case editing cannot fix (FR-1.9).
  const cell = editableCell(projects, row, options.locale);

  /**
   * FR-6.10 — a machine draft never silently replaces a human translation.
   *
   * "Human" is the important word: re-drafting something this tool drafted
   * earlier is an ordinary retry and must not need a confirmation, or the retry
   * button would ask permission to overwrite its own last answer.
   */
  const existing = effectiveSegments(row, options.locale, (r, l) => projects.pendingFor(r, l));
  const existingText = plainText(existing).trim();
  const wasMachine = row.cells.get(options.locale)?.state === 'draftMachine';
  if (existingText !== '' && !wasMachine && options.overwrite !== true) {
    throw new HttpError(
      409,
      'conflict',
      `The ${options.locale} translation was written by a person. Confirm the overwrite to replace it.`,
      { existing: existingText },
    );
  }

  // Read BEFORE anything is committed: after `commitTarget` the overlay holds
  // the draft, and after a save the file does too, so this is the last moment
  // the displaced text exists anywhere.
  const priorOrigin = projects.machineOrigins.get(originKey(options.rowId, options.locale));
  const previousState =
    projects.pendingFor(options.rowId, options.locale)?.state ??
    row.cells.get(options.locale)?.state ??
    'untranslated';

  const built = await buildPrompt(deps, options);
  return { options, row, cell, existing, priorOrigin, previousState, built };
}

function modelOf(deps: TranslateDeps): string {
  const model = deps.settings.endpoint.model;
  if (model.trim() === '') throw badRequest('No model is configured. Set one in Settings.');
  return model;
}

async function chatOrExplain(
  client: LlmClient,
  messages: readonly ChatMessage[],
  params: TranslateDeps['settings']['params'],
): Promise<Awaited<ReturnType<LlmClient['chat']>>> {
  try {
    return await client.chat(messages, params);
  } catch (error) {
    // A failure to reach the endpoint is not a rejected draft — it is a
    // configuration or network problem, and it belongs in the error envelope
    // where S7's sentences already live.
    throw error instanceof LlmError ? badRequest(error.message) : error;
  }
}

export async function translateUnit(
  deps: TranslateDeps,
  options: TranslateOptions,
): Promise<TranslateUnitResponse> {
  const { projects, settings } = deps;
  const prepared = await prepareUnit(deps, options);

  // Before the client and the model are resolved: a string the Term Base
  // answers needs neither, and must not fail for want of a configured model.
  if (prepared.built.termBaseHit !== null) {
    const result = finalizeFromTermBase(deps, prepared);
    await persistDrafting(deps);
    return result;
  }

  const { prompt, style } = prepared.built;

  const client = deps.client ?? createLlmClient(settings.endpoint);
  const model = modelOf(deps);

  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  const started = new Date().toISOString();
  const answer = await chatOrExplain(client, messages, settings.params);

  let parsed = parseAnswer(answer.text);
  let raw = answer.text;
  let latencyMs = answer.latencyMs;
  let promptTokens = answer.promptTokens;
  let completionTokens = answer.completionTokens;
  let reasoningTokens = answer.reasoningTokens;
  let finishReason = answer.finishReason;

  /**
   * One stricter retry (FR-6.9), and only when the model answered with prose.
   *
   * Not a second chance at translating — a second chance at the FORMAT. The
   * same messages go back with one added instruction, so a model that ignored
   * the JSON contract the first time is asked once more before we fall back to
   * reading its whole answer as the translation.
   *
   * Not attempted when the first answer hit the token ceiling. A format is not
   * what went wrong there, and the second attempt would run into the same
   * ceiling at the same cost — which, for the model that prompted this guard,
   * is another several hundred seconds of the user's afternoon.
   */
  if (parsed.mode === 'plain' && finishReason !== 'length') {
    try {
      const retry = await client.chat(
        [
          ...messages,
          { role: 'assistant', content: answer.text },
          {
            role: 'user',
            content:
              'That was not valid JSON. Answer again with a single JSON object and nothing else, ' +
              `no code fences and no commentary, exactly matching: ${prompt.schema}`,
          },
        ],
        settings.params,
      );
      const second = parseAnswer(retry.text);
      if (second.mode !== 'plain') {
        parsed = { ...second, mode: 'retried' };
        raw = retry.text;
        latencyMs += retry.latencyMs;
        promptTokens = sum(promptTokens, retry.promptTokens);
        completionTokens = sum(completionTokens, retry.completionTokens);
        reasoningTokens = sum(reasoningTokens, retry.reasoningTokens);
        // The retry is the answer we kept, so its ending is the one that
        // explains the text in `raw`.
        finishReason = retry.finishReason;
      }
    } catch {
      // The retry is a courtesy. Its failure must not lose the first answer,
      // which is still perfectly usable as plain text.
    }
  }

  const run: TranslateRun = {
    at: started,
    model,
    placeholderStyle: style,
    latencyMs,
    promptTokens,
    completionTokens,
    reasoningTokens,
    finishReason,
    parse: parsed.mode,
    confidence: parsed.confidence,
    notesForReviewer: parsed.notes,
    raw,
    prompt: { system: prompt.system, user: prompt.user },
  };

  /**
   * The half-written answer, refused before the restore gate can wave it through.
   *
   * `{"translation": "Andere Meth` is what a ceiling hit looks like when it
   * lands mid-string rather than before the first token. No brace scanner can
   * recover it, so `parseAnswer` falls back to `plain` and hands the whole
   * fragment on as the translation — and a fragment with no placeholders in it
   * unmasks perfectly, because there is nothing left to check. It would reach
   * the overlay as a plausible half-word in the reviewer's own language, which
   * is the silent damage FR-6.11 exists to refuse.
   *
   * Flagged rather than discarded, like every other rejection: `raw` still
   * carries what the model managed to say.
   */
  if (parsed.mode === 'plain' && finishReason === 'length') {
    return {
      ok: false,
      rowId: options.rowId,
      locale: options.locale,
      target: null,
      unsavedCount: projects.unsavedCount,
      run,
      rejection: {
        reason: 'truncated',
        detail:
          `The model stopped at the ${settings.params.maxTokens}-token ceiling part-way ` +
          `through its answer, which left no JSON to read` +
          (reasoningTokens !== null && reasoningTokens > 0
            ? ` — ${reasoningTokens} of those tokens went on reasoning rather than the answer. ` +
              `Set "Reasoning" to Off in Settings, or raise "Max tokens".`
            : `. Raise "Max tokens" in Settings.`),
        missing: [],
        extra: [],
      },
      findings: [],
    };
  }

  const result = finalizeUnit(deps, prepared, parsed.translation, run);
  await persistDrafting(deps);
  return result;
}

/**
 * Everything AFTER the answer is known: the restore gate, validation, the
 * commit, the provenance record. Synchronous, so a batch can finalize all of
 * its units and write `.lexi/` once (`persistDrafting`).
 */
function finalizeUnit(
  deps: TranslateDeps,
  prepared: PreparedUnit,
  translation: string,
  run: TranslateRun,
): TranslateUnitResponse {
  const { projects, settings } = deps;
  const project = projects.current;
  if (!project) throw badRequest('no project is open');
  const { options, row, cell, existing, priorOrigin, previousState } = prepared;
  const { prompt, sourceSegments, style, provenance } = prepared.built;

  /* The restore gate. Nothing below this line can be reached with bad bytes. */
  const restored: UnmaskResult =
    prompt.mask !== null
      ? unmask(translation, prompt.mask)
      : restoreRaw(translation, sourceSegments);

  if (!restored.ok) {
    return {
      ok: false,
      rowId: options.rowId,
      locale: options.locale,
      target: null,
      unsavedCount: projects.unsavedCount,
      run,
      rejection: {
        reason: restored.reason,
        detail: emptyAnswerDetail(restored.reason, restored.detail, prompt.totals),
        missing: [...restored.missing],
        extra: [...restored.extra],
      },
      findings: [],
    };
  }

  const segments = [...restored.segments];

  // FR-6.11's remaining checks. They flag, they do not discard: a draft with a
  // plural-coverage warning is still the most useful thing on the screen, and
  // throwing it away would hide the very finding worth acting on.
  const findings: Finding[] = validateSegments(sourceSegments, segments, {
    sourceLocale: project.sourceLocale,
    targetLocale: options.locale,
    severities: project.severities ?? DEFAULT_SEVERITIES,
    glossary: glossaryChecks(project.glossary ?? [], options.locale),
  });

  const response = commitTarget(projects, row, options.locale, segments, 'draftMachine', cell);
  // Not a step of the user's, and their earlier states of this cell are not
  // theirs to restore over a draft they have not seen (lib/history.ts).
  projects.pruneHistory(options.rowId, options.locale);

  projects.setMachineOrigin(options.rowId, options.locale, {
    at: run.at,
    model: run.model,
    style,
    // The bytes as they will be written, which is what the index compares
    // against later — see lib/machine-origin.ts.
    hash: targetHash(composeSegments(segments, project.escapePolicy)),
    // A RE-draft keeps the ORIGINAL snapshot. Re-drafting over our own draft is
    // an ordinary retry (see the overwrite guard above), so overwriting this
    // with the previous DRAFT would quietly erase the human target the reviewer
    // is diffing against — one click of "Re-draft with reason" and the diff
    // stops showing what the machine actually changed.
    previous:
      priorOrigin?.previous ??
      (existing.length === 0 ? null : { segments: toEditSegments(existing), state: previousState }),
    temperature: settings.params.temperature,
    styleGuide: provenance.styleGuide,
    glossaryInjected: provenance.glossaryInjected,
    glossaryApplied: appliedTerms(provenance.terms, plainText(segments)),
    glossaryTotal: provenance.glossaryTotal,
    confidence: run.confidence,
    notesForReviewer: run.notesForReviewer,
  });

  return {
    ok: true,
    rowId: options.rowId,
    locale: options.locale,
    target: response.target,
    unsavedCount: response.unsavedCount,
    run,
    rejection: null,
    findings,
  };
}

/**
 * A string that IS a Term Base term, answered from its entry without asking the
 * model (`exactTermMatch`).
 *
 * Written `final`, not `draftMachine`: the Term Base is the project's own
 * authority on this wording, so there is no machine guess here to review. For
 * the same reason no machine origin is recorded, and an earlier one is cleared —
 * an origin whose hash matched would read the cell back as a machine draft.
 *
 * Still committed through `commitTarget` and still validated, like every other
 * target: the shortcut skips the model, not the gates.
 */
function finalizeFromTermBase(deps: TranslateDeps, prepared: PreparedUnit): TranslateUnitResponse {
  const { projects } = deps;
  const project = projects.current;
  if (!project) throw badRequest('no project is open');
  const { options, row, cell } = prepared;
  const { sourceSegments, style, termBaseHit } = prepared.built;
  if (termBaseHit === null) throw new Error('finalizeFromTermBase without a Term Base hit');

  const segments: Segment[] = [{ k: 't', v: termBaseHit.translation }];
  const findings: Finding[] = validateSegments(sourceSegments, segments, {
    sourceLocale: project.sourceLocale,
    targetLocale: options.locale,
    severities: project.severities ?? DEFAULT_SEVERITIES,
    glossary: glossaryChecks(project.glossary ?? [], options.locale),
  });

  const response = commitTarget(projects, row, options.locale, segments, 'final', cell);
  projects.pruneHistory(options.rowId, options.locale);
  projects.clearMachineOrigin(options.rowId, options.locale);

  const run: TranslateRun = {
    at: new Date().toISOString(),
    model: 'Term Base',
    placeholderStyle: style,
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    finishReason: null,
    parse: 'termbase',
    confidence: null,
    notesForReviewer: null,
    raw: termBaseHit.translation,
  };

  return {
    ok: true,
    rowId: options.rowId,
    locale: options.locale,
    target: response.target,
    unsavedCount: response.unsavedCount,
    run,
    rejection: null,
    findings,
  };
}

/** `.lexi/state.json` and `.lexi/drafts.json`, after one unit or a whole batch. */
async function persistDrafting(deps: TranslateDeps): Promise<void> {
  const project = deps.projects.current;
  if (!project) return;
  await writeMachineOrigins(deps.cfg, project.path, deps.projects.machineOrigins);
  await writeDrafts(deps.cfg, deps.projects);
}

/* ---- FR-6.8: several units in one request -------------------------------- */

/** What happened to one unit of a batch — a result, or the error a single run would have thrown. */
export type BatchOutcome =
  | { readonly rowId: string; readonly result: TranslateUnitResponse }
  | { readonly rowId: string; readonly error: unknown };

export interface TranslateBatchOptions {
  readonly rowIds: readonly string[];
  readonly locale: string;
  readonly overwrite?: boolean | undefined;
  readonly instruction?: string | undefined;
}

/**
 * Draft several units with ONE request (FR-6.8), in the order given.
 *
 * Batching may only ever cost time, never correctness, so:
 *
 * - every unit is PREPARED exactly as a single run would be; a human
 *   translation in the way is a skip before the model is asked (FR-6.10);
 * - each item must come back under the key it was sent with. A missing,
 *   repeated or unknown key rejects exactly the units it concerns
 *   (`batch-misaligned`) and writes nothing for them — the misalignment requirements §6
 *   asks to be detectable is detected, never guessed around;
 * - an answer that is not readable as items at all, even after one stricter
 *   retry, or one cut off at the token ceiling, is not rejected: the batch
 *   falls back to one request per unit, so a model that cannot do batches still
 *   produces every draft it would have produced without them;
 * - every accepted item still goes through its own restore gate and checks.
 */
export async function translateBatch(
  deps: TranslateDeps,
  options: TranslateBatchOptions,
): Promise<BatchOutcome[]> {
  const outcomes = new Map<string, BatchOutcome>();
  const prepared: PreparedUnit[] = [];
  let answeredByTermBase = false;
  for (const rowId of options.rowIds) {
    try {
      const unit = await prepareUnit(deps, {
        rowId,
        locale: options.locale,
        overwrite: options.overwrite,
        instruction: options.instruction,
      });
      // A string the Term Base answers never joins the request: the model
      // would only be asked to repeat the entry, at a request's cost.
      if (unit.built.termBaseHit !== null) {
        outcomes.set(rowId, { rowId, result: finalizeFromTermBase(deps, unit) });
        answeredByTermBase = true;
      } else prepared.push(unit);
    } catch (error) {
      outcomes.set(rowId, { rowId, error });
    }
  }
  // The batch below persists again after its own commits; this covers a batch
  // the Term Base answered whole, and one whose request then fails.
  if (answeredByTermBase) await persistDrafting(deps);

  const single = async (p: PreparedUnit): Promise<void> => {
    try {
      outcomes.set(p.options.rowId, {
        rowId: p.options.rowId,
        result: await translateUnit(deps, p.options),
      });
    } catch (error) {
      outcomes.set(p.options.rowId, { rowId: p.options.rowId, error });
    }
  };

  if (prepared.length === 1) await single(prepared[0]!);
  else if (prepared.length > 1) {
    const project = deps.projects.current;
    if (!project) throw badRequest('no project is open');
    const { settings } = deps;
    const client = deps.client ?? createLlmClient(settings.endpoint);
    const model = modelOf(deps);
    const keys = prepared.map((_, i) => `u${i + 1}`);
    const batch = composeBatchPrompt(
      prepared.map((p) => p.built.prompt),
      keys,
      project.sourceLocale,
      options.locale,
    );
    const messages: ChatMessage[] = [
      { role: 'system', content: batch.system },
      { role: 'user', content: batch.user },
    ];
    // The ceiling is per REQUEST, and a batch answers N strings in one.
    const params = {
      ...settings.params,
      maxTokens: Math.min(
        settings.params.maxTokens * prepared.length,
        LLM_PARAM_LIMITS.maxTokens.max,
      ),
    };

    const started = new Date().toISOString();
    let answer = await chatOrExplain(client, messages, params);
    let items = parseBatchAnswer(answer.text);
    let mode: TranslateRun['parse'] = 'json';
    if (items === null && answer.finishReason !== 'length') {
      try {
        const retry = await client.chat(
          [
            ...messages,
            { role: 'assistant', content: answer.text },
            {
              role: 'user',
              content:
                'That was not valid JSON. Answer again with a single JSON object and nothing else, ' +
                `no code fences and no commentary, exactly matching: ${batch.schema}`,
            },
          ],
          params,
        );
        const second = parseBatchAnswer(retry.text);
        if (second !== null) {
          answer = { ...retry, latencyMs: answer.latencyMs + retry.latencyMs };
          items = second;
          mode = 'retried';
        }
      } catch {
        // As for a single unit: the retry is a courtesy, and the fallback below
        // still drafts every unit.
      }
    }

    // An answer that echoed no source at all ignored the half of the contract
    // that makes a batch safe to accept; it gets the same fallback as prose.
    const echoed =
      items !== null && [...items.values()].some((v) => v !== 'duplicate' && v.source !== null);
    if (items === null || !echoed || answer.finishReason === 'length') {
      for (const p of prepared) await single(p);
    } else {
      for (const [i, p] of prepared.entries()) {
        const key = keys[i]!;
        const got = items.get(key);
        const expected =
          p.built.prompt.mask?.masked ?? composeSegments(p.built.sourceSegments, 'angular');
        const misplaced =
          got !== undefined &&
          got !== 'duplicate' &&
          (got.source === null || !sameSource(got.source, expected));
        const found = misplaced ? undefined : got;
        const run: TranslateRun = {
          at: started,
          model,
          placeholderStyle: p.built.style,
          latencyMs: answer.latencyMs,
          promptTokens: answer.promptTokens,
          completionTokens: answer.completionTokens,
          reasoningTokens: answer.reasoningTokens,
          finishReason: answer.finishReason,
          parse: mode,
          confidence: found === undefined || found === 'duplicate' ? null : found.confidence,
          notesForReviewer: found === undefined || found === 'duplicate' ? null : found.notes,
          raw: answer.text,
          batch: { size: prepared.length, key },
          prompt: { system: batch.system, user: batch.user },
        };
        if (found === undefined || found === 'duplicate') {
          outcomes.set(p.options.rowId, {
            rowId: p.options.rowId,
            result: {
              ok: false,
              rowId: p.options.rowId,
              locale: options.locale,
              target: null,
              unsavedCount: deps.projects.unsavedCount,
              run,
              rejection: {
                reason: 'batch-misaligned',
                detail: misplaced
                  ? `The item under key ${key} names a different source string, so the model's ` +
                    `answers are out of step with the strings it was given. Nothing was written for this one.`
                  : found === undefined
                    ? `The model's answer had no item for key ${key}, so nothing was written for this string.`
                    : `The model's answer had key ${key} more than once, so it is not clear which is this string's translation. Nothing was written.`,
                missing: [],
                extra: [],
              },
              findings: [],
            },
          });
          continue;
        }
        try {
          outcomes.set(p.options.rowId, {
            rowId: p.options.rowId,
            result: finalizeUnit(deps, p, found.translation, run),
          });
        } catch (error) {
          outcomes.set(p.options.rowId, { rowId: p.options.rowId, error });
        }
      }
      await persistDrafting(deps);
    }
  }

  return options.rowIds.map(
    (rowId) => outcomes.get(rowId) ?? { rowId, error: new Error('not drafted') },
  );
}

type BatchItem = {
  translation: string;
  /** The source the model says this item translates — checked against the key's unit. */
  source: string | null;
  confidence: LlmConfidence | null;
  notes: string | null;
};

/** Whitespace- and case-insensitive: a model re-spacing the source is not a misalignment. */
const sameSource = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A batch answer as key → item, `'duplicate'` for a key that appears twice,
 * or null when there is no readable `items` array at all. Tolerant in the same
 * ways `parseAnswer` is — a code fence, commentary around the object — and
 * accepting a bare array or a key-to-item object as well, which is how models
 * most often bend this contract. An item without a string translation is
 * simply absent, so its unit is rejected rather than guessed at.
 */
export function parseBatchAnswer(text: string): Map<string, BatchItem | 'duplicate'> | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  const candidates = [trimmed, fenced, firstObject(trimmed), firstArray(trimmed)].filter(
    (c): c is string => c !== undefined && c !== null,
  );

  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const list: unknown[] | null = Array.isArray(value)
      ? value
      : typeof value === 'object' &&
          value !== null &&
          Array.isArray((value as { items?: unknown }).items)
        ? (value as { items: unknown[] }).items
        : typeof value === 'object' && value !== null
          ? Object.entries(value as Record<string, unknown>)
              .filter(([k, v]) => /^u\d+$/.test(k) && typeof v === 'object' && v !== null)
              .map(([k, v]) => ({ ...(v as object), key: k }))
          : null;
    if (list === null || list.length === 0) continue;

    const out = new Map<string, BatchItem | 'duplicate'>();
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const key = (entry as { key?: unknown }).key;
      const source = (entry as { source?: unknown }).source;
      const item = readObject(JSON.stringify(entry));
      if (typeof key !== 'string' || item === null) continue;
      out.set(
        key.trim(),
        out.has(key.trim())
          ? 'duplicate'
          : { ...item, source: typeof source === 'string' ? source : null },
      );
    }
    if (out.size > 0) return out;
  }
  return null;
}

/** The first balanced `[…]`, for a model that answered with a bare array. */
function firstArray(text: string): string | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  return start === -1 || end <= start ? null : text.slice(start, end + 1);
}

/**
 * A blank completion is the one rejection whose cause is worth guessing at.
 *
 * Every other `UnmaskFailureReason` points at something the MODEL got wrong —
 * a dropped token, invented markup — and `mask.ts`'s own sentence already
 * names it. `empty` is different: the model said nothing at all, and the
 * single most common reason a local server does that is silent — it ran out
 * of room. Many OpenAI-compatible servers do not error when a prompt plus
 * `max_tokens` would exceed the model's real context; they answer with zero
 * new tokens instead, which surfaces here as `content: ""`, indistinguishable
 * from the model simply refusing.
 *
 * This is a guess, not a diagnosis — the estimate is a character count, not a
 * real tokenizer (FR-5.4's own honesty rule) — so it is offered only when the
 * ESTIMATE is already over budget, and phrased as "likely why" rather than
 * asserted. Style guides are named first because they are the one thing that
 * makes an otherwise-working prompt cross that line: a user who saw
 * translation work with no style guide and stop the moment one was added is
 * seeing exactly this.
 */
function emptyAnswerDetail(
  reason: UnmaskFailureReason,
  detail: string,
  totals: PromptTotals,
): string {
  if (reason !== 'empty' || totals.tokens <= totals.contextWindow) return detail;
  return (
    `${detail} The composed prompt is an estimated ${totals.tokens.toLocaleString()} ` +
    `tokens against a configured ${totals.contextWindow.toLocaleString()}-token context window — ` +
    `likely why: once a prompt leaves no room for an answer, many local servers answer with ` +
    `nothing rather than an error. Shorten the style guides, or raise the context window in ` +
    `Settings to match what the model actually supports.`
  );
}

const sum = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

interface ParsedAnswer {
  readonly translation: string;
  readonly confidence: LlmConfidence | null;
  readonly notes: string | null;
  readonly mode: LlmParseMode;
}

const CONFIDENCES = new Set<string>(['high', 'medium', 'low']);

/**
 * Tolerant parsing (FR-6.9), in four descending steps.
 *
 * Local models fail the JSON contract in a small number of very predictable
 * ways, and each one has its own step so the run log can say WHICH — a model
 * that always needs the `fenced` path is a prompt problem, one that always
 * lands on `plain` is a model that should not be used for this at all.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const trimmed = text.trim();

  const direct = readObject(trimmed);
  if (direct !== null) return { ...direct, mode: 'json' };

  // ```json … ``` — by far the most common deviation, and the cheapest to undo.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  if (fenced !== undefined) {
    const inside = readObject(fenced.trim());
    if (inside !== null) return { ...inside, mode: 'fenced' };
  }

  // A JSON object with commentary around it. First balanced `{…}` wins.
  const embedded = firstObject(trimmed);
  if (embedded !== null) {
    const inside = readObject(embedded);
    if (inside !== null) return { ...inside, mode: 'embedded' };
  }

  // Last resort: the whole answer is the translation. Code fences are stripped
  // anyway, because a model that wrapped prose in them did not mean the ticks.
  const plain = fenced !== undefined ? fenced.trim() : trimmed;
  return { translation: plain, confidence: null, notes: null, mode: 'plain' };
}

function readObject(candidate: string): Omit<ParsedAnswer, 'mode'> | null {
  if (!candidate.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const translation = record['translation'];
  if (typeof translation !== 'string') return null;

  const confidence = record['confidence'];
  const notes = record['notes_for_reviewer'];
  return {
    translation,
    confidence:
      typeof confidence === 'string' && CONFIDENCES.has(confidence)
        ? (confidence as LlmConfidence)
        : null,
    notes: typeof notes === 'string' && notes.trim() !== '' ? notes.trim() : null,
  };
}

/**
 * The first balanced `{…}`, counting braces outside string literals.
 *
 * A regex cannot do this: `{"translation": "a } b"}` is one object and
 * `/\{[\s\S]*\}/` would match to the wrong brace in exactly the case that
 * matters — a translation containing one.
 */
function firstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
