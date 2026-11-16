// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
import type { JobLogOutcome, MdBlock, MdSpan, SegmentDto } from '@lexi/shared';

import type { JobReport, ReportUnit } from './job-report.js';
import { parseMarkdown } from './markdown.js';

/**
 * The review report as ONE self-contained HTML file: no external resource, so
 * it opens offline on the reviewer's machine, prints, and survives an email.
 *
 * Every string from the project (sources, translations, notes, style guides,
 * prompts, model answers) goes through `esc` — the report is written into a
 * browser by somebody who never chose to trust this project's content. The
 * style guide is rendered from `parseMarkdown`'s span tree for the same
 * reason S6 does: there is no raw HTML in the path at all.
 */

const esc = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const OUTCOME_ORDER: readonly JobLogOutcome[] = ['accepted', 'rejected', 'skipped', 'failed'];

const OUTCOME_TITLE: Record<JobLogOutcome, string> = {
  accepted: 'Translated — please review',
  rejected: 'Rejected by Lexi — nothing was written',
  skipped: 'Skipped — an existing human translation was kept',
  failed: 'Failed — the model could not be asked',
};

/** A placeholder is a chip the reviewer must leave alone; a `<g>` wraps its children. */
function segments(list: readonly SegmentDto[]): string {
  return list
    .map((s) => {
      if (s.k === 't') return esc(s.v);
      if (s.k === 'p')
        return `<span class="ph" title="placeholder ${esc(s.id)}">${esc(s.equivText ?? s.id)}</span>`;
      return `<span class="grp" title="markup ${esc(s.id)}">${segments(s.children)}</span>`;
    })
    .join('');
}

function spans(list: readonly MdSpan[]): string {
  return list
    .map((s) => {
      const text = esc(s.text);
      if (s.href !== null && /^https?:\/\//i.test(s.href))
        return `<a href="${esc(s.href)}">${text}</a>`;
      if (s.style === 'strong') return `<strong>${text}</strong>`;
      if (s.style === 'em') return `<em>${text}</em>`;
      if (s.style === 'code') return `<code>${text}</code>`;
      return text;
    })
    .join('');
}

function markdown(text: string): string {
  return parseMarkdown(text).map(mdBlock).join('\n');
}

function mdBlock(b: MdBlock): string {
  switch (b.kind) {
    case 'heading': {
      // Shifted down: the report's own headings are h1–h3.
      const level = Math.min(6, b.level + 3);
      return `<h${level}>${spans(b.lines[0] ?? [])}</h${level}>`;
    }
    case 'para':
      return `<p>${b.lines.map(spans).join('<br>')}</p>`;
    case 'quote':
      return `<blockquote>${b.lines.map((l) => `<p>${spans(l)}</p>`).join('')}</blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.lines.map((l) => `<li>${spans(l)}</li>`).join('')}</${tag}>`;
    }
    case 'code':
      return `<pre>${esc(b.lines[0]?.map((s) => s.text).join('') ?? '')}</pre>`;
    case 'rule':
      return '<hr>';
    case 'table': {
      const [head = [], ...body] = b.cells;
      const row = (cells: MdSpan[][], tag: 'th' | 'td'): string =>
        `<tr>${cells.map((c) => `<${tag}>${spans(c)}</${tag}>`).join('')}</tr>`;
      return `<table class="md"><thead>${row(head, 'th')}</thead><tbody>${body.map((r) => row(r, 'td')).join('')}</tbody></table>`;
    }
  }
}

const fmtDate = (iso: string | null): string =>
  iso === null ? '—' : iso.replace('T', ' ').slice(0, 16) + ' UTC';

