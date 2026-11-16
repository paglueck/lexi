# Architecture

How Lexi is put together, and the handful of decisions that are easy to undo by accident. For
what Lexi is supposed to do, see [requirements.md](requirements.md); the `FR-…` and `NFR-…` ids
in code comments refer to it.

## Layout

An npm workspaces monorepo:

```
bin/lexi.mjs          the CLI: lexi [path] [--port 4317] [--no-open]; runs the bundled server
packages/xliff/       the engine: scanning, segments, ICU, validation, masking, splice writing.
                      No I/O except save.ts, no network
packages/shared/      the wire contract: zod schemas, plus a zod-free constants entry point
apps/server/          Fastify 5 on 127.0.0.1: security, fs jail, the unit index, the save path,
                      the file watcher, SSE, settings, prompt composition, jobs, Phrase
apps/web/             Angular 22 SPA: token layer, component kit, grid, editor, dashboard,
                      review, issues, style guides, term base, jobs, settings
apps/desktop/         Electron shell around the same server and SPA
scripts/dev.mjs       server + ng serve, with a readiness gate between them
testdata/northwind/   a small synthetic Angular project to open
```

`packages/shared` is load-bearing: every API payload is a zod schema there, the server validates
with it, and the client imports the inferred types, so there is one definition and no drift. The
vocabularies the engine owns (`Segment`, `UnitState`, `Finding`) are *mirrored* in shared rather
than re-exported, and `packages/shared/test/xliff-compat.test.ts` asserts the mirrors stay equal.
The client imports runtime values only from `@lexi/shared/constants` and types with
`import type`, which keeps zod out of the browser bundle entirely.

Development runs `tsx watch` for the server on `127.0.0.1:4317` plus `ng serve` proxying `/api`.
Production builds the SPA into `apps/server/public/`, which `@fastify/static` serves with an SPA
fallback.

## The engine: round trips by splicing

Opening a file and saving it unchanged must produce byte-identical output (NFR-5), and a one-word
change must be a one-line diff (NFR-8). The usual parse → object model → serialize route
practically never achieves the first, because `escape(decode(x))` does not generally equal `x`:
`&#39;` decodes to `'` and re-encodes to `&apos;`.

**The original file text is the truth; changes are spliced into it.**

1. Read the file as a UTF-8 string, keep the raw text and the SHA-256 of its bytes.
2. Parse with `htmlparser2` in `xmlMode`, used strictly as an **offset oracle**. Decoded values
   feed semantics only (ids, `equiv-text`, search haystacks); every byte written back comes from
   `raw.slice(span.start, span.end)`.
3. Record exact spans: `<source>` content, `<target>` content or its insertion point, the `state`
   attribute, notes, context groups.
4. Write through a single `applyEdits()` with an overlap assertion. No caller splices directly.

`applyEdits(raw, []) === raw` holds by construction, so the identity round trip is a property of
the design rather than something tests have to keep defending.

Further points worth not re-deriving:

- **Segments are computed on demand.** At twenty locales by twenty thousand units, eager segment
  arrays would run to hundreds of megabytes.
- **A placeholder segment carries its original bytes (`raw`).** There is no `<x/>` serializer.
  Attribute order, quotes and escaping survive because they are copied, never regenerated.
- **The ICU parser consumes segments, not a string.** Angular emits `<x/>` inside plural
  branches, so placeholders are flattened to NUL-delimited sentinels (NUL is illegal in XML, so
  this cannot collide) before the braces are parsed.
- **The editor never sees a byte of the file.** The client works in ids and text; the server
  re-attaches each placeholder's original tag text by id when it writes.

### Parser facts the engine relies on

Verified against `htmlparser2` 12 in `xmlMode`:

- `parser.endIndex` is **inclusive**; every span is `{ start: startIndex, end: endIndex + 1 }`.
- `ontext` fragments around entities, so text runs are coalesced by span adjacency, never by
  callback boundary or `text.length`.
- Unknown entities such as `&nbsp;` pass through undecoded instead of throwing, so a hand-edited
  file stays openable (the reason `saxes` was rejected).
- The XML declaration's processing-instruction span is off by one, so the scanner skips to the
  root element and leaves the prolog as untouched prefix.
- A BOM arrives as a text node and CRLF is preserved in whitespace nodes, so both round-trip for
  free and line endings and indentation can be detected from the spans.
- The parser is non-validating and never resolves DTDs or external entities.

### Angular's output shape

Read from `@angular/compiler` 22 (`Xliff.write`, `_ESCAPED_CHARS`):

- All five predefined entities (`& " ' < >`) are escaped in text **and** attributes. Lexi's
  `angular` escape policy matches, or every edited apostrophe would churn on the next extraction.
- Two spaces of indentation per level, every element on its own line, except `<source>`, whose
  content is inline. That inline `<source>` is what makes a target edit a one-line diff.
