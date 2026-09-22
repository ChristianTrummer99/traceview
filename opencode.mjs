// OpenCode reader: ~/.local/share/opencode/opencode.db (SQLite; session/message/part
// tables with JSON `data`). Sub-agents are sessions whose parent_id is the caller,
// launched by the `task` tool whose metadata.sessionId names the child.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSession, makeTurn, firstLine, buildRun } from './model.mjs';

export const DEFAULT_OPENCODE_DB = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');

const quote = v => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// Prefer the built-in node:sqlite (Node 22.5+); fall back to the sqlite3 CLI.
export async function openOpenCodeDatabase(file = DEFAULT_OPENCODE_DB) {
  if (!fs.existsSync(file)) throw new Error(`OpenCode database not found: ${file}`);
  let sqlite = null;
  try { sqlite = await import('node:sqlite'); } catch { /* handled below */ }
  if (sqlite?.DatabaseSync) {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    return { file, backend: 'node:sqlite', all: (sql, params = []) => db.prepare(sql).all(...params).map(r => ({ ...r })), close: () => db.close() };
  }
  const probe = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) throw new Error('Reading the OpenCode database needs Node 22.5+ (node:sqlite) or the sqlite3 CLI');
  return {
    file, backend: 'sqlite3',
    all: (sql, params = []) => {
      let i = 0;
      const inlined = sql.replace(/\?/g, () => quote(params[i++]));
      const r = spawnSync('sqlite3', ['-readonly', '-json', file, inlined], { encoding: 'utf8', maxBuffer: 1 << 30 });
      if (r.status !== 0) throw new Error(r.stderr || 'sqlite3 failed');
      return r.stdout.trim() ? JSON.parse(r.stdout) : [];
    },
    close: () => {},
  };
}

const parseJson = (text, fallback = {}) => { try { return JSON.parse(text); } catch { return fallback; } };
const modelLabel = value => {
  const m = typeof value === 'string' ? parseJson(value, null) : value;
  if (!m || typeof m !== 'object') return typeof value === 'string' ? value : '';
  const id = m.id || m.modelID || '';
  return m.providerID ? `${m.providerID}/${id}` : id;
};

export function listOpenCodeSessions({ db, directory = '', includeChildren = false }) {
  const columns = new Set(db.all('pragma table_info(session)').map(c => c.name));
  const optional = ['agent', 'model', 'cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write']
    .map(name => columns.has(name) ? `s.${name}` : `NULL as ${name}`).join(', ');
  const rows = db.all(
    `select s.id, s.parent_id, s.title, s.directory, ${optional}, s.time_created, s.time_updated, s.version,
       (select count(*) from session c where c.parent_id = s.id) as children,
       (select count(*) from part p where p.session_id = s.id and json_extract(p.data, '$.type') = 'tool') as tool_calls,
       (select count(*) from message m where m.session_id = s.id and json_extract(m.data, '$.role') = 'user') as prompts
     from session s
     where (? = '' or s.directory = ? or substr(s.directory, 1, length(?)) = ?) and (? = 1 or s.parent_id is null)
     order by s.time_created desc`,
    [directory, directory, directory + path.sep, directory + path.sep, includeChildren ? 1 : 0]);
  return rows.map(r => ({
    source: 'opencode', id: r.id, parentId: r.parent_id, title: r.title, directory: r.directory, agentType: r.agent || '',
    model: modelLabel(r.model), cost: r.cost || 0, startedAt: r.time_created, endedAt: r.time_updated,
    tokens: { input: r.tokens_input, output: r.tokens_output }, children: r.children, toolCalls: r.tool_calls, prompts: r.prompts,
    version: r.version, tags: [],
  }));
}

function partBlock(p, limits) {
  const d = p.data;
  const at = d.time?.start || p.time_created;
  switch (d.type) {
    case 'text': return { kind: 'text', at, text: d.text || '' };
    case 'reasoning': return { kind: 'reasoning', at, text: d.text || '' };
    case 'tool': {
      const st = d.state || {};
      const status = st.status === 'completed' ? 'ok' : st.status === 'error' ? 'error' : st.status || 'incomplete';
      const blk = {
        kind: 'tool', id: d.callID || p.id, name: d.tool || 'tool', input: st.input, output: st.output || '', status,
        error: st.error, title: st.title, at: st.time?.start || p.time_created, endedAt: st.time?.end || null,
        durationMs: st.time?.start && st.time?.end ? st.time.end - st.time.start : null, meta: st.metadata || null,
      };
      if (d.tool === 'task') blk.childSessionId = st.metadata?.sessionId || st.input?.task_id || st.output?.match(/(?:task_id:\s*|<task_id>)(ses_[A-Za-z0-9]+)/)?.[1] || null;
      if (st.metadata?.truncated) { blk.sourceTruncated = true; blk.outputFile = st.metadata.outputPath || null; }
      return blk;
    }
    case 'step-start': case 'step-finish': return null;
    case 'patch': return { kind: 'system', level: 'info', label: 'patch', at, text: `Patch ${d.hash || ''}\n${(d.files || []).join('\n')}` };
    case 'compaction': return { kind: 'system', level: 'notice', label: 'compact', at, text: `Context compacted (${d.auto ? 'auto' : 'manual'})` };
    case 'file': {
      const blk = { kind: 'system', level: 'info', label: 'file', at, text: `Attached file ${d.filename || ''} (${d.mime || ''})`, attachments: [] };
      if (d.mime?.startsWith('image/') && typeof d.url === 'string' && d.url.startsWith('data:')) {
        const data = d.url.slice(d.url.indexOf(',') + 1);
        blk.attachments.push({ type: 'image', mediaType: d.mime, size: data.length, ...(data.length <= (limits.maxImage ?? Infinity) ? { data } : { omitted: true }) });
      }
      return blk;
    }
    default: return { kind: 'system', level: 'info', label: d.type || 'part', at, text: JSON.stringify(d).slice(0, 2000) };
  }
}