function header(report: JobReport, counts: Record<JobLogOutcome, number>): string {
  const { record } = report;
  const { job, params } = record;
  const rows: [string, string][] = [
    ['Project', esc(record.projectName)],
    [
      'Languages',
      `${esc(record.sourceLocale)} → ${job.locales.map((l) => `<strong>${esc(l.locale)}</strong>`).join(', ')}`,
    ],
    ['Run', `${fmtDate(job.startedAt)} – ${fmtDate(job.finishedAt)} · ${esc(job.status)}`],
    [
      'Model',
      `${esc(record.model || '—')} · temperature ${params.temperature} · ${params.unitsPerRequest} per request`,
    ],
    [
      'Result',
      `${counts.accepted} translated · ${counts.rejected} rejected · ${counts.skipped} skipped · ${counts.failed} failed` +
        ` (of ${job.locales.reduce((n, l) => n + l.total, 0)})`,
    ],
    ['Job', `<code>${esc(job.id)}</code>`],
  ];
  if (job.name !== null) rows.unshift(['Name', esc(job.name)]);
  if (record.instruction !== null && record.instruction.trim() !== '') {
    rows.push(['Extra instruction', `<span class="pre">${esc(record.instruction)}</span>`]);
  }
  return `<dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

const GUIDE = `
<section class="guide">
  <h2>How to review</h2>
  <p>Each card below is one text from the application, translated by a language model. For every translated card, please check:</p>
  <ul>
    <li><strong>Meaning</strong> — does it say what the source says, in this context (see the description and where it is used)?</li>
    <li><strong>Language</strong> — grammar, spelling, punctuation, natural phrasing.</li>
    <li><strong>Style</strong> — does it follow the style guide below (tone, form of address, terminology)?</li>
    <li><strong>Placeholders</strong> — <span class="ph">shaded chips</span> are filled in by the application. They must stay, but may move to where your language needs them.</li>
  </ul>
  <p>Please reply with the card number (for example <strong>#12</strong>) and your correction or comment.</p>
</section>`;

const guidePart = (g: { name: string; text: string } | null): string =>
  g === null
    ? ''
    : `<details open><summary>${esc(g.name)}</summary><div class="md">${markdown(g.text)}</div></details>`;

/** The project-wide guide, once; each locale's own guide sits at the top of that locale's section. */
function styleGuides(report: JobReport): string {
  const { global } = report.record.styleguides;
  if (global === null) return '';
  return `<section><h2>Style guide</h2><p class="muted">As it was when the job started — this is what the model was told.</p>${guidePart(global)}</section>`;
}

function localeGuide(report: JobReport, locale: string): string {
  const guide = report.record.styleguides.locales[locale] ?? null;
  if (guide === null) {
    return `<p class="muted">This project has no style guide for ${esc(locale)}${report.record.styleguides.global === null ? '' : ' beyond the project-wide one'}.</p>`;
  }
  return `<p class="muted">Style guide for ${esc(locale)}, as it was when the job started.</p>${guidePart(guide)}`;
}

function systemPrompt(report: JobReport): string {
  if (report.sharedSystem === null) return '';
  return `<section><h2>Instructions sent to the model</h2>
<details><summary>System prompt (shared by the units below unless a card says otherwise)</summary><pre>${esc(report.sharedSystem)}</pre></details></section>`;
}

function unitCard(u: ReportUnit, report: JobReport): string {
  const { record } = report;
  const target = u.locale;
  const parts: string[] = [];

  parts.push(
    `<header><span class="no">#${u.no}</span> <code class="key">${esc(u.unitId)}</code>` +
      (u.currentState !== null ? ` <span class="badge">${esc(u.currentState)}</span>` : '') +
      (u.confidence !== null
        ? ` <span class="badge conf-${esc(u.confidence)}">confidence: ${esc(u.confidence)}</span>`
        : '') +
      `</header>`,
  );

  if (u.gone)
    parts.push(
      `<p class="warn">This key is no longer in the open project; only what the job logged is shown.</p>`,
    );

  const context: string[] = [];
  for (const n of u.notes) context.push(`<dt>${esc(n.from ?? 'note')}</dt><dd>${esc(n.text)}</dd>`);
  if (u.locations.length > 0) {
    const where = u.locations.map(
      (l) => `${esc(l.sourcefile)}${l.linenumber !== null ? `:${esc(l.linenumber)}` : ''}`,
    );
    context.push(`<dt>used in</dt><dd>${where.join('<br>')}</dd>`);
  }
  if (context.length > 0) parts.push(`<dl class="ctx">${context.join('')}</dl>`);

  const translation =
    u.written !== null
      ? `<div class="text" lang="${esc(target)}">${segments(u.written)}</div>`
      : `<div class="text muted">—</div>`;
  parts.push(`<div class="pair">
  <div><div class="label">Source · ${esc(record.sourceLocale)}</div><div class="text" lang="${esc(record.sourceLocale)}">${u.source.length > 0 ? segments(u.source) : '<span class="muted">—</span>'}</div></div>
  <div><div class="label">Translation · ${esc(target)}</div>${translation}</div>
</div>`);

  if (u.current !== null) {
    parts.push(
      `<div class="changed"><div class="label">Changed since the job — the application now says</div><div class="text" lang="${esc(target)}">${segments(u.current)}</div></div>`,
    );
  }
  if (u.notesForReviewer !== null && u.notesForReviewer.trim() !== '') {
    parts.push(
      `<p class="note"><span class="label">Model's note</span> ${esc(u.notesForReviewer)}</p>`,
    );
  }
  if (u.findings.length > 0) {
    parts.push(
      `<ul class="findings">${u.findings.map((f) => `<li class="${esc(f.severity)}">${esc(f.message)}</li>`).join('')}</ul>`,
    );
  }
  if (u.rejection !== null) {
    parts.push(
      `<p class="warn"><strong>${esc(u.rejection.reason)}</strong> — ${esc(u.rejection.detail)}</p>`,
    );
  }
  if (u.message !== null) parts.push(`<p class="warn">${esc(u.message)}</p>`);
  if (u.raw !== null) {
    parts.push(`<details><summary>The model's answer</summary><pre>${esc(u.raw)}</pre></details>`);
  }

  const prompt: string[] = [];
  if (u.system !== null)
    prompt.push(
      `<div class="label">System prompt (differs from the shared one)</div><pre>${esc(u.system)}</pre>`,
    );
  if (u.user !== null) {
    const shared =
      u.batch !== null
        ? ` — one request for ${u.batch.size} texts, this one is <code>${esc(u.batch.key)}</code>`
        : '';
    prompt.push(`<div class="label">Message${shared}</div><pre>${esc(u.user)}</pre>`);
  } else if (u.userShownAt !== null) {
    prompt.push(
      `<p class="muted">Sent in the same request as <a href="#u${u.userShownAt}">#${u.userShownAt}</a>` +
        (u.batch !== null ? ` (as <code>${esc(u.batch.key)}</code>)` : '') +
        `.</p>`,
    );
  }
  if (prompt.length > 0)
    parts.push(`<details class="prompt"><summary>Prompt</summary>${prompt.join('')}</details>`);

  return `<article class="unit ${u.outcome}" id="u${u.no}">${parts.join('\n')}</article>`;
}

const CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1b1b1f; --muted:#62626b; --line:#dcdce2; --card:#f7f7f9;
  --ph-bg:#e6e9f7; --ph-fg:#2d3a8c; --warn:#8a4b00; --warn-bg:#fff4e0; --err:#a1131a; --ok:#1f6e3a; --accent:#2d3a8c; }
@media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#e8e8ec; --muted:#a0a0aa; --line:#33333a; --card:#1d1d22;
  --ph-bg:#2a3160; --ph-fg:#c9d0ff; --warn:#ffc27a; --warn-bg:#3a2a12; --err:#ff8a8f; --ok:#7fd69b; --accent:#aab4ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 16px; } h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
code, pre, .key { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
pre { white-space: pre-wrap; word-break: break-word; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 10px; margin: 6px 0; }
.pre { white-space: pre-wrap; }
.muted { color: var(--muted); }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dl.meta dt, dl.ctx dt { color: var(--muted); }
dl.meta dd, dl.ctx dd { margin: 0; }
.guide { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 4px 16px; margin-top: 24px; }
.unit { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; break-inside: avoid; }
.unit header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 8px; }
.no { font-weight: 700; color: var(--accent); }
.key { word-break: break-all; }
.badge { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; color: var(--muted); }
.conf-low { color: var(--err); border-color: currentColor; } .conf-medium { color: var(--warn); border-color: currentColor; }
dl.ctx { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 10px; font-size: 14px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 640px) { .pair { grid-template-columns: 1fr; } dl.meta { grid-template-columns: 1fr; } }
.label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 2px; }
.text { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font-size: 16px; white-space: pre-wrap; word-break: break-word; }
.ph { background: var(--ph-bg); color: var(--ph-fg); border-radius: 4px; padding: 0 4px; font-family: ui-monospace, Menlo, monospace; font-size: .85em; white-space: nowrap; }
.grp { text-decoration: underline dotted var(--muted); }
.pair > div { min-width: 0; }
.md h4, .md h5, .md h6 { font-size: 15px; margin: 12px 0 4px; }
.changed { margin-top: 8px; }
.note { margin: 8px 0 0; }
.warn { color: var(--warn); background: var(--warn-bg); border-radius: 6px; padding: 6px 10px; margin: 8px 0 0; }
.findings { margin: 8px 0 0; padding-left: 20px; } .findings .error { color: var(--err); } .findings .warning { color: var(--warn); }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--accent); }
.md table { border-collapse: collapse; } .md th, .md td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--muted); }
a { color: var(--accent); }
@media print { body { font-size: 12px; } main { max-width: none; padding: 0; } .prompt { display: none; } }
`;

/** `beforeprint` opens every collapsed section: a closed `<details>` prints as its summary alone. */
const SCRIPT = `addEventListener('beforeprint', () => document.querySelectorAll('details').forEach((d) => (d.open = true)));`;

export function renderJobReportHtml(report: JobReport): string {
  const counts: Record<JobLogOutcome, number> = { accepted: 0, rejected: 0, skipped: 0, failed: 0 };
  for (const u of report.units) counts[u.outcome] += 1;

  const { job } = report.record;
  const codes = job.locales.map((l) => l.locale);
  const multi = codes.length > 1;
  // A named job leads with its name, so the reviewer sees which batch this is.
  const named = job.name === null ? '' : `${esc(job.name)} · `;
  const sections = codes.flatMap((locale) => {
    const units = report.units.filter((u) => u.locale === locale);
    if (units.length === 0) return [];
    const byOutcome = OUTCOME_ORDER.map((o) => [o, units.filter((u) => u.outcome === o)] as const)
      .filter(([, list]) => list.length > 0)
      .map(
        ([o, list]) =>
          `<section><${multi ? 'h3' : 'h2'}>${OUTCOME_TITLE[o]} (${list.length})</${multi ? 'h3' : 'h2'}>${list
            .map((u) => unitCard(u, report))
            .join('\n')}</section>`,
      );
    return [
      `<section id="locale-${esc(locale)}"><h2>${esc(report.record.sourceLocale)} → ${esc(locale)}</h2>${localeGuide(report, locale)}${byOutcome.join('\n')}</section>`,
    ];
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${named}Translation review · ${esc(codes.join(', '))} · ${esc(report.record.projectName)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${named}Translation review · ${esc(report.record.sourceLocale)} → ${esc(codes.join(', '))}</h1>
${header(report, counts)}
<p class="muted">Generated ${fmtDate(report.generatedAt)} by Lexi.</p>
${GUIDE}
${styleGuides(report)}
${systemPrompt(report)}
${sections.length > 0 ? sections.join('\n') : '<p class="muted">This job did not reach any text.</p>'}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
