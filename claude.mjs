// Claude Code transcript reader: ~/.claude/projects/<dir-slug>/<session>.jsonl plus
// <session>/subagents/agent-<id>.jsonl (+ .meta.json) for native sub-agents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSession, makeTurn, firstLine, buildRun } from './model.mjs';

export const DEFAULT_CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

export function claudeProjectDir(directory, projectsDir = DEFAULT_CLAUDE_PROJECTS) {
  return path.join(projectsDir, path.resolve(directory).replace(/[^A-Za-z0-9]/g, '-'));
}

const NOTIFICATION = /<task-notification>/;
// A session counts as a CNC run when a prompt or tool call invokes the skill or the stage helper.
const CNC_RUN = /cnc-program|workflow\.mjs|cnc-plan\.js|cnc-build\.js/;
// Slash commands arrive as <command-name>/x</command-name><command-args>…</command-args>.
const commandLabel = text => {
  const name = tag(text, 'command-name'), args = tag(text, 'command-args');
  return name ? `${name}${args ? ` ${args}` : ''}` : '';
};
const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || '';

function imageAttachment(source, limits) {
  const a = { type: 'image', mediaType: source?.media_type || 'image/png' };
  if (source?.type === 'base64' && typeof source.data === 'string') {
    a.size = source.data.length;
    if (a.size <= (limits.maxImage ?? Infinity)) a.data = source.data; else a.omitted = true;
  } else if (source?.type === 'url') a.url = source.url;
  return a;
}

function contentToText(content, attachments, limits) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') { out.push(String(b)); continue; }
    if (b.type === 'text') out.push(b.text || '');
    else if (b.type === 'image') attachments?.push(imageAttachment(b.source, limits));
    else if (b.type === 'document') attachments?.push({ type: 'document', name: b.title || b.source?.media_type || 'document' });
    else out.push(JSON.stringify(b));
  }
  return out.join('\n');
}

