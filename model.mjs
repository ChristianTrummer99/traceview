// Normalized transcript model shared by the OpenCode, Claude Code and Codex readers.
// A run is one root session plus every sub-agent session it spawned.
// Block kinds: text (assistant narration), reasoning, tool, notification
// (a background agent/task reporting back), system (compaction, errors, meta).

export function makeSession(fields = {}) {
  return {
    source: '', id: '', parentId: null, title: '', agentType: '', model: '', cwd: '', version: '',
    startedAt: null, endedAt: null, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    prompt: '', spawnedBy: null, children: [], turns: [], notes: [], stats: null,
    ...fields,
  };
}

export function makeTurn(fields = {}) {
  return { index: 0, at: null, prompt: null, blocks: [], ...fields };
}

export function firstLine(text, max = 120) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// One-line description of a tool call, used for collapsed headers and outlines.
export function toolSummary(block) {
  if (typeof block.input === 'string') return firstLine(block.input, 140);
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const name = String(block.name || '').toLowerCase();
  const pick = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k].trim()) return input[k]; return ''; };
  const where = input.path && typeof input.path === 'string' ? `  in ${input.path}` : '';
  let text = '';
  if (['bash', 'exec_command', 'shell_command', 'shell'].includes(name)) text = pick('description', 'command', 'cmd') || (Array.isArray(input.command) ? input.command.join(' ') : '');
  else if (name === 'exec') text = pick('code');
  else if (['read', 'edit', 'write', 'multiedit', 'notebookedit'].includes(name)) text = pick('file_path', 'filePath', 'path', 'notebook_path');
  else if (name === 'grep' || name === 'glob') text = `${pick('pattern')}${where}`;
  else if (name === 'agent' || name === 'task') text = `${pick('description')}${input.subagent_type ? ` (${input.subagent_type})` : ''}`;
  else if (['spawn_agent', 'followup_task'].includes(name)) text = pick('description', 'name', 'task_name', 'prompt', 'message');
  else if (name === 'webfetch') text = pick('url');
  else if (name === 'websearch') text = pick('query');
  else if (name === 'skill') text = pick('skill', 'name');
  else if (name === 'apply_patch') text = (pick('patchText', 'patch').match(/^\*\*\* (?:Add|Update|Delete) File: .+$/gm) || []).join(' · ') || (Array.isArray(input.changes) ? input.changes.map(c => c.path) : Object.keys(input.changes || {})).join(' · ');
  else if (name === 'todowrite') text = Array.isArray(input.todos) ? `${input.todos.length} todos` : '';
  else if (name === 'workflow') text = pick('scriptPath', 'name', 'title');
  else if (name === 'sendmessage') text = `to ${pick('to')}: ${pick('summary', 'message')}`;
  else if (name === 'question' || name === 'askuserquestion') text = Array.isArray(input.questions) ? input.questions.map(q => q?.question).filter(Boolean).join(' | ') : '';
  if (!text) text = Object.values(input).find(v => typeof v === 'string' && v.trim()) || '';
  if (!text && block.title) text = block.title;
  if (!text && Object.keys(input).length) text = JSON.stringify(input);
  return firstLine(text, 140);
}

export function summarizeSession(s) {
  const stats = {
    turns: s.turns.length, blocks: 0, toolCalls: 0, toolCounts: {}, errors: 0, reasoning: 0, text: 0,
    notifications: 0, agents: 0, toolMs: 0,
    durationMs: s.startedAt != null && s.endedAt != null ? s.endedAt - s.startedAt : null,
  };
  for (const t of s.turns) for (const b of t.blocks) {
    stats.blocks++;
    if (b.kind === 'tool') {
      stats.toolCalls++;
      stats.toolCounts[b.name] = (stats.toolCounts[b.name] || 0) + 1;
      if (b.status === 'error') stats.errors++;
      if (b.childSessionId) stats.agents++;
      if (b.durationMs) stats.toolMs += b.durationMs;
    } else if (b.kind === 'reasoning') stats.reasoning++;
    else if (b.kind === 'text') stats.text++;
    else if (b.kind === 'notification') stats.notifications++;
    else if (b.kind === 'system' && b.level === 'error') stats.errors++;
  }
  return stats;
}

// Link sessions into a tree, fill derived fields and order sessions root-first.
export function buildRun(root, sessions) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  for (const s of sessions) s.children = [];
  for (const s of sessions) if (s.id !== root.id && s.parentId && byId.has(s.parentId)) byId.get(s.parentId).children.push(s.id);
  for (const s of sessions) for (const t of s.turns) for (const b of t.blocks) {
    if (b.kind === 'tool') b.summary = toolSummary(b);
    if (!b.childSessionId) continue;
    const child = byId.get(b.childSessionId);
    if (!child) { b.childMissing = true; continue; }
    child.spawnedBy ??= { sessionId: s.id, toolCallId: b.id };
    if (!child.prompt && b.input && typeof b.input.prompt === 'string') child.prompt = b.input.prompt;
  }
  for (const s of sessions) s.stats = summarizeSession(s);
  const ordered = [], seen = new Set();
  const visit = id => { const s = byId.get(id); if (!s || seen.has(id)) return; seen.add(id); ordered.push(s); for (const c of s.children) visit(c); };
  visit(root.id);
  for (const s of sessions) visit(s.id);
  const run = { source: root.source, rootId: root.id, sessions: ordered, generatedAt: Date.now() };
  run.outline = buildOutline(run);
  return run;
}

