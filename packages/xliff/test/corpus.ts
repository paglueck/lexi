// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The fixture corpus the fidelity tests run over.
 *
 * Two kinds of entry. Most are built with `angularXlf`, which reproduces
 * `@angular/compiler`'s output shape. The `edge/*` ones are written out literally,
 * because they describe files that Angular would never emit but that exist in real
 * repositories — hand edits, other tooling, an editor that reformatted on save.
 * Those are where the bugs live.
 */
import { angularXlf, ph, type DocSpec } from './fixtures.js';

const SOURCE_WITH_TAGS =
  `You have ${ph.startTag('strong')}${ph.interpolation(0, '{{ invoiceCount }}')} invoices${ph.closeTag('strong')} in this period`;

const ICU_PLURAL = '{VAR_PLURAL, plural, =0 {no items} one {1 item} other {# items}}';

const templateSpec: DocSpec = {
  files: [{
    sourceLanguage: 'en-GB',
    targetLanguage: 'en-GB',
    units: [
      { id: '8f2c1a09b3e7d4562f1a', source: SOURCE_WITH_TAGS,
        contextGroups: [{ sourcefile: 'src/app/settings/billing/billing-summary.component.html', linenumber: 42 }],
        description: 'Summary line above the invoice table on the billing settings page.',
        meaning: 'billing.period-summary' },
      { id: 'checkout.pay_now', source: 'Pay now' },
      { id: 'd91f04ba77c1', source: ICU_PLURAL },
      { id: '9a34be71f002', source: `${ph.startTag('a')}Terms of Service${ph.closeTag('a')}` },
      { id: 'errors.offline', source: `You&apos;re offline. Changes sync when you reconnect.` },
    ],
  }],
};