// Parse one transcript file (main session or sub-agent) into a session.
export function parseClaudeTranscript(file, opts = {}) {
  const limits = { maxImage: 400_000, ...opts };
  const inlineFiles = opts.inlineFiles !== false;
  const s = makeSession({ source: 'claude', id: path.basename(file, '.jsonl').replace(/^agent-/, '') });
  const pending = new Map(), usage = new Map(), models = new Map();
  let turn = null;
  const ensureTurn = at => { if (!turn) { turn = makeTurn({ index: s.turns.length, at }); s.turns.push(turn); } return turn; };
  const push = block => ensureTurn(block.at).blocks.push(block);

  const classify = (rec, text, reminders) => {
    if (rec.isCompactSummary) return 'compact';
    if (NOTIFICATION.test(text)) return 'notification';
    if (rec.isMeta) return 'meta';
    if (!text.trim() && reminders.length) return 'reminder';
    if (/^\s*<(local-command-caveat|local-command-stdout|local-command-stderr)/.test(text)) return 'meta';
    return 'prompt';
  };

  const toolResult = (b, rec, at) => {
    const attachments = [];
    const out = contentToText(b.content, attachments, limits);
    const blk = pending.get(b.tool_use_id);
    if (!blk) { push({ kind: 'system', level: 'info', label: 'orphan-result', at, text: out }); return; }
    pending.delete(b.tool_use_id);
    blk.output = out;
    blk.status = b.is_error ? 'error' : 'ok';
    blk.endedAt = at;
    if (at && blk.at) blk.durationMs = at - blk.at;
    if (attachments.length) blk.attachments = attachments;
    const r = rec.toolUseResult;
    if (r && typeof r === 'object') {
      blk.details = r;
      if (typeof r.agentId === 'string') blk.agentRef = r.agentId;
      if (r.status === 'async_launched') blk.async = true;
      if (typeof r.stderr === 'string' && r.stderr.trim() && !out.includes(r.stderr.trim())) blk.stderr = r.stderr;
      if (r.interrupted) blk.status = 'error';
    }
    const saved = out.match(/Full output saved to: (\/[^\s]+)/);
    if (saved) {
      blk.outputFile = saved[1];
      if (inlineFiles) {
        try { blk.output = fs.readFileSync(saved[1], 'utf8'); blk.outputPreview = out; blk.outputInlined = true; } catch { /* keep the preview */ }
      }
    }
  };

  const userRecord = (rec, m, at) => {
    const c = m.content;
    if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) {
      for (const b of c) if (b?.type === 'tool_result') toolResult(b, rec, at);
      return;
    }
    const attachments = [], reminders = [];
    let text;
    if (Array.isArray(c)) {
      const parts = [];
      for (const b of c) {
        if (b?.type === 'text') { if (/^\s*<system-reminder>/.test(b.text || '')) reminders.push(b.text); else parts.push(b.text || ''); }
        else if (b?.type === 'image') attachments.push(imageAttachment(b.source, limits));
        else if (b) parts.push(JSON.stringify(b));
      }
      text = parts.join('\n\n');
    } else text = c == null ? '' : String(c);
    const kind = classify(rec, text, reminders);
    if (kind === 'prompt') {
      const command = /^\s*<command-name>/.test(text) ? commandLabel(text) : '';
      turn = makeTurn({ index: s.turns.length, at, prompt: { kind: 'user', text: command || text, raw: command ? text : undefined, command: command || undefined, attachments, reminders, at } });
      s.turns.push(turn);
      if (!s.prompt) s.prompt = text;
      return;
    }
    if (kind === 'notification') {
      push({ kind: 'notification', at, text, taskId: tag(text, 'task-id'), toolCallId: tag(text, 'tool-use-id'), status: tag(text, 'status'), summary: tag(text, 'summary'), outputFile: tag(text, 'output-file') });
      return;
    }
    push({ kind: 'system', level: kind === 'compact' ? 'notice' : 'info', label: kind, at, text: text || reminders.join('\n\n'), reminders: text ? reminders : [] });
  };

  const assistantRecord = (rec, m, at) => {
    if (m.usage && m.id) usage.set(m.id, m.usage);
    if (m.model) models.set(m.model, (models.get(m.model) || 0) + 1);
    if (rec.isApiErrorMessage) { push({ kind: 'system', level: 'error', label: 'api-error', at, text: contentToText(m.content, null, limits) }); return; }
    const c = m.content;
    if (typeof c === 'string') { if (c.trim()) push({ kind: 'text', at, text: c }); return; }
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'thinking') { if ((b.thinking || '').trim()) push({ kind: 'reasoning', at, text: b.thinking }); }
      else if (b.type === 'text') { if ((b.text || '').trim()) push({ kind: 'text', at, text: b.text }); }
      else if (b.type === 'tool_use' || b.type === 'server_tool_use') { const blk = { kind: 'tool', id: b.id, name: b.name, input: b.input, at, status: 'running', output: '' }; push(blk); pending.set(b.id, blk); }
      else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') { const blk = pending.get(b.tool_use_id); if (blk) { blk.output = JSON.stringify(b.content, null, 2); blk.status = 'ok'; blk.endedAt = at; pending.delete(b.tool_use_id); } }
      else if (b.type === 'fallback') push({ kind: 'system', level: 'warning', label: 'fallback', at, text: `Model fallback: ${b.from?.model} → ${b.to?.model}` });
      else if (b.type !== 'redacted_thinking') push({ kind: 'system', level: 'info', label: b.type, at, text: JSON.stringify(b).slice(0, 2000) });
    }
  };

  const systemRecord = (rec, at) => {
    const sub = rec.subtype || 'system';
    if (sub === 'stop_hook_summary' || sub === 'turn_duration') return;
    if (sub === 'compact_boundary') { push({ kind: 'system', level: 'notice', label: 'compact', at, text: `Context compacted (${rec.compactMetadata?.trigger || 'auto'})` }); return; }
    if (typeof rec.content === 'string' && rec.content.trim()) push({ kind: 'system', level: rec.level === 'error' ? 'error' : rec.level === 'warning' ? 'warning' : 'info', label: sub, at, text: rec.content });
  };

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { s.notes.push('Skipped an unparseable transcript line'); continue; }
    const at = rec.timestamp ? Date.parse(rec.timestamp) : null;
    if (rec.type === 'ai-title') { if (rec.aiTitle) s.title = rec.aiTitle; continue; }
    if (rec.type === 'cost-state') { if (typeof rec.totalCostUSD === 'number') s.cost = rec.totalCostUSD; continue; }
    if (rec.type === 'system') { systemRecord(rec, at); continue; }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (at) { s.startedAt ??= at; s.endedAt = at; }
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (!s.version && rec.version) s.version = rec.version;
    const m = rec.message || {};
    if (rec.type === 'user') userRecord(rec, m, at); else assistantRecord(rec, m, at);
  }
  for (const blk of pending.values()) if (blk.status === 'running') blk.status = 'incomplete';
  for (const u of usage.values()) {
    s.tokens.input += u.input_tokens || 0; s.tokens.output += u.output_tokens || 0;
    s.tokens.cacheRead += u.cache_read_input_tokens || 0; s.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
    s.tokens.reasoning += u.output_tokens_details?.thinking_tokens || 0;
  }
  s.model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  if (!s.title) s.title = firstLine(s.prompt, 80) || s.id;
  return s;
}

export function listClaudeSessionFiles(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  return fs.readdirSync(projectDir).filter(n => n.endsWith('.jsonl')).map(n => path.join(projectDir, n));
}

// Exact id or unique prefix → transcript path (null when nothing matches).
export function resolveClaudeSession(projectDir, id) {
  const files = listClaudeSessionFiles(projectDir);
  const exact = files.find(f => path.basename(f, '.jsonl') === id);
  if (exact) return exact;
  const hits = files.filter(f => path.basename(f, '.jsonl').startsWith(id));
  if (hits.length > 1) throw new Error(`Ambiguous Claude session prefix ${id}: ${hits.map(f => path.basename(f, '.jsonl')).join(', ')}`);
  return hits[0] || null;
}

