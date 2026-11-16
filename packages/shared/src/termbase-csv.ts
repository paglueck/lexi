// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CsvDelimiter } from './constants.js';
import type { Term, TermImportMode, TermImportRow } from './termbase.js';

/**
 * The Term Base's CSV — the file on disk (`.lexi/termbase.csv`) and the file a
 * user imports are the same format, so one parser reads both.
 *
 * Zod-free and Node-free, like `constants.ts`: the import dialog parses and
 * previews in the browser, and the server applies the same `applyImport` to the
 * file it just read, so the preview cannot promise a result the write does not
 * produce.
 *
 * Format: a required header row `term,note,dnt,<locale>…`. The stored file adds
 * a leading `id` column; an imported file may carry one and it is ignored —
 * imports match on the term.
 */

/* ---- RFC 4180 --------------------------------------------------------------- */

/**
 * Parse RFC 4180 CSV: quoted fields, `""` as an escaped quote, a comma, CR or
 * LF inside quotes kept literally, CRLF or LF between records, a UTF-8 BOM
 * dropped. Blank lines are skipped — a trailing newline is not an empty row.
 *
 * `delimiter` defaults to a comma. A file Excel re-saved in a European locale
 * comes back with `;`, so the review import reads the delimiter off the file
 * (`detectDelimiter`) and passes it here.
 */
export function parseCsv(text: string, delimiter: CsvDelimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endRow = (): void => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Which delimiter a file uses, read off its first record. Excel rewrites the
 * delimiter to the system's list separator on save, so a file that left as `;`
 * can return as `,` and the other way round; guessing from the header is the
 * only signal there is. Delimiters inside quotes are not counted, or a header
 * like `"Unit; ID"` would flip the answer. A tie, or a file with neither, is
 * a comma.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let semicolons = 0;
  let commas = 0;
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '\r' || ch === '\n') break;
    else if (ch === ';') semicolons += 1;
    else if (ch === ',') commas += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * The inverse: quote only where a field needs it, CRLF between records (RFC 4180).
 * `delimiter` is `;` for a file meant for European Excel, which splits on that.
 */
export function stringifyCsv(rows: readonly (readonly string[])[], delimiter = ','): string {
  return (
    rows.map((r) => r.map((v) => quoteField(v, delimiter)).join(delimiter)).join('\r\n') + '\r\n'
  );
}

function quoteField(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) || value !== value.trim()
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

/* ---- Terms ↔ CSV ------------------------------------------------------------ */

const FIXED_COLUMNS = ['id', 'term', 'note', 'dnt'] as const;

/** `dnt` accepts yes/no, true/false or 1/0; anything else is an error. */
export function parseDnt(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'no' || v === 'false' || v === '0') return false;
  if (v === 'yes' || v === 'true' || v === '1') return true;
  return null;
}

/**
 * The stored file. Locale columns in project order, then any locale a row still
 * holds a translation for that is no longer a project locale — removing a
 * locale from the project must not quietly delete its column from the file.
 */
export function termsToCsv(terms: readonly Term[], locales: readonly string[]): string {
  const extra = new Set<string>();
  for (const t of terms) {
    for (const [code, value] of Object.entries(t.translations)) {
      if (value !== '' && !locales.includes(code)) extra.add(code);
    }
  }
  const columns = [...locales, ...[...extra].sort()];
  const header = [...FIXED_COLUMNS, ...columns];
  const body = terms.map((t) => [
    t.id,
    t.term,
    t.note,
    t.dnt ? 'yes' : 'no',
    ...columns.map((c) => t.translations[c] ?? ''),
  ]);
  return stringifyCsv([header, ...body]);
}

export interface ParsedTermCsv {
  readonly rows: readonly (TermImportRow & { readonly id?: string })[];
  /** Header columns that are understood: the fixed ones and project locales. */
  readonly recognised: readonly string[];
  /** Header columns that look like locales but are not project locales. */
  readonly ignored: readonly string[];
  /** Human-readable problems. A file with errors imports nothing. */
  readonly errors: readonly string[];
}

/**
 * Read a term CSV.
 *
 * `locales` is the set of columns that become translations; every other
 * column is reported in `ignored`. Pass `null` to keep every column (the
 * stored file, where an unknown locale is data to preserve, not to drop).
 *
 * A DNT row's locale cells are dropped: the README's rule is that DNT rows
 * ignore them, and importing them would bring translations back the moment
 * someone switches DNT off — translations nobody saw on import.
 *
 * `stored` reads the Term Base's own file instead: DNT translations are kept
 * (they are exactly what DNT is meant to preserve), and an untitled row —
 * "Add term" before it is named — survives rather than being an error.
 */
