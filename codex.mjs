// Codex rollouts are append-only JSONL. Use the original records rather than
// version-specific SQLite UI projections. Never execute or decrypt their content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { buildRun, firstLine, makeSession, makeTurn, summarizeSession } from './model.mjs';

export const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const metadataCache = new Map(), summaryCache = new Map();
const json = (value, fallback = null) => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return fallback; } };
const time = value => { const ms = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const nameOf = name => String(name || 'tool').split('.').at(-1);
const typeOf = value => String(value || '').replace(/[_-]/g, '').toLowerCase();
const stamp = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const fingerprint = text => createHash('sha256').update(text).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// Read a bounded snapshot, including a possibly partial last line, without
// keeping a second copy of an entire rollout string in memory.
function* records(file) {
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(64 * 1024);
  let pending = '', line = 0, remaining = fs.fstatSync(fd).size;
  const parse = raw => {
    line++;
    if (!raw.trim()) return null;
    const value = json(raw);
    return value && typeof value === 'object' ? { ...value, line } : { type: 'parse_error', line };
  };
  try {
    while (remaining > 0) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!count) break;
      remaining -= count; pending += decoder.write(buffer.subarray(0, count));
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const row = parse(pending.slice(0, at)); pending = pending.slice(at + 1);
        if (row) yield row;
      }
    }
    pending += decoder.end();
    if (pending.trim()) yield parse(pending);
  } finally { fs.closeSync(fd); }
}

function metadata(file) {
  const stat = fs.statSync(file), key = stamp(stat), previous = metadataCache.get(file);
  if (previous?.key === key) return previous.value;
  let meta = null;
  for (const rec of records(file)) {
    if (rec.type === 'session_meta') { meta = rec.payload; break; }
    if (rec.line >= 20) break;
  }
  if (!meta?.id) return null;
  const source = json(meta.source, meta.source), spawn = source?.subagent?.thread_spawn;
  const value = {
    source: 'codex', id: meta.id, file, directory: meta.cwd || '',
    parentId: meta.parent_thread_id || spawn?.parent_thread_id || null,
    agentPath: meta.agent_path || spawn?.agent_path || '',
    agentType: meta.agent_role || spawn?.agent_role || meta.thread_source || source?.subagent?.other || (typeof source === 'string' ? source : 'subagent'),
    agentNickname: meta.agent_nickname || spawn?.agent_nickname || '',
    isSubagent: !!source?.subagent, version: meta.cli_version || '',
    startedAt: time(meta.timestamp), endedAt: stat.mtimeMs, sizeBytes: stat.size,
    forkedFrom: meta.forked_from_id || null,
  };
  metadataCache.set(file, { key, value });
  return value;
}

export function discoverCodexSessions(home = DEFAULT_CODEX_HOME) {
  const files = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(file);
    }
  };
  visit(path.join(home, 'sessions')); visit(path.join(home, 'archived_sessions'));
  const byId = new Map();
  for (const file of files.sort()) {
    const row = metadata(file);
    if (!row) continue;
    // During archival a file may briefly exist in both trees. Prefer the newer
    // copy, then the larger one, instead of showing a duplicate session.
    const old = byId.get(row.id);
    if (!old || row.endedAt > old.endedAt || (row.endedAt === old.endedAt && row.sizeBytes > old.sizeBytes)) byId.set(row.id, row);
  }
  const index = path.join(home, 'session_index.jsonl'), titles = new Map();
  if (fs.existsSync(index)) for (const r of records(index)) if (r.id && typeof r.thread_name === 'string') titles.set(r.id, r.thread_name);
  return [...byId.values()].map(r => ({ ...r, title: titles.get(r.id) || '' }));
}

export function resolveCodexSession(rows, id) {
  const exact = rows.find(s => s.id === id);
  if (exact) return exact;
  const hits = rows.filter(s => s.id.startsWith(id));
  if (hits.length > 1) throw new Error(`Ambiguous Codex session prefix ${id}: ${hits.map(s => s.id).join(', ')}`);
  return hits[0] || null;
}

