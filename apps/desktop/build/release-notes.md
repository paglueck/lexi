The first public release of Lexi, a local translation manager. This release works with the XLIFF 1.2 files Angular produces; more translation file formats are planned. Free software under the GNU GPL v3 or later.

- Your files stay yours: Lexi splices edits into the original XLIFF instead of regenerating it, so a one-word edit is a one-line diff and placeholders keep their bytes.
- Grid across all locales with filters, search and tens of thousands of units; a placeholder-safe editor with RTL support and undo/redo.
- Dashboard with coverage per locale, open issues and the share of machine drafts accepted without edit.
- Validation of placeholders, ICU syntax, CLDR plurals, whitespace and glossary terms, with one-click fixes on the Issues screen.
- Machine drafts from any OpenAI-compatible endpoint (including local models) or GitHub Copilot, one unit at a time or as background jobs with reports.
- Review queue for machine drafts with word diffs, checks and keyboard shortcuts to accept, reject or correct.
- Style guides and a term base, optionally shared across projects through a Git repository.
- Push to Phrase Strings using the project's .phrase.yml.
- Local first: no account, no telemetry; the desktop app checks GitHub for updates.