export function parseTermCsv(
  text: string,
  locales: readonly string[] | null,
  { stored = false }: { stored?: boolean } = {},
): ParsedTermCsv {
  const records = parseCsv(text);
  const header = (records[0] ?? []).map((h) => h.trim());
  const errors: string[] = [];
  if (!header.includes('term')) {
    return {
      rows: [],
      recognised: [],
      ignored: [],
      errors: ['The header row needs a "term" column.'],
    };
  }

  const fixed = new Set<string>(FIXED_COLUMNS);
  const recognised: string[] = [];
  const ignored: string[] = [];
  const localeAt = new Map<number, string>();
  header.forEach((h, i) => {
    if (h === '') return;
    if (fixed.has(h.toLowerCase())) {
      recognised.push(h.toLowerCase());
    } else if (locales === null || locales.includes(h)) {
      recognised.push(h);
      localeAt.set(i, h);
    } else {
      ignored.push(h);
    }
  });
  const col = (name: string): number => header.findIndex((h) => h.toLowerCase() === name);
  const [idCol, termCol, noteCol, dntCol] = FIXED_COLUMNS.map(col) as [
    number,
    number,
    number,
    number,
  ];

  const rows: (TermImportRow & { id?: string })[] = [];
  const seen = new Set<string>();
  records.slice(1).forEach((record, i) => {
    const line = i + 2;
    const cell = (at: number): string => (at === -1 ? '' : (record[at] ?? ''));
    const term = cell(termCol).trim();
    if (term === '' && !(stored && cell(idCol).trim() !== '')) {
      if (record.some((v) => v.trim() !== '')) errors.push(`Line ${line}: the term is empty.`);
      return;
    }
    const dnt = parseDnt(cell(dntCol));
    if (dnt === null) {
      errors.push(`Line ${line}: dnt must be yes/no, true/false or 1/0, not "${cell(dntCol)}".`);
      return;
    }
    const key = term.toLowerCase();
    if (!stored && seen.has(key)) {
      errors.push(`Line ${line}: "${term}" appears more than once.`);
      return;
    }
    seen.add(key);

    const translations: Record<string, string> = {};
    if (!dnt || stored) {
      for (const [at, code] of localeAt) {
        const value = cell(at).trim();
        if (value !== '') translations[code] = value;
      }
    }
    const id = cell(idCol).trim();
    rows.push({
      term,
      note: cell(noteCol).trim(),
      dnt,
      translations,
      ...(id === '' ? {} : { id }),
    });
  });

  return { rows, recognised, ignored, errors };
}

/* ---- Import ------------------------------------------------------------------ */

export type ImportStatus = 'new' | 'update' | 'unchanged';

export interface ImportPreviewRow {
  readonly row: TermImportRow;
  readonly status: ImportStatus;
  /** The existing term this row matched, by term, case-insensitively. */
  readonly existingId: string | null;
  /** Locales whose value differs from the existing term's. */
  readonly changedLocales: readonly string[];
  /** The note or the DNT flag differs. */
  readonly metaChanged: boolean;
}

/** One locale's effective value: trimmed, empty when absent. */
export const localeValue = (translations: Readonly<Record<string, string>>, code: string): string =>
  (translations[code] ?? '').trim();

/**
 * What importing `rows` would do to `existing` — the preview table.
 *
 * "Update" means the note, DNT or any of `locales` differs. Pass the locale
 * columns the FILE carried: a locale without a column is not "empty" in the
 * file, it is not in the file at all.
 */
export function diffImport(
  existing: readonly Term[],
  rows: readonly TermImportRow[],
  locales: readonly string[],
): ImportPreviewRow[] {
  const byTerm = new Map(existing.map((t) => [t.term.trim().toLowerCase(), t] as const));
  return rows.map((row) => {
    const match = byTerm.get(row.term.toLowerCase());
    if (match === undefined) {
      return { row, status: 'new', existingId: null, changedLocales: [], metaChanged: false };
    }
    // A DNT row carries no locale cells, so its locales say nothing about change.
    const changedLocales = row.dnt
      ? []
      : locales.filter(
          (c) => localeValue(match.translations, c) !== localeValue(row.translations, c),
        );
    const metaChanged = match.dnt !== row.dnt || match.note.trim() !== row.note.trim();
    const status: ImportStatus = changedLocales.length > 0 || metaChanged ? 'update' : 'unchanged';
    return { row, status, existingId: match.id, changedLocales, metaChanged };
  });
}

/**
 * Apply an import: new terms go to the top in file order; an update replaces
 * the term's fields only in `overwrite` mode.
 *
 * An overwritten DNT row keeps the translations the existing term already
 * stored, for the same reason toggling DNT does: they are locked, not deleted.
 * A non-DNT row replaces the project locales and leaves any other locale's
 * value alone, since the file could not have said anything about it.
 */
export function applyImport(
  existing: readonly Term[],
  rows: readonly TermImportRow[],
  locales: readonly string[],
  mode: TermImportMode,
  newId: () => string,
): { terms: Term[]; added: number; updated: number; unchanged: number } {
  const preview = diffImport(existing, rows, locales);
  const added: Term[] = [];
  const updates = new Map<string, TermImportRow>();
  let unchanged = 0;
  for (const p of preview) {
    if (p.status === 'new')
      added.push({ id: newId(), ...p.row, translations: { ...p.row.translations } });
    else if (p.status === 'update' && mode === 'overwrite' && p.existingId !== null)
      updates.set(p.existingId, p.row);
    else unchanged += 1;
  }

  const terms = existing.map((t) => {
    const row = updates.get(t.id);
    if (row === undefined) return t;
    let translations = t.translations;
    if (!row.dnt) {
      translations = Object.fromEntries(
        Object.entries(t.translations).filter(([code]) => !locales.includes(code)),
      );
      Object.assign(translations, row.translations);
    }
    return { ...t, note: row.note, dnt: row.dnt, translations };
  });

  return { terms: [...added, ...terms], added: added.length, updated: updates.size, unchanged };
}

/* ---- The prompt line --------------------------------------------------------- */

/** What one prompt line needs: the term with its translation already resolved. */
export interface PromptLineTerm {
  readonly term: string;
  readonly translation: string;
  readonly dnt: boolean;
  readonly note: string;
}

/**
 * The line a term contributes to the prompt's terminology list. The editor's
 * "Prompt line" preview renders this same function, so what it shows is what
 * the model reads.
 */
export function termPromptLine(t: PromptLineTerm, locale: string): string {
  const note = t.note.trim() === '' ? '' : ` (${t.note.trim()})`;
  if (t.dnt) return `- "${t.term}": do not translate, keep exactly as written${note}`;
  if (t.translation.trim() !== '') return `- "${t.term}" → "${t.translation.trim()}"${note}`;
  return `- "${t.term}": keep as written (no ${locale} translation)${note}`;
}
