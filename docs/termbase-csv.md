# Term Base CSV format

The Term Base tab imports terms from a CSV file (**Import CSV…**). Lexi stores the term base in
the same format at `.lexi/termbase.csv`, so you can also edit that file by hand or export it by
copying it.

## Example

```csv
term,note,dnt,de,fr,pt-BR,pl,ar
checkout,"Checkout flow, always used as a noun",no,Kasse,Paiement,Finalizar compra,,الدفع
invoice,"Billing document, not the act of billing",no,Rechnung,Facture,Fatura,Faktura,فاتورة
Northwind,Company and product name,yes,,,,,
SSO,"Single sign-on, keep the abbreviation",yes,,,,,
```

Here `checkout` has no `pl` translation, so it stays "checkout" in Polish. `Northwind` and `SSO`
stay as written in every locale.

## Encoding and syntax

- UTF-8. A leading byte-order mark (BOM) is allowed and ignored.
- RFC 4180: fields are separated by commas, and records by CRLF or LF.
- Put a field in double quotes if it contains a comma, a double quote or a line break. Write a
  double quote inside a quoted field as `""`, for example `"Say ""hi"""`.
- Blank lines are skipped. Leading and trailing spaces in a cell are trimmed.
- The **header row is required** and must be the first line.

## Columns

Columns can appear in any order. Header names are matched exactly; `term`, `note`, `dnt` and
`id` are matched case-insensitively.

| Column | Required | Meaning |
|---|---|---|
| `term` | yes | The source-language term. It matches **case-sensitively** and on word boundaries (`cart` does not match `carton`). It must not be empty. |
| `note` | no | Meaning or usage. It is **sent to the model** together with the term. |
| `dnt` | no | Do not translate. `yes`/`no`, `true`/`false` or `1`/`0`, in any case. An empty cell or a missing column means `no`. |
| `<locale>` | no | One column per project locale, named by its tag exactly as the project uses it (`de`, `pt-BR`, `ar`). The cell holds the fixed translation for that locale. |
| `id` | no | Lexi writes it into `.lexi/termbase.csv` to keep rows stable. On import it is ignored. |

Any other column is shown in the import dialog as *ignored, not a project locale*, and is not
imported. This includes a locale the project does not have, such as `es`.

## Rules

- **Empty locale cell:** that locale keeps the source term as written. This is not an error. The
  prompt tells the model "keep as written", and validation flags a translation that changed it.
- **Row with `dnt` = yes:** the term stays as written in every locale, and the row's locale cells
  are ignored on import.
- **Missing locale column:** if the file has no column for a project locale, the import leaves
  that locale alone. Existing translations for it are kept, not cleared.
- **Duplicates:** a term may appear only once per file (compared case-insensitively). If it
  appears twice, the file is refused.

## Importing over existing terms

A file row is matched to an existing term by `term`, compared case-insensitively. The preview
marks each row:

| Status | When |
|---|---|
| **New** | No existing term has this name. It is added at the top. |
| **Update** | The note, `dnt` or a locale value in the file differs from the existing term. |
| **Unchanged** | Everything in the file matches the existing term. |

Under *Terms that already exist* you choose what happens to updates:

- **Overwrite:** updates replace the existing term's note, `dnt` and the locales present in the
  file. If the file marks a term as DNT, the translations it already has are kept, locked and
  hidden, as when DNT is switched on in the editor.
- **Keep existing:** only new terms are added.

A file with errors imports nothing; the dialog lists the problems with their line numbers. Errors
include a missing `term` column, an empty term, a `dnt` value that is not recognised and a
duplicate term.