function content(value, maxImage = 400_000) {
  const texts = [], attachments = []; let encrypted = 0;
  for (const part of Array.isArray(value) ? value : [value]) {
    if (part == null) continue;
    if (typeof part === 'string') { texts.push(part); continue; }
    const type = typeOf(part.type);
    if (part.encrypted_content || type === 'encryptedcontent') { encrypted++; texts.push('[Encrypted content unavailable]'); }
    else if (typeof part.text === 'string') texts.push(part.text);
    else if (['inputimage', 'outputimage', 'image'].includes(type)) {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || part.url;
      const image = typeof url === 'string' && url.match(/^data:(image\/[\w.+-]+);base64,([\s\S]*)$/);
      if (image) attachments.push({ type: 'image', mediaType: image[1], size: image[2].length, ...(image[2].length <= maxImage ? { data: image[2] } : { omitted: true }) });
      else attachments.push({ type: 'image', mediaType: part.mime_type || 'image', omitted: true });
    } else texts.push(JSON.stringify(part));
  }
  return { text: texts.join('\n'), attachments, encrypted };
}

function safeRecord(value) {
  if (Array.isArray(value)) return value.map(safeRecord);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'encrypted_content' ? '[Encrypted content unavailable]' : safeRecord(v)]));
  return value;
}

