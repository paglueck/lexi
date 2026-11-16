# Product requirements — Lexi

> These are the original product requirements Lexi was built against. The requirement ids
> (`FR-…`, `NFR-…`, `G…`) are cited throughout the code. Not everything listed here is built, and
> some decisions changed along the way — see the README's [Limitations](../README.md#limitations)
> for the current scope and [architecture.md](architecture.md) for how it is built.

**Date:** 2026-09-15
**Confirmed target stack:** Angular (`@angular/localize`, `ng extract-i18n --format=xlf`), XLIFF 1.2, `original="ng2.template"`, source language `en-GB`

---

## 1. Summary

A desktop application that lets teams manage the translations of their web UIs entirely on their own machines. It reads and writes XLIFF files, presents translation units in a key-by-locale grid, highlights what is missing against a chosen source locale, and can generate draft translations through a locally hosted LLM. Translation quality is steered by a layered style guide system (one global guide plus per-locale extensions) and by the context notes already carried inside the XLIFF files.

The product exists because the current alternatives are either cloud SaaS platforms (which means shipping product strings and business context to a third party) or hand-editing XML in a code editor (which is slow and error-prone). This tool targets the middle: a real translation UI with AI assistance, without anything leaving the machine.

---

## 2. Goals and non-goals

### 2.1 Goals

| # | Goal |
|---|---|
| G1 | Load a set of XLIFF files representing one product's locales and present them as a single, coherent project. |
| G2 | Make "what is still untranslated" answerable in under five seconds for any locale. |
| G3 | Let a translator or developer edit target strings safely, without breaking placeholders or inline markup. |
| G4 | Produce usable draft translations via a locally hosted LLM, with quality steered by style guides and notes. |
| G5 | Write XLIFF back out in a form that survives code review and diffs cleanly in Git. |
| G6 | Work fully offline. No account, no telemetry, no outbound network calls except to the user-configured LLM endpoint. |

### 2.2 Non-goals (for v1)

