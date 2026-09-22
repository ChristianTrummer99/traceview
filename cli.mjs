#!/usr/bin/env node
// Traceview: inspect what an agent run actually did, step by step.
// Reads OpenCode (SQLite), Claude Code and Codex (JSONL) transcripts, including every
// sub-agent a run spawned, and renders a collapsible HTML view or a text outline.
//
//   node cli.mjs list [--source all|opencode|claude|codex] [--dir <project>] [--all-dirs] [--children] [--json]
//   node cli.mjs render <session-id|prefix> [--dir <project>] [--out <file.html>] [--open] [--max-output <chars>] [--no-inline-files]
//   node cli.mjs outline <session-id|prefix> [--dir <project>] [--json]
//   node cli.mjs serve [--port 8787] [--dir <project>]
//   node cli.mjs tag <session-id> [--dir <project>] [--label <name>] [--workflow-run pipeline/runs/<run>]
//   node cli.mjs untag <session-id> [--dir <project>]
//   node cli.mjs transcript <session-id> [--dir <project>] [--json]
//
// Overrides: --db <opencode.db>  --projects <~/.claude/projects>  --codex-home <~/.codex>
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeProjectDir, DEFAULT_CLAUDE_PROJECTS, listClaudeSessions, loadClaudeRun, resolveClaudeSession } from './claude.mjs';
import { DEFAULT_OPENCODE_DB, listOpenCodeSessions, loadOpenCodeRun, openOpenCodeDatabase, resolveOpenCodeSession } from './opencode.mjs';
import { clipRun, DEFAULT_LIMITS, renderIndexPage, renderRunPage } from './render.mjs';
import { fmtDuration, outlineMarkdown, transcriptMarkdown } from './model.mjs';
import { attachWorkflowEvidence, bookmarkRun, readBookmarks } from './catalog.mjs';
import { DEFAULT_CODEX_HOME, discoverCodexSessions, listCodexSessions, loadCodexRun, resolveCodexSession } from './codex.mjs';

const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof warning === 'object' && warning ? warning.name : rest[0]?.type || rest[0];
  if (type === 'ExperimentalWarning') return; // node:sqlite is experimental on Node 22/23
  return originalEmitWarning.call(process, warning, ...rest);
};