const isInjected = p => {
  const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds || [];
  if (kinds.some(k => k.startsWith('user.'))) return false;
  return /^\s*(?:# AGENTS\.md instructions for |<(?:environment_context|permissions instructions|recommended_plugins|system-reminder|skills_instructions)>)/.test(content(p.content).text);
};
const sourceStatus = value => ['failed', 'error', 'declined', 'cancelled', 'interrupted'].includes(value) ? 'error' : ['completed', 'success'].includes(value) ? 'ok' : 'incomplete';

export function parseCodexTranscript(file, opts = {}) {
  const meta = opts.metadata || metadata(file);
  if (!meta) throw new Error(`No Codex session metadata in ${file}`);
  const s = makeSession({ ...meta, cwd: meta.directory, title: opts.title || meta.title || '', turns: [], endedAt: meta.startedAt });
  const rows = []; let turnId = null, encryptedReasoning = 0, encryptedMessages = 0, malformed = 0;
  for (const rec of records(file)) {
    if (rec.type === 'parse_error') { malformed++; continue; }
    const p = object(rec.payload);
    if (rec.type === 'turn_context' || (rec.type === 'event_msg' && p.type === 'task_started')) turnId = p.turn_id || turnId;
    rows.push({ ...rec, at: time(rec.timestamp), turnId: p.internal_chat_message_metadata_passthrough?.turn_id || p.turn_id || turnId });
  }

  // UI events mirror response records. Compare exact content/identity in the same
  // source turn (or coincident timestamp in older logs), never similarity.
  const canonical = new Map(), callIds = new Set();
  for (const r of rows) if (r.type === 'response_item') {
    const p = object(r.payload);
    if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) callIds.add(p.call_id || p.id);
    const role = p.type === 'reasoning' ? 'reasoning' : p.type === 'message' ? p.role : null;
    if (!role) continue;
    const text = content(p.type === 'reasoning' ? [...(p.summary || []), ...(p.content || [])] : p.content).text;
    if (!text) continue;
    const key = `${role}:${fingerprint(text)}`, list = canonical.get(key) || [];
    list.push(r); canonical.set(key, list);
  }
  const mirrored = (role, text, r) => (canonical.get(`${role}:${fingerprint(text)}`) || []).some(c => (c.turnId && c.turnId === r.turnId) || (c.at != null && r.at != null && Math.abs(c.at - r.at) <= 1000));
  const tools = new Map(), turnMap = new Map(), eventItems = new Map(), messages = new Set();
  let current = null, usage = null;
  const ensureTurn = r => {
    if (r.turnId && turnMap.has(r.turnId)) current = turnMap.get(r.turnId);
    else if (!current || (r.turnId && current.sourceTurnId !== r.turnId)) {
      current = makeTurn({ index: s.turns.length, at: r.at, sourceTurnId: r.turnId });
      s.turns.push(current); if (r.turnId) turnMap.set(r.turnId, current);
    }
    return current;
  };
  const push = (b, r) => { ensureTurn(r).blocks.push({ ...b, at: b.at ?? r.at, sourceLine: r.line, sourceOrdinal: r.ordinal ?? null }); return ensureTurn(r).blocks.at(-1); };
  const user = (value, r) => {
    let t = ensureTurn(r);
    if (t.prompt || t.blocks.some(b => b.kind !== 'system')) {
      t = makeTurn({ index: s.turns.length, at: r.at, sourceTurnId: r.turnId });
      s.turns.push(t); current = t; if (r.turnId) turnMap.set(r.turnId, t);
    }
    t.prompt = { kind: 'user', ...value, reminders: [], at: r.at, sourceLine: r.line };
    if (!s.prompt) s.prompt = value.text;
  };
  const newTool = (p, r) => {
    const id = p.call_id || p.id || `line-${r.line}`, name = nameOf(p.name || 'shell');
    let input = p.arguments !== undefined ? json(p.arguments, { raw_arguments: p.arguments }) : p.input ?? p.action ?? {};
    if (typeof input === 'string') input = name === 'apply_patch' ? { patchText: input } : name === 'exec' ? { code: input } : input;
    const b = push({ kind: 'tool', id, name, input, output: '', status: 'incomplete', meta: { sourceType: p.type, originalName: p.name, turnId: r.turnId } }, r);
    tools.set(id, b); return b;
  };
  const finishTool = (p, r) => {
    const out = content(p.output, opts.maxImage), b = tools.get(p.call_id);
    if (!b) { push({ kind: 'system', label: 'orphan-result', level: 'notice', text: out.text }, r); return; }
    b.output = out.text; b.attachments = out.attachments; b.endedAt = r.at;
    b.durationMs = b.at != null && r.at != null ? r.at - b.at : null;
    const result = object(json(out.text));
    const exit = result.exit_code ?? result.metadata?.exit_code ?? out.text.match(/^(?:Process exited with code|Exit code:)\s*(-?\d+)\s*$/m)?.[1];
    b.status = p.is_error || result.is_error || (exit != null && Number(exit) !== 0) || /^(?:Error parsing function call:|Script failed|Error executing tool)/.test(out.text) ? 'error' : b.status === 'error' ? 'error' : 'ok';
    if (b.status === 'error') b.error = out.text;
    b.sourceTruncated = /^(?:Warning: truncated output|Original token count:|\.\.\. \d+ (?:bytes|tokens) omitted)/m.test(out.text);
    if (b.name === 'spawn_agent') b.agentRef = result.agent_id || result.thread_id || result.agent_path || result.task_name || result.path || null;
  };

  function itemEvent(item, r, event) {
    const type = typeOf(item.type), value = content(item.content, opts.maxImage);
    if (['usermessage', 'agentmessage', 'reasoning'].includes(type)) {
      const role = type === 'usermessage' ? 'user' : type === 'agentmessage' ? 'assistant' : 'reasoning';
      const text = role === 'reasoning' ? content([...(item.summary_text || item.summaryText || []), ...(item.raw_content || item.rawContent || [])]).text : value.text || item.text || '';
      if (!text || mirrored(role, text, r) || eventItems.has(item.id)) return;
      eventItems.set(item.id, true);
      if (role === 'user') user({ ...value, text }, r); else push({ kind: role === 'reasoning' ? 'reasoning' : 'text', text, messageId: item.id }, r);
      return;
    }
    const known = ['commandexecution', 'filechange', 'mcptoolcall', 'collabagenttoolcall', 'websearch', 'imageview'];
    if (!known.includes(type)) {
      if (type === 'contextcompaction') push({ kind: 'system', label: 'compact', level: 'notice', text: 'Context compacted.' }, r);
      return;
    }
    // Matching call IDs enrich the original call. Different IDs inside an exec
    // wrapper are distinct observed executions, retained with explicit labels.
    let b = tools.get(item.id) || eventItems.get(item.id);
    if (!b && callIds.has(item.id)) return; // response record will provide it
    const name = type === 'commandexecution' ? 'exec_command' : type === 'filechange' ? 'apply_patch' : type === 'mcptoolcall' ? `${item.server || 'mcp'}.${item.tool || 'call'}` : type === 'collabagenttoolcall' ? nameOf(item.tool) : type === 'imageview' ? 'view_image' : 'web_search';
    if (!b) {
      const input = type === 'commandexecution' ? { command: item.command, workdir: item.cwd } : type === 'filechange' ? { changes: item.changes } : type === 'mcptoolcall' ? item.arguments : type === 'collabagenttoolcall' ? { prompt: item.prompt, receiver_thread_ids: item.receiver_thread_ids || item.receiverThreadIds } : item.action || { path: item.path };
      b = push({ kind: 'tool', id: item.id || `event-${r.line}`, name, input, output: '', status: 'incomplete', meta: { observedExecution: true, sourceType: item.type } }, r);
      eventItems.set(item.id, b);
    }
    b.status = item.exit_code != null && item.exit_code !== 0 ? 'error' : sourceStatus(item.status);
    b.output = item.aggregated_output ?? item.aggregatedOutput ?? item.stdout ?? (item.result != null ? content(item.result, opts.maxImage).text : b.output);
    if (item.stderr) b.stderr = item.stderr;
    if (item.error) { b.error = typeof item.error === 'string' ? item.error : JSON.stringify(item.error); b.status = 'error'; }
    if (item.exit_code != null && item.exit_code !== 0) b.error ||= `Process exited with code ${item.exit_code}`;
    b.at = event.started_at_ms ?? b.at; b.endedAt = event.completed_at_ms ?? r.at;
    b.durationMs = item.duration_ms ?? (item.duration ? item.duration.secs * 1000 + (item.duration.nanos || 0) / 1e6 : b.endedAt != null && b.at != null ? b.endedAt - b.at : null);
    if (type === 'collabagenttoolcall') {
      const ids = item.receiver_thread_ids || item.receiverThreadIds || [];
      if (ids.length === 1) b.agentRef = ids[0];
      b.output ||= JSON.stringify(safeRecord(item), null, 2);
    }
  }

  for (const r of rows) {
    const p = object(r.payload);
    if (r.at != null) { s.startedAt ??= r.at; s.endedAt = Math.max(s.endedAt || r.at, r.at); }
    if (r.type === 'session_meta') continue;
    if (r.type === 'turn_context') { s.model = p.model || s.model; s.cwd ||= p.cwd || ''; continue; }
    if (r.type === 'token_usage_record') { usage = p.thread_token_usage || usage; continue; }
    if (r.type === 'compacted') { push({ kind: 'system', label: 'compact', level: 'notice', text: p.message || 'Context compacted; replacement history is not replayed as new activity.' }, r); continue; }
    if (r.type === 'world_state') { push({ kind: 'system', label: 'workspace context', level: 'info', text: JSON.stringify(safeRecord(p), null, 2) }, r); continue; }
    if (r.type === 'event_msg') {
      if (p.type === 'token_count') { usage = p.info?.total_token_usage || usage; continue; }
      if (p.type === 'item_completed') { itemEvent(object(p.item), r, p); continue; }
      if (['user_message', 'agent_message', 'agent_reasoning'].includes(p.type)) {
        const role = p.type === 'user_message' ? 'user' : p.type === 'agent_message' ? 'assistant' : 'reasoning', text = p.message || p.text || '';
        if (text && !mirrored(role, text, r)) {
          if (role === 'user') user({ text, attachments: [] }, r);
          else push({ kind: role === 'reasoning' ? 'reasoning' : 'text', text }, r);
        }
      } else if (['turn_aborted', 'error', 'warning', 'context_compacted'].includes(p.type)) push({ kind: 'system', label: p.type, level: p.type === 'error' ? 'error' : 'notice', text: p.message || JSON.stringify(safeRecord(p)) }, r);
      continue;
    }
    if (r.type !== 'response_item') continue;
    if (p.id && messages.has(p.id)) continue;
    if (p.id) messages.add(p.id);
    if (p.type === 'message') {
      const value = content(p.content, opts.maxImage);
      if (p.role === 'user' && !isInjected(p)) user(value, r);
      else push({ kind: p.role === 'assistant' ? 'text' : 'system', label: p.role === 'user' ? 'injected context' : p.role, level: 'info', ...value, messageId: p.id }, r);
    } else if (p.type === 'reasoning') {
      const value = content([...(p.summary || []), ...(p.content || [])]);
      if (value.text) push({ kind: 'reasoning', text: value.text, messageId: p.id }, r);
      if (p.encrypted_content) encryptedReasoning++;
    } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) newTool(p, r);
    else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) finishTool(p, r);
    else if (p.type === 'agent_message') {
      const value = content(p.content, opts.maxImage); encryptedMessages += value.encrypted;
      if (/Message Type: NEW_TASK/.test(value.text)) user(value, r);
      else push({ kind: 'notification', text: value.text, summary: `Message from ${p.author || 'agent'}`, status: 'completed', agentRef: p.author, messageId: p.id }, r);
    } else push({ kind: 'system', label: p.type || 'response item', level: 'info', text: JSON.stringify(safeRecord(p), null, 2) }, r);
  }
  if (usage) s.tokens = { input: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)), cacheRead: usage.cached_input_tokens || 0, cacheWrite: usage.cache_write_input_tokens || 0, output: usage.output_tokens || 0, reasoning: usage.reasoning_output_tokens || 0 };
  if (encryptedReasoning) s.notes.push(`${encryptedReasoning} encrypted reasoning record(s) are not readable; only recorded plaintext is displayed.`);
  if (encryptedMessages) s.notes.push(`${encryptedMessages} inter-agent message payload(s) are encrypted and unavailable.`);
  if (malformed) s.notes.push(`Skipped ${malformed} malformed or partial JSONL record(s).`);
  if (s.forkedFrom) s.notes.push(`Forked from ${s.forkedFrom}; copied history is retained as context, not treated as a parent/child spawn.`);
  if (!s.title) s.title = s.agentPath && s.agentPath !== '/root' ? s.agentPath : firstLine(s.prompt, 100) || s.id;
  s.stats = summarizeSession(s);
  return s;
}