- Multi-user collaboration, real-time co-editing, or a shared server backend.
- Acting as a general CAT tool for document translation (Word, PDF, InDesign).
- Support for translation formats other than XLIFF in v1 (JSON/ARB/PO/properties are candidates for later).
- Integration with commercial MT providers (DeepL, Google) — architecturally allowed, not shipped.
- Managing the source strings themselves (extraction from code is the build pipeline's job).

---

## 3. Users and use cases

### 3.1 Personas

**Priya — Frontend developer.** Adds new keys to the source locale file as she builds features. Needs to see which of her new keys still have no translation, and wants to fire off machine drafts so the UI is not full of English fallbacks during QA.

**Marek — Localization owner / product manager.** Owns the style guides and the terminology list. Reviews and approves AI drafts. Cares about consistency of product terminology across ten locales.

**Sofia — Native-speaker reviewer (internal, part-time).** Opens the project for her locale only, works through a filtered list of "needs review" strings, edits and approves. Not technical; must never have to see XML.

### 3.2 Primary use cases

1. **Gap analysis.** "Show me every key that exists in `en` but has no translation in `de`."
2. **Bulk drafting.** "Generate drafts for all 140 untranslated German keys using our style guide, then let me review them."
3. **Contextual fix.** "This button label is too long in French. Show me the note explaining where it appears, and let me shorten it."
4. **Consistency audit.** "Find every locale where we translated *dashboard* inconsistently."
5. **Round-trip.** "Save everything back to the original XLIFF files so I can commit them."

---

## 4. Domain model and format support

### 4.1 Concepts

| Concept | Description |
|---|---|
| **Project** | A named workspace pointing at a directory (or explicit file list) of XLIFF files, plus its style guides, glossary, and LLM settings. |
| **Locale** | A BCP 47 language tag (`de`, `pt-BR`, `zh-Hant`). Backed by one or more XLIFF files. |
| **Source locale** | The locale treated as the truth for which keys should exist. User-selectable per project and switchable at any time. |
| **Translation unit** | One translatable string, identified by a stable key (`id` / `resname`). |
| **Key** | The identifier used to correlate the same string across locales. |
| **Note** | Free-text context attached to a unit (`<note>` in 1.2, `<notes><note>` in 2.0). Primary source of usage context for humans and the LLM. |
| **State** | Translation lifecycle status, mapped to the XLIFF state attribute. |
| **Style guide** | Markdown instructions injected into the LLM prompt. One global, plus optional per-locale extensions. |
| **Glossary** | Term → per-locale preferred translation, plus "do not translate" entries. |

### 4.2 XLIFF support

**v1 scope: XLIFF 1.2 as emitted by Angular, only.** XLIFF 2.0/2.1 support moves to *Could* and is deferred until there is a concrete need. The internal model should stay version-agnostic so 2.0 can be added later, but no 2.0 code ships in v1.

**Must support (XLIFF 1.2):** `<xliff>` with the default namespace `urn:oasis:names:tc:xliff:document:1.2` and no prefix, `<file>` with `original` / `datatype` / `source-language` / `target-language`, `<body>`, `<trans-unit>`, `<source>`, `<target>`, `<note>`, `<context-group>`, and the inline elements Angular emits.

### 4.2.1 Angular-specific structure

These are the things that actually shape the product, and they differ from generic XLIFF 1.2:

**Unit identity.** `<trans-unit id="…">` carries either an auto-generated content hash or a developer-assigned custom id from the `@@myId` syntax in the template. The hash is derived from the source text and the *meaning*, which has a consequence that drives several requirements below: **editing the English source text changes the id.** The old unit disappears and a new one appears. There is no rename signal in the file.

**Context lives in two places.** Angular writes:
- `<note priority="1" from="description">` — the developer's `i18n` description.
- `<note priority="1" from="meaning">` — the `meaning` half of the `meaning|description@@id` syntax, used to disambiguate homographs.
- `<context-group purpose="location">` containing `<context context-type="sourcefile">` and `<context context-type="linenumber">` — the template file and line where the string appears.

The source file location is genuine usage context and must be treated as a first-class context signal, not ignored metadata.

**`original="ng2.template"` is constant** across every file and every locale. It carries no information and must not be used for file identification or key namespacing.

**The extraction output has no `<target>` elements.** The file quoted above (`source-language="en-GB" target-language="en-GB"`) is the extraction template. Translation files are produced by copying it and adding targets. This means the app is frequently the thing *creating* `<target>` elements rather than editing them.

**`state` is not written by Angular's own tooling.** The widely used community tool `ng-extract-i18n-merge` does write `state` (`new` / `translated`, with `final` available), and Angular's runtime ignores it. Whether the project uses that tool is an open question (§13). The app must therefore:
- Read `state` if present and map it.
- Write `state` only if the project setting "write state attributes" is enabled, defaulting to *on* with the `new` / `translated` / `final` vocabulary, so the output stays compatible with that merge tool.
- Never depend on `state` for correctness — treat an absent `<target>` or an empty target as the authoritative "untranslated" signal.

**Must preserve on round-trip:**
- The default (unprefixed) namespace declaration exactly as written.
- Element and attribute order, `<context-group>` blocks, note `priority` and `from` attributes.
- Original encoding, line endings, and indentation (detected on read).
- All inline elements and their `equiv-text` / `ctype` attributes, byte for byte.

**Must preserve on round-trip:**
- Element order, attribute order where the parser allows, namespaces, `xml:space`, unknown/extension elements and attributes.
- Original encoding, line endings, and indentation style (detected on read).
- Inline markup: `<g>`, `<x/>`, `<bx/>`, `<ex/>`, `<ph>`, `<bpt>`, `<ept>`, `<pc>`, `<sc/>`, `<ec/>`, `<cp/>`.

**State mapping (normalized internal states):**

| Internal | Written as | Detected from |
|---|---|---|
| Untranslated | `state="new"` (or no `<target>` at all) | no `<target>`, empty target, `new`, `needs-translation` |
| Draft (machine) | `state="needs-review-translation"` | our own local database — see note below |
| Needs review | `state="needs-review-translation"` | `needs-review-translation`, `needs-l10n`, `needs-adaptation` |
| Reviewed | `state="translated"` | `translated` |
| Final | `state="final"` | `final`, `signed-off` |

XLIFF 1.2 has no `subState`, so "this came from the machine" cannot be distinguished from "a human wrote it and it needs review" using standard attributes alone. Two options, to be decided in M0:

- **(a) Local only.** Track machine origin in the SQLite store, keyed by file path + unit id. Clean files, but the signal is lost if another teammate opens the project on a different machine.
- **(b) Namespaced extension attribute.** Write something like `xmlns:lx="…" lx:origin="machine"` on the `<target>`. Survives Git and other machines. Risk: the Angular merge tool may strip unknown attributes on the next extraction round.

Recommendation: implement (a) for M2 and test whether (b) survives a full `ng extract-i18n` + merge cycle before committing to it.

### 4.3 Placeholder handling

Angular does **not** leave raw `{{ interpolation }}` in the source text. It replaces every dynamic part with an `<x/>` element, and this is what the app must handle:

| Pattern | Example | Meaning |
|---|---|---|
| Interpolation | `<x id="INTERPOLATION" equiv-text="{{ user.name }}"/>` | A bound expression. Subsequent ones are `INTERPOLATION_1`, `INTERPOLATION_2`, … |
| Element open | `<x id="START_TAG_SPAN" ctype="x-span" equiv-text="&lt;span&gt;"/>` | Opening HTML tag inside the translated block |
| Element close | `<x id="CLOSE_TAG_SPAN" ctype="x-span" equiv-text="&lt;/span&gt;"/>` | Matching closing tag |
| Line break | `<x id="LINE_BREAK" ctype="lb" equiv-text="&lt;br/&gt;"/>` | |
| ICU reference | `<x id="ICU" equiv-text="{count, plural, …}"/>` | Points at a **separate** `<trans-unit>` holding the ICU message |
| Raw ICU | `{VAR_PLURAL, plural, =1 {…} other {…}}` | Appears as literal text inside ICU units |

Requirements that follow:

| ID | Requirement | Priority |
|---|---|---|
| FR-PH-1 | Render every `<x/>` in the editor as an atomic, non-editable chip labelled with its `equiv-text` (falling back to its `id`). The translator can move and delete chips but never edit their internals. | Must |
| FR-PH-2 | Validate that the multiset of `<x/>` ids in the target matches the source exactly. A missing or invented id is an error, not a warning — it is a runtime failure in Angular. | Must |
| FR-PH-3 | Validate that `START_TAG_*` / `CLOSE_TAG_*` pairs are present and correctly nested in the target. | Must |
| FR-PH-4 | For ICU units: `VAR_PLURAL`, `VAR_SELECT`, the category keywords (`zero`, `one`, `two`, `few`, `many`, `other`), and explicit selectors (`=0`, `=1`) must survive untranslated; only the text inside each branch is translatable. Validate this structurally by parsing the ICU expression, not with a regex. | Must |
| FR-PH-5 | Warn when a target locale's CLDR plural categories differ from the source's and the target ICU does not cover them — e.g. `en-GB` has `one`/`other`, but Polish needs `one`/`few`/`many`/`other`, and Arabic needs six. This is one of the highest-value checks in the whole product and generic tools miss it. | Must |
| FR-PH-6 | When a unit contains `<x id="ICU"/>`, show the referenced ICU unit inline in the detail panel and let the user jump to it, rather than making them hunt for an opaque hash id. | Should |
| FR-PH-7 | The LLM prompt must list the exact `<x/>` ids and their `equiv-text` values, and instruct the model to reproduce the ids verbatim. Post-generation validation re-runs FR-PH-2 through FR-PH-5 and rejects the draft to a flagged state on failure. | Must |

---

## 5. Functional requirements

### 5.1 Project and file management

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | Create a project by selecting a directory; the app scans recursively for `.xlf` / `.xliff` files. | Must |
| FR-1.2 | Auto-detect the locale of each file from, in order: the filename (`messages.de.xlf`, `messages.pt-BR.xlf`), the parent directory name (`/de/messages.xlf`), then the `target-language` attribute. Filename takes priority over `target-language` because copied translation files routinely keep a stale `target-language`. `original` is ignored — Angular sets it to `ng2.template` everywhere. | Must |
| FR-1.2a | Identify the extraction template as the file where `source-language == target-language == en-GB` and no `<target>` elements exist. Offer it as the default source locale. | Must |
| FR-1.2b | Raise a startup warning when a file's `target-language` disagrees with its filename-derived locale, and offer to correct the attribute. This single check prevents the most common Angular i18n mistake. | Must |
| FR-1.3 | Show detected mappings in a confirmation step; allow manual override of file → locale. | Must |
| FR-1.4 | Support multiple XLIFF files per locale (e.g. split by feature module), keyed by file path so keys stay disambiguated. | Must |
| FR-1.5 | Detect external file changes (e.g. after `git pull`) and offer to reload, warning about unsaved edits. | Must |
| FR-1.6 | Save changes back to the original files. Never rewrite files that had no changes. | Must |
| FR-1.7 | Recent-projects list on the start screen. | Should |
| FR-1.8 | Project settings stored in a `.lexi/` folder inside the project directory so settings can be committed and shared. Secrets (if any) stored outside it. | Should |
| FR-1.9 | Handle a locale file missing entirely — offer to create it from the source locale skeleton. | Should |

### 5.2 Source locale and gap analysis

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | Select a source locale per project; persisted and changeable at any time. | Must |
| FR-2.2 | Compute, per locale: total keys, translated, untranslated, needs-review, keys missing entirely from the file, and orphan keys (present in the target but absent from the source). | Must |
| FR-2.3 | Display these counts as a per-locale progress overview on the project dashboard. | Must |
| FR-2.4 | A key counts as untranslated if the target is absent, empty, whitespace-only, or identical to the source while the locale differs from the source locale (the last case flagged separately as "possibly untranslated" since some strings legitimately match). | Must |
| FR-2.5 | **Re-hash reconciliation.** Because Angular derives unit ids from the source text, an English copy edit destroys the id and orphans every translation of that string. After a re-extraction, the app must pair up new units (no translations, unseen id) with orphan units (translations, id no longer in the source) by source-text similarity and `context-group` location match, and present the candidate pairs for confirmation. Confirming carries the old translations over into the new id at **Needs review** state, with the source diff shown so the reviewer can judge whether the change even affects the target language. | Must |
| FR-2.5a | Rank pairing candidates by combined score: source-text similarity, identical `sourcefile` + near line number, identical `from="meaning"` note. Never auto-apply above any threshold without confirmation — a wrong pairing silently ships a wrong translation. | Must |
| FR-2.5b | Where units use developer-assigned `@@customId`s, ids are stable and FR-2.5 does not apply; instead detect genuine source drift by comparing the stored source hash against the current source. Report the two id regimes separately on the dashboard, and surface the percentage of units using custom ids as a health metric. | Must |
| FR-2.6 | Offer bulk actions on remaining orphan keys after reconciliation: delete from target files, or keep and ignore. Deletion is opt-in and previewed. | Should |

### 5.3 Translation grid

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Main view is a virtualized table: one row per key, one column for the source text, and one column per selected target locale. Must stay responsive at 20,000 rows × 10 locale columns. | Must |
| FR-3.2 | Column chooser: pick which locales are visible; the choice is persisted per project. | Must |
| FR-3.3 | Two layout modes: **multi-locale grid** (compare locales side by side) and **single-locale focus** (source on the left, one target on the right, larger editing area, note panel always visible). Sofia's workflow is the focus mode. | Must |
| FR-3.4 | Filters: by locale, state, "untranslated only", "needs review only", "has validation errors", "stale", file, and key prefix/namespace. Filters combine with AND. | Must |
| FR-3.5 | Full-text search across keys, source text, target text, and notes, with a scope toggle. Incremental, under 200 ms on a 20k-unit project. | Must |
| FR-3.6 | Inline editing of target text. `Ctrl/Cmd+Enter` saves and moves to the next filtered row; `Esc` reverts. | Must |
| FR-3.7 | Visual state indicator per cell (color + icon + accessible text label — never color alone). | Must |
| FR-3.8 | Placeholder chips: placeholders render as non-editable tokens in the editor; a toolbar inserts any placeholder present in the source but missing from the target. | Must |
| FR-3.9 | Character and byte count, with an optional per-key max-length attribute honoured from XLIFF (`maxwidth` / `size-restriction`) and a warning when exceeded. | Should |
| FR-3.10 | Bidirectional text support: correct rendering and cursor behaviour for `ar`, `he`, `fa`, `ur`. Editor direction follows the target locale. | Must |
| FR-3.11 | Undo/redo across edits within a session. | Should |
| FR-3.12 | Copy source to target, for cases where the string is legitimately identical. | Should |

### 5.4 Notes and context

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | Display all notes attached to a unit, with their `from` and `priority` attributes where present. | Must |
| FR-4.2 | Edit, add, and delete notes; write them back to the source-locale file by default (context is language-independent) with an option to write per-locale notes. | Must |
| FR-4.3 | Distinguish Angular's two note kinds visually and treat them differently: `from="description"` is usage context for the translator; `from="meaning"` is a disambiguator that explains *which* sense of a homograph is intended. Both go into the LLM prompt, under distinct labels. | Must |
| FR-4.3a | Display the `<context-group purpose="location">` entries (source file + line number) in the detail panel as a compact "used in" list. Multiple location entries mean the string is shared across templates — flag this, because it constrains how freely it can be reworded. | Must |
| FR-4.3b | Include the source file path in the LLM prompt. A path like `src/app/checkout/payment-form.component.html` is cheap, reliable context that costs nothing to extract and meaningfully improves draft quality. | Must |
| FR-4.3c | Notes added in the app are written to the translation file being edited. Because Angular regenerates the extraction template on every build, notes written there will be overwritten — warn the user and point them at the `i18n` attribute in the template as the durable place to put context. | Must |
| FR-4.4 | Flag units that have no note at all, so the team can improve context coverage. Show note-coverage percentage on the dashboard. | Should |
| FR-4.5 | Notes are passed to the LLM as context (see §6). If a unit has no note, the prompt says so explicitly rather than omitting the field, so the model does not hallucinate context. | Must |

### 5.5 Style guides

| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | One **global style guide** per project: a Markdown document applying to all locales. | Must |
| FR-5.2 | Zero or more **locale extension guides**, each bound to one locale, containing only the additional or overriding instructions for that locale. | Must |
| FR-5.3 | Composition at prompt time: global guide first, then the locale extension, under clear headings, with an explicit instruction that locale-specific rules take precedence on conflict. | Must |
| FR-5.4 | Built-in Markdown editor with a live preview and a token-count estimate against the configured model's context window. | Must |
| FR-5.5 | Style guides stored as plain `.md` files in `.lexi/styleguides/` (`global.md`, `de.md`, `pt-BR.md`) so they are diffable and reviewable in Git. | Must |
| FR-5.6 | Starter templates for the global guide and a locale extension, covering the usual axes: formality/register, tone, capitalization, punctuation, date/number formats, placeholder rules, terminology handling, length constraints, and UI-specific conventions (button labels, error messages, empty states). | Should |
| FR-5.7 | Preview the fully composed prompt for a chosen unit and locale before running, so the user can see exactly what the model receives. | Must |
| FR-5.8 | **Glossary** as a structured table (term, per-locale translation, case-sensitive flag, do-not-translate flag, optional note). Stored as CSV or JSON in `.lexi/`. | Should |
| FR-5.9 | At prompt time, inject only the glossary entries whose source term appears in the string being translated, to keep prompts small. Fall back to the full glossary if it is under a configurable size. | Should |

### 5.6 LLM integration

| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | Configure a local LLM endpoint: base URL, API path style, model name, optional API key (many local servers accept a dummy key). | Must |
| FR-6.2 | Support the OpenAI-compatible `/v1/chat/completions` shape, which covers Ollama, LM Studio, llama.cpp server, vLLM, LocalAI, and Jan. Support Ollama's native `/api/chat` as a second adapter. | Must |
| FR-6.3 | "Test connection" button: verifies reachability, lists available models where the API supports it, and runs a trivial completion. | Must |
| FR-6.4 | Configurable generation parameters: temperature, top_p, max tokens, stop sequences, seed. Sensible low-temperature defaults for translation. | Must |
| FR-6.5 | Translate a single unit into a single locale, on demand from the grid. | Must |
| FR-6.6 | Batch translate: current filter selection, or an explicit multi-select, across one or many locales. | Must |
| FR-6.7 | Batch jobs run in the background with a visible queue: progress, current unit, per-unit success/failure, pause, resume, cancel. Cancelling stops after the in-flight request. | Must |
| FR-6.8 | Configurable concurrency (default 1–2, since local models are usually serialized on one GPU) and configurable units-per-request batching (default 1; batching >1 is faster but risks the model drifting or misaligning outputs). | Should |
| FR-6.9 | Structured output: the model is asked for JSON containing the translation plus an optional confidence signal and an optional note back to the reviewer. Parsing is tolerant — strip code fences, retry once with a stricter instruction, then fall back to treating the whole response as the translation. | Must |
| FR-6.10 | Every machine translation lands in **Draft (machine)** state. It is never written as final, and never silently overwrites an existing human translation — existing targets require an explicit "overwrite" confirmation. | Must |
| FR-6.11 | Post-generation validation runs automatically: placeholder integrity, glossary adherence, length limits, leading/trailing whitespace, and "did the model answer in the right language" (script/language detection heuristic). Failures are flagged, not discarded. | Must |
| FR-6.12 | Retry a single unit, optionally with an added instruction ("shorter", "more formal"), without leaving the grid. | Should |
| FR-6.13 | **Translation memory as few-shot examples:** find the N most similar already-approved units in the same locale (embedding or trigram similarity) and include them as examples. Toggleable. | Should |
| FR-6.14 | Per-run log: prompt sent, raw response, latency, token counts if reported. Viewable and exportable for debugging prompt quality. | Should |
| FR-6.15 | Hard guarantee: no network request to any host other than the configured LLM endpoint. Documented and, where the platform permits, enforced. | Must |

### 5.7 Review workflow

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | Review mode: filtered to machine drafts and needs-review units for one locale, one unit at a time, with source, note, style guide reminders, and validation warnings all visible. | Must |
| FR-7.2 | Keyboard-first: approve, edit, reject, skip, previous/next, all bound to single keys. | Must |
| FR-7.3 | Approve advances the state (Draft → Reviewed). Bulk approve for a filtered selection, behind a confirmation. | Must |
| FR-7.4 | An edit to a machine draft records that the string was corrected, feeding the "edit rate" metric in §10. | Should |
| FR-7.5 | Per-unit history: who/what changed the target, when, and from which state. Stored locally. | Should |

### 5.8 Validation and quality

| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | Validation rules: placeholder mismatch, inline-tag mismatch, empty target, target identical to source, leading/trailing whitespace difference, missing terminal punctuation relative to source, max length exceeded, glossary violation, do-not-translate term translated. | Must |
| FR-8.2 | Each rule configurable as error / warning / off, per project. | Should |
| FR-8.3 | A dedicated Issues view listing all validation findings across the project, grouped by rule, click-through to the unit. | Must |
| FR-8.4 | Saving with errors present is allowed (the file may be mid-work) but the user is warned and the affected units cannot reach Final state. | Must |

### 5.9 Import, export, interoperability

| ID | Requirement | Priority |
|---|---|---|
| FR-9.1 | Export the project status as CSV or XLSX (key, note, source, one column per locale, state). For stakeholders who live in spreadsheets. | Should |
| FR-9.2 | Import a filled-in spreadsheet back, with a diff preview before applying. | Could |
| FR-9.3 | Export translation memory as TMX. | Could |
| FR-9.4 | A headless CLI (`lexi check`, `lexi translate --locale de --untranslated`) for CI use. | Could |

---

## 6. LLM prompt architecture

The prompt is assembled deterministically from named blocks, in this order. The user can preview the result (FR-5.7).

**System message**

1. Role and task definition — a professional software UI localizer translating from `{sourceLocale}` to `{targetLocale}`.
2. Hard output contract — return only JSON matching the given schema; no commentary, no code fences.
3. Invariants that always apply — preserve every placeholder exactly, preserve inline markup, do not add or remove punctuation that changes meaning, do not translate anything inside protected tokens.
4. `## Global style guide` — verbatim contents of `global.md`.
5. `## Locale-specific style guide ({targetLocale})` — verbatim contents of the locale extension, prefixed by a statement that these rules override the global guide where they conflict.
6. `## Terminology` — matched glossary entries, rendered as a table with a do-not-translate column.

**User message**

```
Key: {key}
File: {relativeFilePath}
Context note: {notes joined, or "No context note was provided for this string."}
Max length: {maxwidth or "none"}
Placeholders that must appear unchanged in the output: {list or "none"}

Source ({sourceLocale}):
{sourceText}
```

**Optional few-shot block** (FR-6.13), inserted as prior user/assistant turns before the real request, drawn from approved translations in the same locale.

**Expected response**

```json
{
  "translation": "…",
  "confidence": "high | medium | low",
  "notes_for_reviewer": "optional, e.g. ambiguity in the source"
}
```

### Design notes

- The note field is deliberately given its own labelled line rather than being blended into prose, and the "no note provided" fallback is explicit. Local models under ~14B are prone to inventing context when a field is silently absent.
- Style guides are injected verbatim rather than summarized, so what the user wrote is what the model sees. The token-count estimate in FR-5.4 exists because a 4,000-token style guide plus few-shot examples will exceed the context window of some local setups.
- Batching multiple units per request (FR-6.8) must include the key in each item and require the key back in each response object, so misalignment is detectable rather than silent.

---

## 7. UX outline

### 7.1 Screens

1. **Start** — recent projects, open folder, new project.
2. **Project setup wizard** — folder scan results, file → locale mapping confirmation, source locale selection.
3. **Dashboard** — per-locale progress bars (translated / draft / needs review / untranslated), note coverage, open validation issues, quick actions ("translate all untranslated in `de`").
4. **Grid** — the main working surface. Left sidebar: files/namespaces tree and filters. Center: virtualized table. Right panel: selected unit detail — source, note editor, placeholder list, validation findings, per-locale targets, history, LLM actions.
5. **Focus / review mode** — single unit, single locale, keyboard-driven.
6. **Style guides** — tabbed editor: Global, then one tab per locale, plus the glossary table.
7. **Settings** — LLM endpoint and parameters, validation rule configuration, XLIFF output formatting (indentation, whether to write `<target>` elements for untranslated units), editor preferences.
8. **Jobs** — background translation queue with logs.

### 7.2 Principles

- The grid is the home screen after setup; everything else is reachable in one click from it.
- No raw XML is ever shown to the user, except in an explicit "view source" debug panel.
- Destructive actions (overwrite human translation, delete orphan keys, bulk approve) always confirm and are always undoable within the session.
- Keyboard shortcuts for every high-frequency action; the review loop must be completable without a mouse.
- Full dark and light themes; the app's own UI is localized (the team building a translation tool should eat its own cooking).
- Accessibility: keyboard navigable throughout, screen-reader labels on state indicators, WCAG AA contrast.

---

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Offline first.** All features except LLM generation work with no network at all. |
| NFR-2 | **Privacy.** No telemetry, no analytics, no crash reporting to a third party by default. Source strings never leave the machine. |
| NFR-3 | **Performance.** Open a project of 20 locales × 20,000 units in under 10 seconds. Grid scroll at 60 fps. Filter and search results under 200 ms. |
| NFR-4 | **Data safety.** Atomic writes (write temp, fsync, rename). Autosave of in-progress edits to the local database so a crash loses nothing. Never corrupt a source file. |
| NFR-5 | **Round-trip fidelity.** Opening a file and saving it with no edits produces a byte-identical file. This is a testable invariant and belongs in CI with a corpus of real-world XLIFF samples. |
| NFR-6 | **Platforms.** Windows, macOS (Apple Silicon and Intel), Linux. |
| NFR-7 | **Installability.** Signed installers; no runtime prerequisites for the end user. |
| NFR-8 | **Git friendliness.** Output formatting is stable and configurable; a one-word change produces a one-line diff. |

---

## 9. Technical approach (proposed, not binding)

- **Shell:** Tauri 2 (Rust core + web frontend). Chosen over Electron for a smaller binary, lower memory, and a stricter capability model that makes NFR-2 easier to defend. Electron is the fallback if the team's JS/TS expertise makes the Rust layer a cost.
- **Frontend:** TypeScript + React, TanStack Table + TanStack Virtual for the grid, Zustand or similar for state, Tailwind or CSS modules for styling.
- **XLIFF parsing:** a DOM-preserving parser rather than a schema-bound deserializer, because NFR-5 requires keeping unknown elements and formatting. Candidates: `quick-xml` with a custom preserving model (Rust side), or `fast-xml-parser` / `xmldom` with a custom writer (JS side). This is the single riskiest component — prototype it first.
- **Local store:** SQLite for the unit index, states, history, source hashes, and TM. The XLIFF files remain the source of truth; SQLite is a derived cache plus the home of metadata that does not fit in XLIFF.
- **LLM client:** a thin adapter interface with two implementations (OpenAI-compatible, Ollama native) so a third can be added without touching the prompt layer.
- **Similarity for TM:** trigram similarity to start (no dependencies, good enough); optional embeddings via the local endpoint if the server exposes an embeddings API.

---

## 10. Success metrics

| Metric | Target |
|---|---|
| Time to produce a reviewed translation for a new key, versus the current process | 50% reduction |
| Share of machine drafts approved without edit | ≥ 60% after the style guides have been tuned |
| Placeholder-breakage defects reaching production | 0 |
| Round-trip fidelity test pass rate on the sample corpus | 100% |
| Note coverage on new keys | ≥ 80% within two months of adoption |
| Time to answer "what is missing in locale X" | < 5 seconds |

---

## 11. Milestones

> **Note.** These are the original product-level phases. The build followed its own, finer
> milestone sequence (M1–M15), which code comments occasionally mention.

**M0 — Spike (1–2 weeks).** Four questions, all answerable with throwaway code:
1. Round-trip fidelity on real files from the repo — open and save unchanged, diff must be empty, including `<x/>` elements, `equiv-text` escaping, and the unprefixed namespace.
2. Does a full `ng extract-i18n` + merge cycle preserve a namespaced extension attribute on `<target>`? Decides the machine-origin question in §4.2.
3. Grid performance at target scale with synthetic data.
4. Does a local model reproduce `<x id="INTERPOLATION_1"/>` ids verbatim and keep ICU structure intact? Test across two or three model sizes; the answer determines whether §6 needs a chip-masking preprocessing step rather than raw markup in the prompt.

**M1 — MVP.** Project creation, locale detection, source locale selection, grid with filters and search, inline editing, gap analysis, save. No LLM. Usable as a better-than-a-text-editor tool from this point.

**M2 — LLM drafting.** Endpoint configuration, single and batch translation, job queue, draft state, post-generation validation, prompt preview.

**M3 — Style guides and glossary.** Global and locale guides, glossary matching and injection, templates, token estimation.

**M4 — Review and QA.** Focus/review mode, full validation rule set, Issues view, history, stale-translation detection.

**M5 — Polish and extras.** Translation memory few-shot, CSV/XLSX export, TMX export, CLI, additional format support.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| XLIFF round-trip fidelity is harder than expected; files get mangled | High — destroys trust immediately | M0 spike with a real-file corpus; fidelity test in CI; never rewrite unchanged files |
| Small local models produce poor or inconsistent translations, especially for low-resource locales | High — undermines the headline feature | Position output as *drafts* requiring review; measure edit rate per locale and model; document a recommended model size; make the endpoint swappable |
| Local models ignore the output format and return prose | Medium | Tolerant parsing, one stricter retry, graceful fallback; prefer models with structured-output or grammar support where the server exposes it |
| Style guides grow until they exceed the context window | Medium | Token estimation in the editor; glossary filtering rather than full injection; warn before running |
| Grid performance degrades on very large projects | Medium | Virtualization from day one; performance budget enforced in M0 |
| Locale detection guesses wrong and a user translates into the wrong file | High | Always show the mapping confirmation step; display the active locale prominently in the editor |
| Angular's content-hash ids churn on every English copy edit, orphaning translations en masse | High — a likely pain point for any team using Angular i18n | FR-2.5 reconciliation; separately, recommend adopting `@@customId` for new strings and track adoption as a health metric |
| Local models mangle `<x id="…"/>` elements, producing strings that crash the Angular runtime | High | Mask inline elements as simple numbered tokens before sending to the model and restore them after, rather than trusting the model with raw XML; hard validation gate on restore |
| Plural category coverage silently wrong for Slavic/Arabic locales — the string renders but the grammar is broken for some counts | Medium, easy to miss | FR-PH-5 CLDR category check as a blocking error |
| `ng-extract-i18n-merge` and this tool disagree about `state` and fight each other across commits | Medium | Make state writing configurable and match the merge tool's vocabulary; verify in the M0 cycle test |
| The two XLIFF versions diverge enough that features work in one and not the other | Medium | Normalize to an internal model early; feature matrix per version documented and tested |

---

## 13. Open questions

1. ~~Which XLIFF version?~~ **Answered:** XLIFF 1.2 from Angular. 2.0 support is out of v1 scope.
2. Is Git the distribution mechanism for style guides and glossary, or should they live outside the repo?
3. Which local inference server is standard on the team's machines — Ollama, LM Studio, something else? The default adapter should match.
4. ~~Length constraints via `maxwidth`?~~ **Answered by implication:** Angular does not emit `maxwidth`. Length guidance must come from the style guide and from per-key overrides stored locally in the app. Do you want a way to set a max length per key that is *not* written back to the XLIFF?
4a. Does the project use `ng-extract-i18n-merge` or an equivalent, and if so what is its `state` configuration? This decides §4.2's state-writing default.
4b. What share of strings currently use `@@customId` versus auto-generated hashes? If it is near zero, FR-2.5 reconciliation is the highest-value feature in the entire document and should move into M1.
4c. Are translation files kept in the same repo as the templates, and does the team run extraction on a schedule or ad hoc? Determines how often reconciliation runs.
5. How many locales and roughly how many keys, today and in twelve months? Drives the performance budget.
6. Do reviewers need to work on machines without the project repo checked out? If yes, an export/import round trip becomes a Must rather than a Should.
7. Is there an existing terminology list to seed the glossary?
8. Should the app ever write its own metadata (source hashes, machine-draft markers) into the XLIFF files as namespaced extensions, or keep everything in the local database? The former survives machine changes; the latter keeps the files clean.

---

## Appendix A — Example composed prompt

**System**

> You are a professional software localization specialist translating user interface strings from English (en) to German (de).
>
> Return only a single JSON object matching this schema, with no commentary and no code fences:
> `{"translation": string, "confidence": "high"|"medium"|"low", "notes_for_reviewer": string|null}`
>
> Always:
> - Reproduce every placeholder exactly as it appears in the source, including braces and casing. Never translate, reorder the internals of, or invent placeholders.
> - Preserve any inline markup tags unchanged.
> - Translate for the meaning in context, not word by word.
>
> ## Global style guide
> *(contents of global.md)*
>
> ## Locale-specific style guide (de)
> The following rules are specific to German and take precedence over the global style guide wherever the two conflict.
> *(contents of de.md)*
>
> ## Terminology
> | Source term | German | Do not translate |
> |---|---|---|
> | dashboard | Übersicht | no |
> | Workspace | Workspace | yes |

**User**

```
Unit id: 8f2c1a09b3e7d4562f1a
Used in: src/app/settings/billing/billing-summary.component.html (line 42)
Meaning: billing.period-summary
Description: Summary line shown above the invoice table on the billing settings page.
Max length: none

Placeholder tokens — reproduce each one exactly as written, in a position that
is natural for German. Do not translate their contents.
  [[0]] = {{ invoiceCount }}
  [[1]] = <strong>
  [[2]] = </strong>

Source (en-GB):
You have [[1]][[0]] invoices[[2]] in this period
```

Note the masking: the app substitutes each `<x/>` element with a `[[n]]` token before sending, and restores the original XML afterwards. Local models handle short bracketed tokens far more reliably than they handle `<x id="START_TAG_STRONG" ctype="x-strong" equiv-text="&lt;strong&gt;"/>`, and restoration is a mechanical lookup that either succeeds completely or fails loudly. Confirm this in the M0 spike before committing to it.

---

## Appendix B — Suggested global style guide skeleton

```markdown
# Global style guide

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
```

## Appendix C — Suggested locale extension skeleton

```markdown
# German (de) — style guide extension

> These rules extend and, where they conflict, override the global style guide.

## Form of address
## Compound nouns
## Gender-inclusive language
## Capitalization specifics
## Quotation marks
## Number and date formats
## Terms that stay in English
## Known length pitfalls
```