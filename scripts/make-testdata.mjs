#!/usr/bin/env node
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Generate `testdata/northwind` — a miniature Angular locale folder, committed
 * so that `npm start -- ./testdata/northwind` works on a fresh clone and the
 * manual end-to-end check has something to open.
 *
 * Plain string templating that mimics `@angular/compiler`'s serializer, exactly
 * like `packages/xliff/test/fixtures.ts`. It must NEVER route through our own
 * writer: a fixture produced by the code under test makes every round-trip
 * assertion circular and green by definition.
 *
 * Shape verified against @angular/compiler@22 `Xliff.write` — see
 * docs/architecture.md (Angular's output shape). Two spaces per level, `<source>` inline, a space
 * before `?>`, and all five predefined entities escaped.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../testdata/northwind', import.meta.url));

const esc = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const x = (id, equiv, ctype) =>
  `<x id="${id}"${ctype ? ` ctype="${ctype}"` : ''} equiv-text="${esc(equiv)}"/>`;

const INTERP = x('INTERPOLATION', '{{ invoiceCount }}');
const STRONG_OPEN = x('START_TAG_STRONG', '<strong>', 'x-strong');
const STRONG_CLOSE = x('CLOSE_TAG_STRONG', '</strong>', 'x-strong');

/** id, source, [description, meaning], [sourcefile, line] */
const UNITS = [
  {
    id: '8f2c1a09b3e7d4562f1a',
    source: `You have ${STRONG_OPEN}${INTERP} invoices${STRONG_CLOSE} in this period`,
    description: 'Summary line above the invoice table on the billing settings page.',
    meaning: 'billing.period-summary',
    loc: ['src/app/settings/billing/billing-summary.component.html', 42],
    t: {
      de: `Sie haben ${STRONG_OPEN}${INTERP} Rechnungen${STRONG_CLOSE} in diesem Zeitraum`,
      fr: `Vous avez ${STRONG_OPEN}${INTERP} factures${STRONG_CLOSE} sur cette période`,
      'pt-BR': `Você tem ${STRONG_OPEN}${INTERP} faturas${STRONG_CLOSE} neste período`,
      ar: `لديك ${STRONG_OPEN}${INTERP} فواتير${STRONG_CLOSE} في هذه الفترة`,
    },
  },
  {
    id: 'checkout.pay_now',
    source: 'Pay now',
    description: 'Primary button on the checkout summary.',
    loc: ['src/app/checkout/summary.component.html', 17],
    t: { de: 'Jetzt bezahlen', fr: 'Payer maintenant', 'pt-BR': 'Pagar agora', ar: 'ادفع الآن' },
  },
  {
    id: 'checkout.basket_add',
    source: 'Add to basket',
    loc: ['src/app/catalog/product-card.component.html', 61],
    t: { de: 'In den Warenkorb', fr: 'Ajouter au panier', 'pt-BR': 'Adicionar ao carrinho' },
  },
  {
    id: 'catalog.empty',
    source: 'No products match your filters',
    loc: ['src/app/catalog/catalog-page.component.html', 88],
    t: { de: 'Keine Produkte entsprechen Ihren Filtern', fr: 'Aucun produit ne correspond' },
  },
  {
    id: '55e1cc0d84fa',
    source: `We couldn't process your payment. Check your card details and try again.`,
    description: 'Error shown when the payment provider declines the card.',
    loc: ['src/app/checkout/payment-form.component.html', 120],
    t: { de: 'Ihre Zahlung konnte nicht verarbeitet werden.' },
  },
  {
    id: 'errors.offline',
    source: `You're offline. Changes sync when you reconnect.`,
    loc: ['src/app/shell/offline-banner.component.html', 9],
    t: { de: 'Sie sind offline. Änderungen werden synchronisiert.' },
  },
  {
    id: 'settings.billing',
    source: 'Billing',
    meaning: 'settings.nav',
    loc: ['src/app/settings/settings-nav.component.html', 23],
    t: { de: 'Abrechnung', fr: 'Facturation', 'pt-BR': 'Faturamento', ar: 'الفوترة' },
  },
  {
    id: 'account.delete',
    source: 'Delete account',
    loc: ['src/app/settings/account.component.html', 74],
    t: { de: 'Konto löschen', fr: 'Supprimer le compte' },
  },
];

/** The checkout feature module, split out to exercise FR-1.4. */
const CHECKOUT_UNITS = [
  {
    id: 'd91f04ba77c1',
    // Only the English categories: Polish needs one/few/many/other, so this
    // must trip FR-PH-5 the moment validation runs over it.
    source: '{VAR_PLURAL, plural, =0 {no items} one {1 item} other {# items}}',
    loc: ['src/app/checkout/basket.component.html', 31],
    t: { pl: '{VAR_PLURAL, plural, =0 {brak pozycji} one {1 pozycja} other {# pozycji}}' },
  },
  {
    id: 'checkout.free_ship',
    source: `Free shipping over ${x('INTERPOLATION', '{{ threshold }}')}`,
    loc: ['src/app/checkout/shipping.component.html', 12],
    t: {},
  },
];

const cr = (n) => '\n' + ' '.repeat(n);

function renderUnit(u, locale) {
  const parts = [`${cr(6)}<trans-unit id="${esc(u.id)}" datatype="html">`];
  parts.push(`${cr(8)}<source>${u.source}</source>`);

  if (locale !== null) {
    const target = u.t?.[locale];
    parts.push(
      target === undefined
        ? `${cr(8)}<target state="new"/>`
        : `${cr(8)}<target state="translated">${target}</target>`,
    );
  }

  if (u.loc) {
    parts.push(`${cr(8)}<context-group purpose="location">`);
    parts.push(`${cr(10)}<context context-type="sourcefile">${esc(u.loc[0])}</context>`);
    parts.push(`${cr(10)}<context context-type="linenumber">${u.loc[1]}</context>`);
    parts.push(`${cr(8)}</context-group>`);
  }
  if (u.description)
    parts.push(`${cr(8)}<note priority="1" from="description">${esc(u.description)}</note>`);
  if (u.meaning) parts.push(`${cr(8)}<note priority="1" from="meaning">${esc(u.meaning)}</note>`);

  parts.push(`${cr(6)}</trans-unit>`);
  return parts.join('');
}

function renderDoc({ targetLanguage, units, locale }) {
  const attrs = [
    'source-language="en-GB"',
    'datatype="plaintext"',
    'original="ng2.template"',
    ...(targetLanguage === null ? [] : [`target-language="${targetLanguage}"`]),
  ].join(' ');
  const body = units.map((u) => renderUnit(u, locale)).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" ?>\n` +
    `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">` +
    `${cr(2)}<file ${attrs}>${cr(4)}<body>${body}${cr(4)}</body>${cr(2)}</file>\n</xliff>\n`
  );
}

const FILES = {
  // The extraction template: languages agree, no <target> anywhere (FR-1.2a).
  'messages.xlf': renderDoc({ targetLanguage: 'en-GB', units: UNITS, locale: null }),
  'messages.de.xlf': renderDoc({ targetLanguage: 'de', units: UNITS, locale: 'de' }),
  'messages.fr.xlf': renderDoc({ targetLanguage: 'fr', units: UNITS, locale: 'fr' }),
  // FR-1.2b: copied from the European Portuguese file and renamed; the stale
  // attribute is what the setup wizard puts a "Fix to pt-BR" button on.
  'messages.pt-BR.xlf': renderDoc({ targetLanguage: 'pt', units: UNITS, locale: 'pt-BR' }),
  'messages.ar.xlf': renderDoc({ targetLanguage: 'ar', units: UNITS, locale: 'ar' }),
  // FR-1.4: a second file for one locale, keyed by path.
  'checkout/messages.pl.xlf': renderDoc({
    targetLanguage: 'pl',
    units: CHECKOUT_UNITS,
    locale: 'pl',
  }),
};

for (const [name, content] of Object.entries(FILES)) {
  const path = join(OUT, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  process.stdout.write(`wrote ${name}\n`);
}