export function listClaudeSessions({ projectDir }) {
  const rows = [];
  for (const file of listClaudeSessionFiles(projectDir)) {
    const id = path.basename(file, '.jsonl');
    const text = fs.readFileSync(file, 'utf8');
    const row = { source: 'claude', id, title: '', directory: '', startedAt: null, endedAt: null, prompts: 0, toolCalls: 0, children: 0, cost: 0, model: '', tags: [], sizeBytes: text.length, file };
    let firstPrompt = '', cncRun = false;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === 'ai-title') { if (rec.aiTitle) row.title = rec.aiTitle; continue; }
      if (rec.type === 'cost-state') { if (typeof rec.totalCostUSD === 'number') row.cost = rec.totalCostUSD; continue; }
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      if (rec.timestamp) { const at = Date.parse(rec.timestamp); row.startedAt ??= at; row.endedAt = at; }
      if (!row.directory && rec.cwd) row.directory = rec.cwd;
      const c = rec.message?.content;
      if (rec.type === 'assistant') {
        if (rec.message?.model && !row.model) row.model = rec.message.model;
        if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use') { row.toolCalls++; if (!cncRun && CNC_RUN.test(JSON.stringify(b.input || ''))) cncRun = true; }
        continue;
      }
      if (rec.isMeta || (Array.isArray(c) && c.some(b => b?.type === 'tool_result'))) continue;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text' && !/^\s*<system-reminder>/.test(b.text || '')).map(b => b.text).join('\n') : '';
      if (!t.trim() || /^\s*<(task-notification|local-command)/.test(t)) continue;
      row.prompts++;
      if (!firstPrompt) firstPrompt = t;
      if (!cncRun && CNC_RUN.test(t)) cncRun = true;
    }
    if (!row.title) row.title = firstLine(firstPrompt, 80) || id;
    const subDir = path.join(projectDir, id, 'subagents');
    if (fs.existsSync(subDir)) row.children = fs.readdirSync(subDir).filter(n => n.endsWith('.jsonl')).length;
    if (cncRun) row.tags.push('cnc-program');
    rows.push(row);
  }
  return rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

// Load a root session and its sub-agents into a run.
export function loadClaudeRun({ projectDir, id, ...opts }) {
  const file = resolveClaudeSession(projectDir, id);
  if (!file) throw new Error(`No Claude session matching ${id} in ${projectDir}`);
  const root = parseClaudeTranscript(file, opts);
  root.id = path.basename(file, '.jsonl');
  const subs = [];
  const subDir = path.join(projectDir, root.id, 'subagents');
  if (fs.existsSync(subDir)) {
    for (const name of fs.readdirSync(subDir).sort()) {
      if (!name.endsWith('.jsonl')) continue;
      const sub = parseClaudeTranscript(path.join(subDir, name), opts);
      sub.id = name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      sub.parentId = root.id;
      const metaFile = path.join(subDir, name.replace(/\.jsonl$/, '.meta.json'));
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          sub.agentType = meta.agentType || '';
          if (meta.description) sub.title = meta.description;
          sub.spawnedBy = { toolCallId: meta.toolUseId || null, sessionId: null };
          if (meta.spawnDepth != null) sub.spawnDepth = meta.spawnDepth;
        } catch { sub.notes.push('Unreadable .meta.json'); }
      }
      subs.push(sub);
    }
  }
  const all = [root, ...subs];
  const byTool = new Map();
  for (const sess of all) for (const t of sess.turns) for (const b of t.blocks) if (b.kind === 'tool') byTool.set(b.id, { sess, b });
  const byAgent = new Map(subs.map(sub => [sub.id, sub]));
  for (const sub of subs) {
    const hit = sub.spawnedBy?.toolCallId ? byTool.get(sub.spawnedBy.toolCallId) : null;
    if (hit) { sub.parentId = hit.sess.id; sub.spawnedBy.sessionId = hit.sess.id; hit.b.childSessionId = sub.id; }
  }
  for (const sess of all) for (const t of sess.turns) for (const b of t.blocks) {
    if (b.kind === 'tool' && !b.childSessionId && b.agentRef && byAgent.has(b.agentRef)) {
      b.childSessionId = b.agentRef;
      const sub = byAgent.get(b.agentRef);
      sub.parentId = sess.id; sub.spawnedBy = { toolCallId: b.id, sessionId: sess.id };
    }
    if (b.kind === 'notification') {
      const launcher = b.toolCallId ? byTool.get(b.toolCallId) : null;
      const childId = launcher?.b.childSessionId || (byAgent.has(b.taskId) ? b.taskId : null);
      if (childId) { b.childSessionId = childId; const sub = byAgent.get(childId); if (sub && b.summary && !sub.result) sub.result = b.summary; }
    }
  }
  return buildRun(root, all);
}
