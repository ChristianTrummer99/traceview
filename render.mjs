// Static HTML rendering: the run is embedded as JSON and viewer.js builds the
// collapsible view in the browser. Large fields are clipped before embedding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtDuration } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const asset = name => fs.readFileSync(path.join(here, name), 'utf8');

export const DEFAULT_LIMITS = { maxOutput: 200_000, maxText: 80_000, maxImage: 400_000, maxDetails: 20_000 };

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// JSON that is safe inside a <script> element (also escapes the U+2028/U+2029 line terminators).
const LS = new RegExp(String.fromCharCode(0x2028), 'g'), PS = new RegExp(String.fromCharCode(0x2029), 'g');
export const embedJson = value => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(LS, '\\u2028').replace(PS, '\\u2029');

const clipStr = (s, max) => (typeof s !== 'string' || s.length <= max ? { text: s, note: null } : { text: s.slice(0, max), note: { truncated: true, length: s.length } });
const clipValue = (v, max) => {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}\n…[truncated ${v.length - max} chars]` : v;
  if (Array.isArray(v)) return v.map(x => clipValue(x, max));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clipValue(x, max); return o; }
  return v;
};
const clipAttachments = (list, max) => { for (const a of list || []) if (a.data && a.data.length > max) { delete a.data; a.omitted = true; } };

// Clip in place so the page stays a manageable size.
export function clipRun(run, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  for (const w of run.workflows || []) for (const s of w.steps) {
    const prompt = clipStr(s.prompt, L.maxText); s.prompt = prompt.text; if (prompt.note) s.promptTruncated = prompt.note;
    s.result = clipValue(s.result, L.maxOutput);
  }
  for (const s of run.sessions) {
    if (s.prompt) s.prompt = clipStr(s.prompt, L.maxText).text;
    for (const t of s.turns) {
      if (t.prompt) {
        const c = clipStr(t.prompt.text, L.maxText); t.prompt.text = c.text; if (c.note) t.prompt.truncated = c.note;
        t.prompt.reminders = (t.prompt.reminders || []).map(r => clipStr(r, 8000).text);
        clipAttachments(t.prompt.attachments, L.maxImage);
      }
      for (const b of t.blocks) {
        if (b.kind === 'tool') {
          const o = clipStr(b.output, L.maxOutput); b.output = o.text; if (o.note) b.outputTruncated = o.note;
          if (b.outputPreview) b.outputPreview = clipStr(b.outputPreview, 4000).text;
          if (b.input !== undefined) { const original = JSON.stringify(b.input); b.input = clipValue(b.input, L.maxOutput); if (JSON.stringify(b.input) !== original) b.inputTruncated = true; }
          if (b.meta) b.meta = clipValue(b.meta, L.maxOutput);
          if (b.stderr) b.stderr = clipStr(b.stderr, L.maxOutput).text;
          if (b.details !== undefined) { const d = clipStr(JSON.stringify(b.details, null, 2), L.maxDetails); b.details = d.text; if (d.note) b.detailsTruncated = d.note; }
          clipAttachments(b.attachments, L.maxImage);
        } else if (typeof b.text === 'string') {
          const c = clipStr(b.text, L.maxText); b.text = c.text; if (c.note) b.textTruncated = c.note;
          if (b.reminders) b.reminders = b.reminders.map(r => clipStr(r, 8000).text);
          clipAttachments(b.attachments, L.maxImage);
        }
      }
    }
  }
  return run;
}

export function renderRunPage(run, options = {}) {
  const root = run.sessions.find(s => s.id === run.rootId) || run.sessions[0];
  const title = options.title || `${root?.title || root?.id || 'session'} · Traceview`;
  const payload = { ...run, options: { limits: { ...DEFAULT_LIMITS, ...(options.limits || {}) }, generatedAt: Date.now(), indexHref: options.indexHref || null } };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${asset('viewer.css')}</style></head>
<body><div id="app"><noscript>This viewer needs JavaScript.</noscript></div>
<script>window.__RUN__=${embedJson(payload)};</script>
<script>${asset('viewer.js')}</script>
</body></html>`;
}