function sessionFromRow(row, db, limits) {
  const s = makeSession({
    source: 'opencode', id: row.id, parentId: row.parent_id || null, title: row.title || row.id, agentType: row.agent || '',
    model: modelLabel(row.model), cwd: row.directory || '', version: row.version || '', startedAt: row.time_created, endedAt: row.time_updated,
    cost: row.cost || 0,
    tokens: { input: row.tokens_input || 0, output: row.tokens_output || 0, reasoning: row.tokens_reasoning || 0, cacheRead: row.tokens_cache_read || 0, cacheWrite: row.tokens_cache_write || 0 },
  });
  const messages = db.all('select id, data, time_created, time_updated from message where session_id = ? order by time_created, id', [row.id]);
  const parts = db.all('select id, message_id, data, time_created from part where session_id = ? order by time_created, id', [row.id]);
  const byMessage = new Map();
  for (const p of parts) { const list = byMessage.get(p.message_id) || []; list.push({ ...p, data: parseJson(p.data) }); byMessage.set(p.message_id, list); }
  let turn = null;
  const ensureTurn = at => { if (!turn) { turn = makeTurn({ index: s.turns.length, at }); s.turns.push(turn); } return turn; };
  for (const m of messages) {
    const d = parseJson(m.data);
    const at = d.time?.created || m.time_created;
    const list = byMessage.get(m.id) || [];
    if (d.role === 'user') {
      const texts = [], attachments = [], extra = [];
      for (const p of list) {
        if (p.data.type === 'text') texts.push(p.data.text || '');
        else { const blk = partBlock(p, limits); if (!blk) continue; if (blk.attachments?.length && blk.label === 'file') attachments.push(...blk.attachments); else extra.push(blk); }
      }
      turn = makeTurn({ index: s.turns.length, at, prompt: { kind: 'user', text: texts.join('\n\n'), attachments, reminders: [], at } });
      s.turns.push(turn);
      turn.blocks.push(...extra);
      if (!s.prompt) s.prompt = turn.prompt.text;
      continue;
    }
    const t = ensureTurn(at);
    for (const p of list) { const blk = partBlock(p, limits); if (blk) t.blocks.push({ ...blk, partId: p.id, messageId: m.id }); }
    if (!s.model && d.modelID) s.model = [d.providerID, d.modelID].filter(Boolean).join('/');
    if (d.error) t.blocks.push({ kind: 'system', level: 'error', label: d.error.name || 'error', at: d.time?.completed || at, text: d.error.data?.message || JSON.stringify(d.error) });
    if (d.time?.completed && d.time.completed > (s.endedAt || 0)) s.endedAt = d.time.completed;
  }
  if (!s.title) s.title = firstLine(s.prompt, 80) || s.id;
  return s;
}

export function resolveOpenCodeSession(db, id) {
  const exact = db.all('select id from session where id = ?', [id]);
  if (exact.length) return exact[0].id;
  const hits = db.all('select id from session where substr(id, 1, length(?)) = ? order by time_created desc limit 5', [id, id]);
  if (hits.length > 1) throw new Error(`Ambiguous OpenCode session prefix ${id}: ${hits.map(h => h.id).join(', ')}`);
  return hits[0]?.id || null;
}

// Load a session and all descendants (parent_id chain) into a run.
export function loadOpenCodeRun({ db, id, ...opts }) {
  const limits = { maxImage: 400_000, ...opts };
  const rootId = resolveOpenCodeSession(db, id);
  if (!rootId) throw new Error(`No OpenCode session matching ${id}`);
  const rows = [];
  let frontier = db.all('select * from session where id = ?', [rootId]);
  const seen = new Set();
  while (frontier.length) {
    const next = [];
    for (const row of frontier) {
      if (seen.has(row.id)) continue;
      seen.add(row.id); rows.push(row);
      next.push(...db.all('select * from session where parent_id = ? order by time_created', [row.id]));
    }
    frontier = next;
  }
  const sessions = rows.map(row => sessionFromRow(row, db, limits));
  const byId = new Map(sessions.map(s => [s.id, s]));
  for (const s of sessions) for (const t of s.turns) for (const b of t.blocks) {
    if (b.kind === 'tool' && b.childSessionId && byId.has(b.childSessionId)) {
      const child = byId.get(b.childSessionId);
      child.spawnedBy ??= { sessionId: s.id, toolCallId: b.id };
      if (!child.prompt && typeof b.input?.prompt === 'string') child.prompt = b.input.prompt;
    }
  }
  return buildRun(sessions[0], sessions);
}