export function parseArgs(argv) {
  const flags = {}, positional = [];
  const booleans = new Set(['all-dirs', 'children', 'json', 'open', 'help', 'inline-files']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (key.startsWith('no-')) { flags[key.slice(3)] = false; continue; }
    if (booleans.has(key)) { flags[key] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else throw new Error(`--${key} needs a value`);
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

function gitRoot(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : dir;
}

export function context(flags) {
  const directory = path.resolve(flags.dir ? String(flags.dir) : gitRoot(process.cwd()));
  const source = String(flags.source || 'all');
  if (!['all', 'opencode', 'claude', 'codex'].includes(source)) throw new Error('--source must be all, opencode, claude, or codex');
  const projectsDir = flags.projects ? path.resolve(String(flags.projects)) : DEFAULT_CLAUDE_PROJECTS;
  const limits = { ...DEFAULT_LIMITS };
  if (flags['max-output']) limits.maxOutput = Number(flags['max-output']);
  if (flags['max-image']) limits.maxImage = Number(flags['max-image']);
  if (flags['max-text']) limits.maxText = Number(flags['max-text']);
  for (const [key, value] of Object.entries(limits)) if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a nonnegative finite number`);
  return {
    directory, source, projectsDir, limits,
    dbFile: flags.db ? path.resolve(String(flags.db)) : DEFAULT_OPENCODE_DB,
    claudeDir: claudeProjectDir(directory, projectsDir),
    codexHome: flags['codex-home'] ? path.resolve(String(flags['codex-home'])) : DEFAULT_CODEX_HOME,
    inlineFiles: flags['inline-files'] !== false,
    useOpenCode: source === 'all' || source === 'opencode',
    useClaude: source === 'all' || source === 'claude',
    useCodex: source === 'all' || source === 'codex',
  };
}

async function withDb(ctx, fn) {
  const db = await openOpenCodeDatabase(ctx.dbFile);
  try { return await fn(db); } finally { db.close(); }
}

export async function listAll(ctx, { allDirs = false, children = false } = {}) {
  const rows = [], errors = [];
  if (ctx.useOpenCode) {
    try { rows.push(...await withDb(ctx, db => listOpenCodeSessions({ db, directory: allDirs ? '' : ctx.directory, includeChildren: children }))); }
    catch (e) { errors.push(`opencode: ${e.message}`); }
  }
  if (ctx.useClaude) {
    try {
      const dirs = allDirs ? fs.readdirSync(ctx.projectsDir).map(n => path.join(ctx.projectsDir, n)).filter(p => fs.statSync(p).isDirectory()) : [ctx.claudeDir];
      for (const d of dirs) rows.push(...listClaudeSessions({ projectDir: d }));
    } catch (e) { errors.push(`claude: ${e.message}`); }
  }
  if (ctx.useCodex) {
    try { rows.push(...listCodexSessions({ home: ctx.codexHome, directory: allDirs ? '' : ctx.directory, includeChildren: children })); }
    catch (e) { errors.push(`codex: ${e.message}`); }
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const bookmarks = readBookmarks(ctx.directory);
  for (const row of rows) row.bookmark = bookmarks.find(b => b.id === row.id && b.source === row.source) || null;
  return { rows, errors };
}

// Find one session by id or prefix across the enabled sources.
export async function loadRun(ctx, id, sourceHint) {
  if (sourceHint && !['opencode', 'claude', 'codex'].includes(sourceHint)) throw new Error('Unknown transcript source');
  const opts = { maxImage: ctx.limits.maxImage, inlineFiles: ctx.inlineFiles };
  const hits = [], errors = [];
  if (ctx.useClaude && (!sourceHint || sourceHint === 'claude')) {
    const file = resolveClaudeSession(ctx.claudeDir, id);
    if (file) hits.push({ source: 'claude', id: path.basename(file, '.jsonl') });
  }
  if (ctx.useOpenCode && (!sourceHint || sourceHint === 'opencode')) {
    try { const found = await withDb(ctx, db => resolveOpenCodeSession(db, id)); if (found) hits.push({ source: 'opencode', id: found }); }
    catch (e) { if (/^Ambiguous/.test(e.message)) throw e; errors.push(`opencode: ${e.message}`); }
  }
  if (ctx.useCodex && (!sourceHint || sourceHint === 'codex')) {
    try {
      const found = resolveCodexSession(discoverCodexSessions(ctx.codexHome), id);
      if (found) hits.push({ source: 'codex', id: found.id });
    } catch (e) { if (/^Ambiguous/.test(e.message)) throw e; errors.push(`codex: ${e.message}`); }
  }
  if (!hits.length) throw new Error(`No session matching "${id}" for ${ctx.directory} (sources: ${ctx.source}). Run "list" to see ids.${errors.length ? ` ${errors.join('; ')}` : ''}`);
  if (hits.length > 1) throw new Error(`"${id}" matches several sessions: ${hits.map(h => `${h.source}:${h.id}`).join(', ')}. Pass --source.`);
  const [hit] = hits;
  const run = hit.source === 'claude'
    ? loadClaudeRun({ projectDir: ctx.claudeDir, id: hit.id, ...opts })
    : hit.source === 'codex' ? loadCodexRun({ home: ctx.codexHome, id: hit.id, ...opts })
      : await withDb(ctx, db => loadOpenCodeRun({ db, id: hit.id, ...opts }));
  return attachWorkflowEvidence(run, ctx.directory, readBookmarks(ctx.directory).find(b => b.id === run.rootId && b.source === run.source));
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
function printTable(rows) {
  const d = ms => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
  console.log([pad('SOURCE', 8), pad('ID', 38), pad('STARTED', 16), pad('DUR', 8), pad('PROMPTS', 7), pad('TOOLS', 6), pad('AGENTS', 6), pad('COST', 7), 'TITLE'].join(' '));
  for (const r of rows) {
    const dur = r.endedAt && r.startedAt ? fmtDuration(r.endedAt - r.startedAt) : '';
    console.log([pad(r.source, 8), pad(r.id, 38), pad(d(r.startedAt), 16), pad(dur, 8), pad(r.prompts ?? '', 7), pad(r.toolCalls ?? '', 6), pad(r.children ?? '', 6), pad(r.cost ? `$${r.cost.toFixed(2)}` : '', 7), `${r.title || ''}${r.tags?.length ? `  [${r.tags.join(', ')}]` : ''}`].join(' '));
  }
}

function defaultOut(ctx, run) {
  const dir = path.join(ctx.directory, '.session-viewer');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${run.source}-${run.rootId.replace(/[^A-Za-z0-9_.-]/g, '_')}.html`);
}

function openInBrowser(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [file], { stdio: 'ignore', detached: true }).unref();
}

export async function serve(ctx, port) {
  const server = http.createServer(async (req, res) => {
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(body); };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(403, 'text/plain', 'Local access only');
      if (req.method !== 'GET') return send(405, 'text/plain', 'Read-only viewer');
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts.length) {
        const { rows, errors } = await listAll(ctx);
        return send(200, 'text/html', renderIndexPage(rows, { directory: ctx.directory, errors }));
      }
      if (['run', 'outline', 'transcript', 'data'].includes(parts[0]) && parts.length === 3) {
        const run = await loadRun(ctx, decodeURIComponent(parts[2]), parts[1]);
        if (parts[0] === 'outline') return send(200, 'text/plain', outlineMarkdown(run));
        if (parts[0] === 'transcript') return send(200, 'text/plain', transcriptMarkdown(run));
        if (parts[0] === 'data') return send(200, 'application/json', JSON.stringify(run, null, 2));
        return send(200, 'text/html', renderRunPage(clipRun(run, ctx.limits), { limits: ctx.limits, indexHref: '/' }));
      }
      send(404, 'text/plain', 'Not found. Try / or /run/<source>/<id>');
    } catch (e) { send(500, 'text/plain', `Error: ${e.message}`); }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, positional, flags } = parseArgs(argv);
  const ctx = context(flags);
  if (!command || command === 'help' || flags.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (command === 'list') {
    const { rows, errors } = await listAll(ctx, { allDirs: !!flags['all-dirs'], children: !!flags.children });
    for (const e of errors) console.error(`warning: ${e}`);
    if (flags.json) console.log(JSON.stringify(rows, null, 2)); else { console.log(`Sessions for ${flags['all-dirs'] ? 'all directories' : ctx.directory} (sources: ${ctx.source})`); printTable(rows); }
    return;
  }
  if (['tag', 'untag'].includes(command)) {
    if (!positional[0]) throw new Error(`${command} needs a session id or prefix`);
    const run = await loadRun(ctx, positional[0]);
    bookmarkRun(ctx.directory, run, { label: flags.label, workflowRun: flags['workflow-run'], remove: command === 'untag' });
    console.log(`${command === 'tag' ? 'Bookmarked' : 'Removed bookmark for'} ${run.source}:${run.rootId}`);
    return;
  }
  if (['render', 'outline', 'transcript'].includes(command)) {
    const id = positional[0];
    if (!id) throw new Error(`${command} needs a session id or prefix`);
    const run = await loadRun(ctx, id);
    if (command === 'outline') { console.log(flags.json ? JSON.stringify(run.outline, null, 2) : outlineMarkdown(run)); return; }
    if (command === 'transcript') { console.log(flags.json ? JSON.stringify(run, null, 2) : transcriptMarkdown(run)); return; }
    const html = renderRunPage(clipRun(run, ctx.limits), { limits: ctx.limits });
    const out = flags.out ? path.resolve(String(flags.out)) : defaultOut(ctx, run);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    const root = run.sessions[0];
    console.log(`${run.source} ${run.rootId}: ${run.sessions.length} session(s), ${root.stats.toolCalls} tool calls in root, ${(html.length / 1e6).toFixed(1)} MB → ${out}`);
    if (flags.open) openInBrowser(out);
    return;
  }
  if (command === 'serve') {
    const port = Number(flags.port || 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
    const server = await serve(ctx, port);
    const actualPort = server.address().port;
    console.log(`Traceview for ${ctx.directory} at http://127.0.0.1:${actualPort}/  (sources: ${ctx.source}; Ctrl-C to stop)`);
    if (flags.open) openInBrowser(`http://127.0.0.1:${actualPort}/`);
    return;
  }
  throw new Error(`Unknown command "${command}". Commands: list, render, outline, transcript, tag, untag, serve`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