// Index page for `serve`: every root session from every enabled source.
export function renderIndexPage(rows, options = {}) {
  const pad = n => String(n).padStart(2, '0');
  const date = ms => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const tr = r => `<tr data-source="${escapeHtml(r.source)}" data-bookmarked="${!!r.bookmark}" data-search="${escapeHtml([r.title, r.id, r.bookmark?.label, r.directory].join(' ').toLowerCase())}">
    <td><span class="src src-${escapeHtml(r.source)}">${escapeHtml(r.source)}</span></td>
    <td><a href="/run/${escapeHtml(r.source)}/${encodeURIComponent(r.id)}">${r.bookmark ? '<span class="bookmark-star">★</span> ' : ''}${escapeHtml(r.bookmark?.label || r.title || r.id)}</a><div class="muted small mono">${escapeHtml(r.id)}</div>${r.bookmark?.workflowRun ? `<span class="chip">${escapeHtml(r.bookmark.workflowRun)}</span>` : ''}</td>
    <td class="mono">${date(r.startedAt)}</td>
    <td>${fmtDuration(r.endedAt && r.startedAt ? r.endedAt - r.startedAt : null)}</td>
    <td>${r.prompts ?? ''}</td><td>${r.toolCalls ?? ''}</td><td>${r.children ?? ''}</td>
    <td>${r.cost ? `$${r.cost.toFixed(2)}` : ''}</td>
    <td class="small">${escapeHtml(r.model || '')}</td>
    <td><a class="small" href="/outline/${escapeHtml(r.source)}/${encodeURIComponent(r.id)}">outline</a></td>
  </tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Traceview / Run inspector</title><style>${asset('viewer.css')}</style></head>
<body class="index"><header class="top"><a href="/" class="brand">Trace<span>view</span> <small>/ RUN INSPECTOR</small></a><span class="local-indicator">LOCAL · READ ONLY</span></header>
<main class="index-main"><div class="index-hero"><div><div class="eyebrow">THE PROCESS, UNDER THE LENS</div><h1>From instruction<br>to execution.</h1><p>Open a run. Follow the agents. Inspect the evidence.</p><code class="muted">${escapeHtml(options.directory)}</code></div><div class="index-number">${String(rows.length).padStart(2, '0')}<span>recorded sessions</span></div></div>
${options.errors?.length ? `<p class="notice">${escapeHtml(options.errors.join('; '))}</p>` : ''}
<div class="index-toolbar"><div class="controls"><input id="session-search" type="search" aria-label="Search sessions" placeholder="Find a run by title or session ID…"><select id="source-filter" aria-label="Filter source"><option value="">All sources</option><option value="opencode">OpenCode</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select><label class="tgl"><input id="bookmarks-only" type="checkbox">Bookmarked runs</label></div><span id="count" class="muted small"></span><button onclick="location.reload()">Refresh</button></div>
<div class="table-scroll"><table class="index-table"><thead><tr><th>source</th><th>session / run</th><th>started</th><th>span</th><th>turns</th><th>tools¹</th><th>agents¹</th><th>cost¹</th><th>model</th><th></th></tr></thead>
<tbody>${rows.map(tr).join('\n')}</tbody></table></div><p id="no-results" class="empty" hidden>No sessions match. Clear the filters or run this viewer with <code>--dir /path/to/project</code>.</p>
<footer class="index-footer"><p>¹ Root-session tools and cost; direct child count. Open a run for the full tree. Span includes idle time.</p><details><summary>How to bookmark a run</summary><p>Choose its exact session ID, then run from the Traceview checkout:</p><pre class="code">node cli.mjs tag SESSION_ID --dir /path/to/project --label "Run name"</pre><p>Optionally add <code>--workflow-run pipeline/runs/RUN_NAME</code> to link a ledger explicitly. Bookmarks live in the selected project's <code>.session-viewer/runs.json</code>. Refresh this page after tagging.</p></details></footer></main>
<script>${asset('index.js')}</script></body></html>`;
}