- The prolog has a space before `?>`; empty elements are self-closing.
- Angular itself never writes `target-language` or `<target>`; those come from merge tooling or
  from Lexi.

The fixture generators (`scripts/make-testdata.mjs`, `packages/xliff/test/fixtures.ts`) produce
this shape by hand and never through Lexi's own writer, so round-trip tests cannot be circular.

## The server

### Security model

A local web app means an HTTP server on localhost that any open web page can reach. One
`onRequest` hook runs five checks before any route that touches the filesystem:

1. **A `Host` allowlist.** This is the check that actually defeats DNS rebinding: when
   `evil.com` re-resolves to `127.0.0.1`, the browser believes it is same-origin and sends
   `Sec-Fetch-Site: same-origin` and, on a GET, no `Origin` at all. `Host: evil.com:4317` still
   gives it away. It is also the only check that covers `index.html`, where the token is handed
   out.
2. **Loopback binding**: `127.0.0.1` only, never `0.0.0.0`.
3. **`Sec-Fetch-Site`** must be `same-origin` when present.
4. **`Origin`**, when present, must be ours.
5. **A random per-process token**, injected into `index.html` and required as `X-Lexi-Token` on
   every `/api` call (`/api/events` takes it as a query parameter, because `EventSource` cannot
   set headers). Under `ng serve` the client falls back to a fixed dev token, which
   `scripts/dev.mjs` pairs with `LEXI_DEV=1`.

File access is jailed: paths are resolved and realpath'd, `..` escapes, symlinks out of the root
and prefix-collision siblings are refused, and `resolveForCreate` jail-checks the nearest
existing ancestor for files that do not exist yet. The roots are granted at boot: the home
directory plus any path given on the command line.

The page's CSP carries `connect-src 'self'`, so the browser cannot make outbound requests. On the
server, every request to a translation endpoint goes through one function in
`services/llm-client.ts` that checks the target origin and refuses redirects; ESLint forbids
`fetch` anywhere else under `apps/server/src`. The API key and the Phrase token never reach the
browser, and `~/.lexi/settings.json` is written with mode `0600`.

### Saving

Edits live in an overlay until **Save**; nothing is on disk before that. The overlay is persisted
to `.lexi/drafts.json` before a PATCH returns, so uncommitted work survives a crash. On save, the
segments are composed and run through the real scanner before splicing, and a target whose
placeholders do not match the source is refused. An editor bug therefore cannot damage a file.
Writes are atomic (temp file, fsync, rename), and a file that changed on disk since it was loaded
is refused rather than overwritten.

The file watcher compares bytes, not mtimes, so Lexi's own save never raises a reload banner, and
a reload re-attaches unsaved edits to the new bytes and reports how many could not be kept.

### Prompts and jobs

Prompt composition happens entirely on the server (`services/prompt.ts`, block order from
requirements §6); the client renders the returned blocks, so the preview cannot diverge from what
is sent. Placeholders are masked as `[[n]]` tokens before a string goes to the model and restored
through six gates afterwards; an answer that fails any gate writes nothing. A human translation is
never overwritten without explicit consent.

Jobs run in-process with configurable concurrency. Pause and cancel take effect between requests.
Every request and response is logged to `.lexi/logs/<jobId>.jsonl`.

### Persistence

No database: the server holds the project in memory, and only readable files persist.

```
<project>/.lexi/
  project.json        file → locale mapping, file groups, source locale, columns, filters,
                      rule severities, write-state mode
  styleguides/        global.md, de.md, …
  termbase.csv        see termbase-csv.md
  sources.json        unit id → hash of its source text
  state.json          which targets a model wrote, and what they replaced
  review-notes.json   reviewers' reject reasons
  ignored-findings.json  findings ignored on the Issues screen; expire when the source changes
  drafts.json         unsaved edits (gitignored)
  review-stats.json   edit-rate counters (gitignored)
  logs/               job run logs (gitignored)
~/.lexi/
  settings.json       endpoint, model parameters, keys, theme (0600)
  recents.json
```

### Events

One multiplexed SSE stream (`/api/events`) carries file changes, job progress and save
notifications; HTTP/1.1 allows only about six connections per origin. Three things keep it
unbuffered through proxies and should not be removed casually: a 2 KB comment padding write on
connect, `cache-control: no-cache, no-store, no-transform` with `x-accel-buffering: no`, and, in
`apps/web/proxy.conf.mjs`, `changeOrigin: true` (or the Host allowlist rejects the proxied
request) with the proxy timeouts set to 0.

## The web app

Standalone components, zoneless change detection and `OnPush` (both Angular 22 defaults, so they
appear nowhere in the code). Angular CDK for scrolling, overlays and a11y; no Angular Material.
State lives in a handful of root-provided store classes holding signals; there is no state
library.

### Token layer

Plain CSS custom properties in two layers: a raw palette (`--p-…`) that components never
reference, and semantic tokens (`--lx-…`) defined once per theme. Stylelint enforces the
separation and forbids raw hex under `src/app`; a spec asserts every token exists in both themes.
One CSS block maps each translation state onto a local ramp, which is why one state badge
component covers every state and grid tinting costs no JavaScript.