// The step outline: prompts, sub-agent launches, narration, results and errors in order.
export function buildOutline(run) {
  const byId = new Map(run.sessions.map(s => [s.id, s]));
  const entries = [];
  for (const s of run.sessions) for (const t of s.turns) {
    if (t.prompt) entries.push({ sessionId: s.id, turn: t.index, block: -1, kind: 'prompt', at: t.at, label: firstLine(t.prompt.text, 140) });
    t.blocks.forEach((b, i) => {
      const base = { sessionId: s.id, turn: t.index, block: i, at: b.at };
      if (b.kind === 'text') entries.push({ ...base, kind: 'narration', label: firstLine(b.text, 140) });
      else if (b.kind === 'tool' && (b.childSessionId || /^(agent|task|spawn_agent|followup_task)$/i.test(b.name || ''))) entries.push({ ...base, kind: 'agent', label: b.summary || toolSummary(b), status: b.status, childSessionId: b.childSessionId || null, childTitle: byId.get(b.childSessionId)?.title || '' });
      else if (b.kind === 'tool' && b.status === 'error') entries.push({ ...base, kind: 'error', label: `${b.name}: ${b.summary || toolSummary(b)}`, status: 'error' });
      else if (b.kind === 'notification') entries.push({ ...base, kind: 'result', label: firstLine(b.summary || b.text, 140), status: b.status, childSessionId: b.childSessionId || null });
      else if (b.kind === 'system' && (b.level === 'error' || b.level === 'warning' || b.level === 'notice')) entries.push({ ...base, kind: 'system', label: `${b.label || 'system'}: ${firstLine(b.text, 120)}`, status: b.level });
    });
  }
  return entries;
}

const pad = n => String(n).padStart(2, '0');
export const fmtTime = ms => { if (!ms) return '--:--:--'; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const fmtDuration = ms => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// Markdown outline for pasting into a chat ("tell me what happened in step 2").
export function outlineMarkdown(run) {
  const lines = [];
  const byId = new Map(run.sessions.map(s => [s.id, s]));
  for (const s of run.sessions) {
    const st = s.stats || summarizeSession(s);
    const depth = (() => { let d = 0, p = s.parentId; const seen = new Set([s.id]); while (p && byId.has(p) && !seen.has(p)) { seen.add(p); d++; p = byId.get(p).parentId; } return d; })();
    lines.push(`${'#'.repeat(Math.min(depth + 1, 4))} ${depth ? 'Sub-agent' : 'Session'}: ${s.title || s.id}`);
    lines.push(`- id: ${s.id}${s.parentId ? ` (parent ${s.parentId})` : ''}${s.agentType ? ` · agent ${s.agentType}` : ''}${s.model ? ` · model ${s.model}` : ''}`);
    lines.push(`- ${st.turns} turns, ${st.toolCalls} tool calls (${Object.entries(st.toolCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ${st.errors} tool/API errors, ${st.agents} agent calls${st.durationMs != null ? `, ${fmtDuration(st.durationMs)} span (includes idle time)` : ''}${s.cost ? `, $${s.cost.toFixed(2)}` : ''}`);
    lines.push('');
    for (const e of run.outline.filter(e => e.sessionId === s.id)) {
      const ref = e.block >= 0 ? `t${e.turn + 1}.b${e.block + 1}` : `t${e.turn + 1}`;
      const status = e.status && e.status !== 'ok' ? ` [${e.status}]` : '';
      lines.push(`- ${fmtTime(e.at)} ${ref} ${e.kind}${status}: ${e.label}${e.childSessionId ? ` → ${e.childSessionId}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Full, unabridged normalized evidence for an adjacent AI session. Unlike the
// HTML preview this is not clipped; upstream truncation is explicitly retained.
export function transcriptMarkdown(run) {
  const lines = [`# Run: ${run.sessions[0].title}`, `Source: ${run.source} · Root: ${run.rootId}`, ''];
  for (const w of run.workflows || []) {
    lines.push(`## Workflow ledger: ${w.path}`, 'These are recorded assignments/results, not a fresh validation.');
    for (const step of w.steps) lines.push(`### ${step.id} (${step.status})`, `Transcript link: ${step.linkBasis || 'unavailable'}`, `Assigned:\n${step.prompt}`, `Recorded result:\n${JSON.stringify(step.result, null, 2)}`, '');
  }
  for (const s of run.sessions) {
    lines.push(`## Session: ${s.title}`, `ID: ${s.id} · Parent: ${s.parentId || 'none'}`, '');
    for (const t of s.turns) {
      lines.push(`### Turn ${t.index + 1}`, t.prompt ? `USER:\n${t.prompt.text}` : '(continuation)', '');
      t.blocks.forEach((b, i) => {
        lines.push(`#### t${t.index + 1}.b${i + 1} · ${b.kind} · ${fmtTime(b.at)}`);
        if (b.kind === 'tool') lines.push(`TOOL: ${b.name} · ${b.status} · ${b.id}`, `INPUT:\n${JSON.stringify(b.input, null, 2)}`, `OUTPUT:\n${b.output || ''}`, b.error ? `ERROR:\n${b.error}` : '', b.sourceTruncated ? `Source output was truncated. ${b.outputFile || ''}` : '', b.childSessionId ? `Child session: ${b.childSessionId}` : '');
        else lines.push(b.text || '');
        lines.push('');
      });
    }
  }
  return lines.join('\n');
}