export function listCodexSessions({ home = DEFAULT_CODEX_HOME, directory = '', includeChildren = false }) {
  const rows = discoverCodexSessions(home), children = new Map();
  for (const r of rows) if (r.parentId) children.set(r.parentId, (children.get(r.parentId) || 0) + 1);
  return rows.filter(r => (includeChildren || (!r.parentId && !r.isSubagent)) && (!directory || r.directory === directory || r.directory.startsWith(directory + path.sep))).map(row => {
    const key = stamp(fs.statSync(row.file)), cached = summaryCache.get(row.file);
    let summary = cached?.key === key ? cached.value : null;
    if (!summary) {
      const s = parseCodexTranscript(row.file, { metadata: row, maxImage: 0 });
      summary = { title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, model: s.model, tokens: s.tokens, prompts: s.stats.turns, toolCalls: s.stats.toolCalls };
      summaryCache.set(row.file, { key, value: summary });
    }
    return { ...row, ...summary, title: row.title || summary.title, children: children.get(row.id) || 0, tags: [], cost: 0 };
  }).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function loadCodexRun({ home = DEFAULT_CODEX_HOME, id, ...opts }) {
  const rows = discoverCodexSessions(home), root = resolveCodexSession(rows, id);
  if (!root) throw new Error(`No Codex session matching ${id}`);
  const loaded = new Map(), byId = new Map(rows.map(r => [r.id, r]));
  const visit = row => {
    if (loaded.has(row.id)) return;
    const s = parseCodexTranscript(row.file, { ...opts, metadata: row, title: row.title });
    loaded.set(row.id, s);
    for (const child of rows) if (child.parentId === row.id) visit(child);
    for (const t of s.turns) for (const b of t.blocks) if (b.name === 'spawn_agent' && b.agentRef && byId.has(b.agentRef)) {
      const child = byId.get(b.agentRef);
      if (!child.parentId && child.id !== root.id) visit({ ...child, parentId: s.id });
    }
  };
  visit(root);
  // Path-style identities are scoped to this run; ambiguous aliases never link.
  const aliases = new Map();
  for (const s of loaded.values()) if (s.agentPath) {
    const hits = aliases.get(s.agentPath) || []; hits.push(s.id); aliases.set(s.agentPath, hits);
  }
  const resolve = ref => loaded.has(ref) ? ref : aliases.get(ref)?.length === 1 ? aliases.get(ref)[0] : null;
  for (const s of loaded.values()) for (const t of s.turns) for (const b of t.blocks) {
    const target = b.agentRef || (['spawn_agent', 'send_message', 'send_input', 'resume_agent', 'followup_task', 'wait_agent', 'close_agent'].includes(b.name) ? b.input?.id || b.input?.target || b.input?.agent_id || b.input?.task_name : null);
    if (!target) continue;
    const linked = resolve(target);
    if (linked && loaded.get(linked).parentId === s.id) b.childSessionId = linked;
    else if (!linked && b.name === 'spawn_agent') b.childSessionId = target;
    else { b.meta = { ...b.meta, relatedAgent: target, relatedSessionId: linked }; continue; }
    // Only a spawn call establishes the original task assignment.
    if (b.name === 'spawn_agent' && loaded.has(b.childSessionId)) {
      const child = loaded.get(b.childSessionId);
      child.spawnedBy ??= { sessionId: s.id, toolCallId: b.id };
    }
  }
  return buildRun(loaded.get(root.id), [...loaded.values()]);
}