Fonts are self-hosted (`apps/web/scripts/generate-fonts-css.mjs`): Public Sans and IBM Plex Mono,
with Noto Sans families covering Cyrillic, Greek, Arabic and Hebrew. CJK uses the system font.

### Grid performance

The grid is a CDK virtual scroll viewport with fixed 34 px rows. Before it was built, its row
shape was benchmarked at 20,000 rows × 10 locale columns with a scripted fling of about 165 rows
per frame: about 60 fps median and no dropped frames on Apple Silicon. A control run with 30 ms
of injected main-thread load dropped to 20 fps, proving the probe reports failure. These rules
are what that result depends on:

1. **One component per row; cells are not components.** Twelve columns by ~45 visible rows would
   otherwise churn 540 instances per fling.
2. **All colour through `[attr.data-state]` / `[attr.data-error]`.** No `ngClass`, `ngStyle` or
   object literals in the row template.
3. **Placeholders as raw `<span class="lx-chip">`.** The kit's chip component declares no styles
   of its own, so both render identically (asserted by specs).
4. **`contain: layout style paint` on the row**, not `content-visibility: auto`.
5. **Column widths are one custom property** (`--lx-grid-cols`), and the header, which sits
   outside the viewport, is synced imperatively in a passive scroll listener rather than through
   a signal.

Data is a hybrid. The client owns the ordered id list (`POST /api/units/query`, about 300 kB for
20k ids over loopback), which gives exact scroll height and instant selection arithmetic. The
server owns the row bodies (`POST /api/units/rows`), fetched in windows of 200 with prefetch into
an LRU of about 2,000 rows. Cells arrive pre-segmented and are never parsed at render time.

### Segment editor

`contenteditable` with `contenteditable="false"` placeholder chips. Arrow keys step over a chip,
Backspace and Delete remove it whole, paste is always plain text (with a private MIME type so an
in-app copy keeps its chips), and Enter commits. **IME decides the shape of the component**: any
re-render during a composition destroys it, so the DOM is written once per external value change
and is otherwise uncontrolled. Chips carry `unicode-bidi: isolate`, so placeholders do not
scramble inside right-to-left text. Never `[innerHTML]`, never `document.execCommand`.

Caret movement, `beforeinput` and composition cannot be tested honestly in jsdom, so they were
verified with real keystrokes in Chrome, where the gate passed. Safari, Firefox and a real IME
have not been verified. If chips misbehave, the plain-text mode (`[[0]]` tokens in a textarea) is
always available from Settings → Editor. Exactly one editor instance is mounted at a time.

### Development pages

`/dev/kitchen-sink` renders every kit component in every variant, dark and light side by side. It
ships in production builds on purpose, so a design review can run against any build.

## Desktop app

`apps/desktop` wraps the same server and SPA in Electron. The main process picks a port, starts
the server in-process and opens a window on `http://127.0.0.1:<port>/`; there is no preload and
no Node in the renderer, and links leaving Lexi's origin open in the system browser. Settings are
shared with the CLI through `~/.lexi`.

`scripts/stage-desktop.mjs` assembles `apps/desktop/.stage/` for electron-builder:

- `app/`: the asar (main process, port helpers).
- `server/`: the server bundle and the SPA, outside the asar, because the Copilot SDK spawns a
  native runtime that cannot run from inside one. The SDK is installed fresh for the target
  platform, so a Mac can stage a Windows build.
- `legal/`: `LICENSE` (GPLv3), `NOTICE.txt` and the third-party notices.

Icons are generated from `apps/desktop/build/icon-source.png` by `scripts/generate-icons.py`. The
builds are ad-hoc signed on macOS and unsigned on Windows.

## Testing

Vitest everywhere, with the Angular unit-test builder for `apps/web`. Most tests are written as
invariants rather than per file. Some examples:

- **Engine:** every fixture round-trips byte-identically and stays identical on a second pass;
  one changed word changes exactly one line; target creation inserts whole lines with the right
  indentation and line ending; an atomic write that fails leaves the original untouched; files
  are covered for BOM / no BOM × CRLF / LF × trailing newline.
- **Server:** driven through `app.inject()`, which can forge `Host`, `Origin` and
  `Sec-Fetch-Site`, so every security check has a refusing case; SSE tests use a real socket.
  Real HTTP servers stand in for the translation endpoint, to prove redirects are refused and
  that no other host is ever contacted.
- **Web:** focus and ARIA contracts for every composite widget, theme-token parity, the grid
  emitting raw chip markup with no inline styles, and the client never receiving file bytes.
- **Performance:** `apps/server/test/units-perf.test.ts` asserts the NFR-3 budgets against a
  generated 20k × 10 corpus (`npm run corpus:large` produces the same corpus for manual runs).