export const CORPUS: Readonly<Record<string, string>> = {
  /** Extraction template: no targets anywhere. The app is what creates them. */
  'template/messages.xlf': angularXlf(templateSpec),

  /** Same, without target-language — what plain `ng extract-i18n` writes. */
  'template/messages.no-target-language.xlf': angularXlf({
    files: [(({ targetLanguage: _drop, ...rest }) => rest)(templateSpec.files[0]!)],
  }),

  /** A fully translated locale, hash ids and custom ids side by side. */
  'de/messages.de.xlf': angularXlf({
    files: [{
      targetLanguage: 'de',
      units: [
        { id: '8f2c1a09b3e7d4562f1a', source: SOURCE_WITH_TAGS,
          target: `Sie haben ${ph.startTag('strong')}${ph.interpolation(0, '{{ invoiceCount }}')} Rechnungen${ph.closeTag('strong')} in diesem Zeitraum`,
          state: 'translated',
          contextGroups: [{ sourcefile: 'src/app/settings/billing/billing-summary.component.html', linenumber: 42 }],
          description: 'Summary line above the invoice table.', meaning: 'billing.period-summary' },
        { id: 'checkout.pay_now', source: 'Pay now', target: 'Jetzt bezahlen', state: 'final' },
        { id: 'checkout.basket_add', source: 'Add to basket', target: 'In den Warenkorb', state: 'final' },
        { id: '55e1cc0d84fa', source: 'We couldn&apos;t process your payment.',
          target: 'Ihre Zahlung konnte nicht verarbeitet werden.', state: 'translated' },
      ],
    }],
  }),

  /**
   * The directory naming scheme: the locale is the parent folder and the
   * filename carries no token at all. It must group with `de/messages.de.xlf`,
   * which is the whole reason `fileGroupOf` exists (FR-2.2).
   */
  'de/messages.xlf': angularXlf({
    files: [{
      targetLanguage: 'de',
      units: [
        { id: 'checkout.pay_now', source: 'Pay now', target: 'Jetzt bezahlen', state: 'final' },
        { id: 'catalog.empty', source: 'No products match your filters',
          target: 'Keine Produkte entsprechen Ihren Filtern', state: 'translated' },
      ],
    }],
  }),

  /**
   * FR-1.2b: the filename says pt-BR, the attribute still says pt because the
   * file was copied from the European Portuguese one and renamed. The filename
   * wins, and the disagreement is what the setup wizard puts a fix button on.
   */
  'pt-BR/messages.pt-BR.xlf': angularXlf({
    files: [{
      targetLanguage: 'pt',
      units: [
        { id: 'checkout.pay_now', source: 'Pay now', target: 'Pagar agora', state: 'translated' },
        { id: 'catalog.empty', source: 'No products match your filters', targetSelfClosing: true, state: 'new' },
      ],
    }],
  }),

  /** The realistic mess: every shape of missing or half-written target. */
  'de/messages.de-partial.xlf': angularXlf({
    files: [{
      targetLanguage: 'de',
      units: [
        { id: 'no-target', source: 'Remove item' },
        { id: 'self-closed', source: 'Save changes', targetSelfClosing: true, state: 'new' },
        { id: 'empty-paired', source: 'Billing', target: '' },
        { id: 'whitespace-only', source: 'Delete account', target: '   ' },
        { id: 'translated', source: 'Reset all filters', target: 'Alle Filter zurücksetzen', state: 'translated' },
      ],
    }],
  }),

  /** Polish: ICU written with only the English categories, so FR-PH-5 must fire. */
  'pl/messages.pl.xlf': angularXlf({
    files: [{
      targetLanguage: 'pl',
      units: [
        { id: 'd91f04ba77c1', source: ICU_PLURAL,
          target: '{VAR_PLURAL, plural, =0 {brak elementów} one {1 element} other {# elementów}}',
          state: 'translated' },
      ],
    }],
  }),

  /** Arabic: RTL marks, Arabic-Indic digits, six plural categories. */
  'ar/messages.ar.xlf': angularXlf({
    files: [{
      targetLanguage: 'ar',
      units: [
        { id: 'greeting', source: `Hello ${ph.interpolation(0, '{{ name }}')}`,
          target: `‏مرحبا ${ph.interpolation(0, '{{ name }}')}‏`, state: 'translated' },
        { id: 'count', source: 'You have ١٢٣ items', target: 'لديك ١٢٣ عنصرا', state: 'translated' },
      ],
    }],
  }),

  'edge/crlf.xlf': angularXlf({ eol: '\r\n', files: [{ targetLanguage: 'de', units: [
    { id: 'a', source: 'Hello', target: 'Hallo', state: 'translated' },
    { id: 'b', source: 'Bye' },
  ] }] }),

  'edge/bom.xlf': angularXlf({ bom: true, files: [{ targetLanguage: 'de', units: [
    { id: 'a', source: 'Hello', target: 'Hallo', state: 'translated' },
  ] }] }),

  'edge/no-trailing-newline.xlf': angularXlf({ trailingNewline: false, files: [{ targetLanguage: 'de', units: [
    { id: 'a', source: 'Hello', target: 'Hallo', state: 'translated' },
  ] }] }),

  'edge/tabs.xlf': angularXlf({ files: [{ targetLanguage: 'de', units: [
    { id: 'a', source: 'Hello', target: 'Hallo', state: 'translated' },
  ] }] }).replace(/\n( +)/g, (_m, spaces: string) => '\n' + '\t'.repeat(spaces.length / 2)),

  /** Hand-written oddities that are legal XML but not Angular's style. */
  'edge/handwritten.xlf':
`<?xml version='1.0' encoding='UTF-8'?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
	<file datatype='plaintext' original="ng2.template" source-language="en-GB" target-language="de">
		<!-- hand-maintained; please keep sorted -->
		<body>
			<trans-unit datatype="html" id='inline'><source>Inline unit</source><target>Inline-Einheit</target></trans-unit>
			<trans-unit id="gt-in-text" datatype="html">
				<source>1 > 0 is true</source>
				<target>1 > 0 ist wahr</target>
			</trans-unit>
			<trans-unit id="double-escaped" datatype="html">
				<source>a&amp;amp;b and &#39;quoted&#39; and &apos;also&apos;</source>
			</trans-unit>
			<trans-unit id="preserve" datatype="html">
				<source xml:space="preserve"> padded </source>
			</trans-unit>
			<trans-unit id="nested-g" datatype="html">
				<source>Click <g id="g1">here <x id="INTERPOLATION" equiv-text="{{ n }}"/></g> now</source>
			</trans-unit>
			<trans-unit id="empty-source" datatype="html">
				<source/>
				<target/>
			</trans-unit>
			<trans-unit id="cdata-note" datatype="html">
				<source>With note</source>
				<note priority="1" from="description"><![CDATA[Use < and > freely]]></note>
			</trans-unit>
			<trans-unit id="extension" datatype="html">
				<source>Extended</source>
				<target xmlns:lx="urn:x" lx:origin="machine">Erweitert</target>
			</trans-unit>
		</body>
	</file>
</xliff>
`,

  /** The same unit id in two <file> elements — legal, and a correlation hazard. */
  'edge/two-files.xlf': angularXlf({
    files: [
      { targetLanguage: 'de', units: [{ id: 'shared', source: 'Shared', target: 'Geteilt', state: 'translated' }] },
      { targetLanguage: 'de', original: 'other.template',
        units: [{ id: 'shared', source: 'Shared', target: 'Anders', state: 'translated' }] },
    ],
  }),
};

export const corpusEntries = (): ReadonlyArray<readonly [string, string]> => Object.entries(CORPUS);
