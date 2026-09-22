/* Traceview client: renders window.__RUN__ (see model.mjs) as a nested,
   collapsible transcript. Bodies render lazily on first expand. */
(() => {
  'use strict';
  const run = window.__RUN__;
  if (!run) return;
  const byId = new Map(run.sessions.map(s => [s.id, s]));
  const root = byId.get(run.rootId) || run.sessions[0];
  const state = { current: root.id, query: '', tool: null, showReasoning: true, showSystem: true, showText: true, errorsOnly: false };

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmt = {
    time: ms => { if (!ms) return ''; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; },
    date: ms => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmt.time(ms)}`; },
    dur: ms => { if (ms == null || !isFinite(ms) || ms < 0) return ''; if (ms < 1000) return `${Math.round(ms)}ms`; const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`; return `${Math.floor(m / 60)}h ${m % 60}m`; },
    num: n => { n = Number(n) || 0; return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n); },
    cost: c => (c ? `$${c >= 10 ? c.toFixed(0) : c.toFixed(2)}` : ''),
    chars: n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`),
  };
  const firstLine = (t, max = 120) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
  const anchorId = (sid, turn, block) => `b-${sid}-${turn}-${block}`;
  const sessionHref = id => `#session-${id}`;
  const blockHref = (sid, turn, block) => `#${anchorId(sid, turn, block)}`;
  // Real hrefs preserve the browser's new-tab, middle-click and context-menu
  // behavior. Only an unmodified primary click uses in-page navigation.
  const navLink = (href, attrs, ...children) => h('a', { ...attrs, href, onclick: e => {
    e.stopPropagation(); // Links inside a disclosure must not toggle it.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (location.hash !== href) history.pushState(null, '', href);
    followHash();
  } }, ...children);
  const isAgentTool = b => b.kind === 'tool' && (b.childSessionId || /^(agent|task)$/i.test(b.name || ''));

  // Minimal markdown: fences, tables (as preformatted), headings, lists, paragraphs, inline code/bold/links.
  const inline = s => esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const LIST = /^\s*([-*+]|\d+[.)])\s+/;
  function md(src) {
    const lines = String(src ?? '').split('\n'); const out = []; let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) { const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre class="code">${esc(buf.join('\n'))}</pre>`); continue; }
      if (/^\s*\|/.test(line)) { const buf = []; while (i < lines.length && /^\s*\|/.test(lines[i])) buf.push(lines[i++]); out.push(`<pre class="table">${esc(buf.join('\n'))}</pre>`); continue; }
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { const lvl = Math.min(hm[1].length + 2, 6); out.push(`<h${lvl}>${inline(hm[2])}</h${lvl}>`); i++; continue; }
      if (LIST.test(line)) {
        const ordered = /^\s*\d/.test(line); const items = [];
        while (i < lines.length && LIST.test(lines[i])) {
          let item = lines[i].replace(LIST, ''); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST.test(lines[i])) item += ` ${lines[i++].trim()}`;
          items.push(`<li>${inline(item)}</li>`);
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !LIST.test(lines[i]) && !/^\s*\|/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('\n');
  }

  const searchText = b => {
    if (b._s == null) b._s = [b.kind, b.name, b.summary, b.title, b.text, b.output, b.error, b.stderr, b.input ? JSON.stringify(b.input) : ''].filter(Boolean).join('\n').toLowerCase();
    return b._s;
  };
  const filtering = () => !!(state.query || state.tool || state.errorsOnly);
  const blockVisible = b => {
    if (b.kind === 'reasoning' && !state.showReasoning) return false;
    if (b.kind === 'system' && !state.showSystem) return false;
    if (b.kind === 'text' && !state.showText) return false;
    if (state.tool && !(b.kind === 'tool' && b.name === state.tool)) return false;
    if (state.errorsOnly && !(b.status === 'error' || b.level === 'error')) return false;
    if (state.query && !searchText(b).includes(state.query)) return false;
    return true;
  };

  const chip = (label, cls = '') => h('span', { class: `chip ${cls}` }, label);
  const statusIcon = st => h('span', { class: `st st-${st}`, title: st }, st === 'ok' ? '✓' : st === 'error' ? '✗' : '…');
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = h('textarea', { class: 'clipboard-fallback', 'aria-label': 'Text to copy' }, text);
      document.body.append(area); area.select();
      const copied = document.execCommand('copy'); area.remove();
      if (!copied) throw new Error('Use the transcript export to copy this evidence.');
    }
  }
  const copyBtn = (getText, label = '⧉') => h('button', { class: 'copy', title: 'Copy evidence as text', 'aria-label': label === '⧉' ? 'Copy evidence as text' : label, onclick: async e => {
    e.preventDefault(); e.stopPropagation(); const btn = e.currentTarget;
    try { await copyText(getText()); btn.textContent = 'Copied'; }
    catch (error) { btn.textContent = 'Copy unavailable'; btn.title = error.message; }
    setTimeout(() => { btn.textContent = label; }, 1400);
  } }, label);
  const anchorBtn = id => navLink(`#${id}`, { class: 'anchor', title: 'Link to this block' }, '#');
  const truncNote = n => h('div', { class: 'trunc' }, `Truncated: showing the first part of ${fmt.chars(n.length)}.`);
  const lazy = (details, fill) => { let done = false; const once = () => { if (done) return; done = true; fill(); }; details._fill = once; if (details.open) once(); else details.addEventListener('toggle', () => { if (details.open) once(); }); return details; };

  function renderAttachments(list) {
    const frag = document.createDocumentFragment();
    for (const a of list || []) {
      if (a.type === 'image') {
        if (a.data) frag.append(h('details', { class: 'img' }, h('summary', {}, `image (${a.mediaType}, ${fmt.chars(a.size || a.data.length)})`), h('img', { src: `data:${a.mediaType};base64,${a.data}`, loading: 'lazy' })));
        else frag.append(chip(`image omitted (${fmt.chars(a.size || 0)})`));
      } else frag.append(chip(a.name || a.type));
    }
    return frag;
  }

  function renderSession(s, depth) {
    const sec = h('section', { class: 'session', 'data-depth': depth });
    sec.append(renderSessionHeader(s, depth));
    const turns = h('div', { class: 'turns' });
    let shown = 0;
    for (const t of s.turns) { const el = renderTurn(s, t, depth); if (el) { turns.append(el); shown++; } }
    if (!shown) turns.append(h('div', { class: 'empty' }, filtering() ? 'No blocks match the current filter.' : 'No activity recorded.'));
    sec.append(turns);
    return sec;
  }

  function renderSessionHeader(s, depth) {
    const st = s.stats || {};
    const chips = [];
    if (s.agentType) chips.push(chip(s.agentType, 'agent'));
    if (s.model) chips.push(chip(s.model, 'model'));
    if (st.durationMs != null) chips.push(chip(`${fmt.dur(st.durationMs)} span`));
    chips.push(chip(`${st.turns} turns`), chip(`${st.toolCalls} tool calls`));
    if (st.toolMs) chips.push(chip(`${fmt.dur(st.toolMs)} in tools`));
    if (st.agents) chips.push(chip(`${st.agents} agent calls`, 'agent'));
    if (st.errors) chips.push(chip(`${st.errors} tool / API errors`, 'err'));
    if (st.reasoning) chips.push(chip(`${st.reasoning} recorded reasoning`));
    if (s.tokens && (s.tokens.input || s.tokens.output)) chips.push(chip(`tokens ${fmt.num(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite)} in / ${fmt.num(s.tokens.output)} out`));
    if (s.cost) chips.push(chip(fmt.cost(s.cost)));
    const tools = Object.entries(st.toolCounts || {}).sort((a, b) => b[1] - a[1]).map(([name, n]) =>
      h('button', { class: `chip tool${state.tool === name ? ' active' : ''}`, onclick: () => { state.tool = state.tool === name ? null : name; render(); } }, `${name} ×${n}`));
    const head = h('header', { class: 'session-head' },
      h('div', { class: 'session-title' }, h('span', { class: `src src-${s.source}` }, s.source), h('strong', {}, s.title || s.id), h('code', { class: 'sid', title: 'session id' }, s.id), copyBtn(() => s.id)),
      h('div', { class: 'chips' }, chips),
      tools.length ? h('div', { class: 'chips tools' }, h('span', { class: 'muted small' }, 'filter by tool:'), tools) : null,
      h('div', { class: 'muted small' }, s.cwd ? `cwd ${s.cwd}` : '', s.startedAt ? ` · started ${fmt.date(s.startedAt)}` : '', s.spawnedBy?.sessionId ? ` · spawned by ${byId.get(s.spawnedBy.sessionId)?.title || s.spawnedBy.sessionId}` : ''),
      h('div', { class: 'evidence-actions' }, copyBtn(() => sessionText(s), 'Copy thread for AI'), h('span', { class: 'muted small' }, 'Includes session ID, assignments and visible transcript evidence.')),
    );
    if (depth > 0 || s.spawnedBy) {
      const p = s.prompt || s.turns[0]?.prompt?.text || '';
      if (p) head.append(h('details', { class: 'assigned' }, h('summary', {}, 'Assigned task (the prompt this agent was given)'), h('div', { class: 'md prompt', html: md(p) })));
      if (s.result) head.append(h('div', { class: 'small' }, h('span', { class: 'kind' }, 'reported back: '), s.result));
    }
    if (s.notes?.length) head.append(h('div', { class: 'muted small' }, s.notes.join(' · ')));
    return head;
  }

  const turnDuration = t => { const times = []; if (t.at) times.push(t.at); for (const b of t.blocks) { if (b.at) times.push(b.at); if (b.endedAt) times.push(b.endedAt); } return times.length < 2 ? null : Math.max(...times) - Math.min(...times); };

  function renderTurn(s, t, depth) {
    const blocks = t.blocks.map((b, i) => [b, i]).filter(([b]) => blockVisible(b));
    const promptMatch = !state.tool && !state.errorsOnly && state.query && t.prompt && String(t.prompt.text).toLowerCase().includes(state.query);
    if (filtering() && !blocks.length && !promptMatch) return null;
    const tools = t.blocks.filter(b => b.kind === 'tool').length;
    const errs = t.blocks.filter(b => (b.kind === 'tool' && b.status === 'error') || (b.kind === 'system' && b.level === 'error')).length;
    const agents = t.blocks.filter(isAgentTool).length;
    const dur = turnDuration(t);
    const open = filtering();
    const d = h('details', { class: 'turn', id: anchorId(s.id, t.index, -1), open });
    d.append(h('summary', {},
      h('span', { class: 'turn-no' }, `Turn ${t.index + 1}`),
      h('span', { class: 'muted mono' }, fmt.time(t.at)),
      dur != null ? h('span', { class: 'muted' }, fmt.dur(dur)) : null,
      chip(`${tools} tools`), agents ? chip(`${agents} agents`, 'agent') : null, errs ? chip(`${errs} err`, 'err') : null,
      h('span', { class: 'turn-prompt' }, t.prompt ? firstLine(t.prompt.text, 160) : '(continuation: tool results, agent reports or system input)'),
      copyBtn(() => `Run: ${run.source}:${run.rootId}\nSession: ${s.id}\nTurn: ${t.index + 1}\n${turnText(t)}`),
    ));
    const body = h('div', { class: 'turn-body' });
    d.append(body);
    return lazy(d, () => { if (t.prompt) body.append(renderPrompt(t.prompt)); for (const [b, i] of blocks) body.append(renderBlock(s, t, b, i, depth)); });
  }

  function renderPrompt(p) {
    const el = h('div', { class: 'blk blk-user' },
      h('div', { class: 'blk-head' }, h('span', { class: 'kind' }, 'user'), h('span', { class: 'muted mono' }, fmt.time(p.at)), copyBtn(() => p.text)),
      h('div', { class: 'md', html: md(p.text) }));
    if (p.truncated) el.append(truncNote(p.truncated));
    el.append(renderAttachments(p.attachments));
    if (p.reminders?.length) el.append(h('details', { class: 'reminders' }, h('summary', {}, `${p.reminders.length} system reminder(s) attached to this prompt`), ...p.reminders.map(r => h('pre', { class: 'sys' }, r))));
    return el;
  }

  function renderBlock(s, t, b, i, depth) {
    const id = anchorId(s.id, t.index, i);
    if (b.kind === 'text') return h('div', { class: 'blk blk-text', id },
      h('div', { class: 'blk-head' }, h('span', { class: 'kind' }, 'assistant'), h('span', { class: 'muted mono' }, fmt.time(b.at)), anchorBtn(id), copyBtn(() => b.text)),
      h('div', { class: 'md', html: md(b.text) }), b.textTruncated ? truncNote(b.textTruncated) : null);
    if (b.kind === 'reasoning') return h('details', { class: 'blk blk-reason', id },
      h('summary', {}, h('span', { class: 'kind' }, 'recorded reasoning'), h('span', { class: 'muted mono' }, fmt.time(b.at)), h('span', { class: 'preview' }, firstLine(b.text, 160)), anchorBtn(id), copyBtn(() => b.text)),
      h('pre', { class: 'reason' }, b.text), b.textTruncated ? truncNote(b.textTruncated) : null);
    if (b.kind === 'notification') {
      const child = b.childSessionId ? byId.get(b.childSessionId) : null;
      return h('details', { class: `blk blk-notify st-${b.status || 'ok'}`, id },
        h('summary', {}, h('span', { class: 'kind' }, 'reported back'), h('span', { class: 'muted mono' }, fmt.time(b.at)), chip(b.status || 'done', b.status === 'completed' ? 'ok' : 'err'), h('span', { class: 'preview' }, firstLine(b.summary || b.text, 160)),
          child ? navLink(sessionHref(child.id), { class: 'link' }, `open ${child.title || child.id} ↗`) : null, anchorBtn(id), copyBtn(() => b.text)),
        h('pre', { class: 'sys' }, b.text));
    }
    if (b.kind === 'system') return h('details', { class: `blk blk-sys lvl-${b.level || 'info'}`, id },
      h('summary', {}, h('span', { class: 'kind' }, b.label || 'system'), h('span', { class: 'muted mono' }, fmt.time(b.at)), h('span', { class: 'preview' }, firstLine(b.text, 160)), anchorBtn(id)),
      h('pre', { class: 'sys' }, b.text), renderAttachments(b.attachments),
      b.reminders?.length ? h('details', { class: 'reminders' }, h('summary', {}, `${b.reminders.length} system reminder(s)`), ...b.reminders.map(r => h('pre', { class: 'sys' }, r))) : null);
    if (b.kind === 'tool') return renderTool(s, t, b, i, depth, id);
    return h('pre', { id }, JSON.stringify(b, null, 2));
  }

  function renderTool(s, t, b, i, depth, id) {
    const child = b.childSessionId ? byId.get(b.childSessionId) : null;
    const d = h('details', { class: `blk blk-tool st-${b.status || 'ok'}${child ? ' has-child' : ''}`, id, open: !!state.query });
    const outLen = (b.output || '').length + (b.outputTruncated ? b.outputTruncated.length - (b.output || '').length : 0);
    d.append(h('summary', {},
      statusIcon(b.status || 'ok'),
      h('span', { class: 'tool-name' }, b.name || 'tool'),
      h('span', { class: 'tool-sum', title: b.summary || '' }, b.summary || b.title || ''),
      child ? chip(`sub-agent: ${child.title || child.id}`, 'agent') : b.childMissing ? chip('sub-agent transcript missing', 'err') : null,
      b.async ? chip('async') : null,
      h('span', { class: 'muted mono right' }, fmt.time(b.at)),
      b.durationMs != null ? h('span', { class: 'muted' }, fmt.dur(b.durationMs)) : null,
      outLen ? h('span', { class: 'muted' }, fmt.chars(outLen)) : null,
       anchorBtn(id), copyBtn(() => `Session: ${s.id}\nReference: t${t.index + 1}.b${i + 1}\n${toolText(b)}`),
    ));
    const body = h('div', { class: 'tool-body' });
    d.append(body);
    return lazy(d, () => {
      body.append(renderInput(b));
      if (b.inputTruncated) body.append(h('div', { class: 'trunc' }, 'Input clipped for this preview. Use the full transcript export for the stored input.'));
      if (b.error) body.append(h('div', { class: 'sec' }, h('div', { class: 'sec-title err' }, 'Error'), h('pre', { class: 'out err' }, b.error)));
      if (b.output || !b.error) body.append(h('div', { class: 'sec' },
        h('div', { class: 'sec-title' }, 'Output', b.outputInlined ? h('span', { class: 'muted' }, ` · persisted output inlined from ${b.outputFile}`) : b.outputFile ? h('span', { class: 'muted' }, ` · full output at ${b.outputFile}`) : null),
        h('pre', { class: `out${b.status === 'error' ? ' err' : ''}` }, b.output || '(no output)'), b.outputTruncated ? truncNote(b.outputTruncated) : null));
      if (b.stderr) body.append(h('div', { class: 'sec' }, h('div', { class: 'sec-title err' }, 'stderr'), h('pre', { class: 'out err' }, b.stderr)));
      if (b.sourceTruncated) body.append(h('div', { class: 'trunc' }, `OpenCode truncated this output at capture time.${b.outputFile ? ` Full output reference: ${b.outputFile}` : ''}`));
      body.append(renderAttachments(b.attachments));
      if (b.meta && (typeof b.meta === 'string' || Object.keys(b.meta).length)) body.append(h('details', { class: 'raw' }, h('summary', {}, 'tool metadata'), h('pre', { class: 'sys' }, typeof b.meta === 'string' ? b.meta : JSON.stringify(b.meta, null, 2))));
      if (b.details) body.append(h('details', { class: 'raw' }, h('summary', {}, 'raw result record'), h('pre', { class: 'sys' }, typeof b.details === 'string' ? b.details : JSON.stringify(b.details, null, 2))));
      if (child) {
        const nested = h('details', { class: 'child' }, h('summary', {}, h('span', { class: 'kind' }, 'sub-agent thread'), h('strong', {}, child.title || child.id), navLink(sessionHref(child.id), { class: 'link' }, 'open as main view ↗')));
        body.append(lazy(nested, () => nested.append(depth < 8 && child.id !== s.id ? renderSession(child, depth + 1) : h('p', {}, 'Open as main view to inspect this thread.'))));
      }
    });
  }

  function renderInput(b) {
    const name = String(b.name || '').toLowerCase();
    const inp = b.input && typeof b.input === 'object' ? b.input : null;
    const sec = (title, ...kids) => h('div', { class: 'sec' }, h('div', { class: 'sec-title' }, title), ...kids);
    if (!inp) return sec('Input', h('pre', { class: 'code' }, b.input == null ? '(none)' : String(b.input)));
    const raw = () => h('details', { class: 'raw' }, h('summary', {}, 'All input fields'), h('pre', { class: 'code' }, JSON.stringify(inp, null, 2)));
    if (name === 'bash') return sec('Command', inp.description ? h('div', { class: 'muted small' }, inp.description) : null, inp.workdir ? h('code', {}, `cwd: ${inp.workdir}`) : null, h('pre', { class: 'code' }, inp.command || JSON.stringify(inp, null, 2)), raw());
    if (name === 'apply_patch') return sec('File patch', h('pre', { class: 'code diff' }, inp.patchText || inp.patch || JSON.stringify(inp, null, 2)));
    if (name === 'edit' || name === 'multiedit') {
      const diff = b.meta && typeof b.meta === 'object' && typeof b.meta.diff === 'string' ? b.meta.diff : null;
      return sec(`Edit ${inp.file_path || inp.filePath || ''}`, diff ? h('pre', { class: 'code diff' }, diff) : h('div', { class: 'diffpair' }, h('pre', { class: 'old' }, inp.old_string ?? inp.oldString ?? JSON.stringify(inp.edits || inp, null, 2)), h('pre', { class: 'new' }, inp.new_string ?? inp.newString ?? '')), raw());
    }
    if (name === 'write') return sec(`Write ${inp.file_path || inp.filePath || ''}`, h('pre', { class: 'code' }, inp.content ?? ''));
    if (name === 'agent' || name === 'task') return sec(`Task${inp.subagent_type ? ` (${inp.subagent_type})` : ''}: ${inp.description || ''}`, h('div', { class: 'md prompt', html: md(inp.prompt || '') }), raw());
    return sec('Input', h('pre', { class: 'code' }, JSON.stringify(inp, null, 2)));
  }

  const toolText = b => `[${b.name}] ${b.summary || ''}\nCall ID: ${b.id}\nINPUT:\n${typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)}\n\nOUTPUT (${b.status}):\n${b.output || ''}${b.error ? `\nERROR: ${b.error}` : ''}${b.childSessionId ? `\nChild session: ${b.childSessionId}` : ''}${b.inputTruncated || b.outputTruncated || b.sourceTruncated ? '\n[Clipped output/input: use full stored transcript export; upstream truncation may also apply.]' : ''}`;
  const turnText = t => [t.prompt ? `USER:\n${t.prompt.text}` : '', ...t.blocks.map(b => b.kind === 'tool' ? toolText(b) : b.kind === 'reasoning' ? `THINKING:\n${b.text}` : b.kind === 'text' ? `ASSISTANT:\n${b.text}` : `${b.kind.toUpperCase()}:\n${b.text || ''}`)].filter(Boolean).join('\n\n----\n\n');
  const sessionText = s => `# ${s.title}\nRun: ${run.source}:${run.rootId}\nSession ID: ${s.id}\nParent: ${s.parentId || 'none'}\nSource: viewer snapshot ${fmt.date(run.generatedAt)}; large fields may be clipped.\n\n${s.turns.map(t => `## Turn ${t.index + 1}\n${turnText(t)}`).join('\n\n')}`;

  function renderTree(s, depth, seen = new Set()) {
    const st = s.stats || {};
    const frag = document.createDocumentFragment();
    if (seen.has(s.id)) return frag;
    seen.add(s.id);
    frag.append(navLink(sessionHref(s.id), { class: `tree-item${s.id === state.current ? ' active' : ''}`, 'aria-current': s.id === state.current ? 'true' : null, style: `--depth:${depth}` },
      h('div', { class: 'tree-title', title: s.title || s.id }, s.title || s.id),
      h('div', { class: 'tree-meta muted small' }, [s.agentType, st.durationMs != null ? fmt.dur(st.durationMs) : null, `${st.toolCalls} tools`, st.errors ? `${st.errors} err` : null].filter(Boolean).join(' · '))));
    for (const cid of s.children || []) { const c = byId.get(cid); if (c) frag.append(renderTree(c, depth + 1, seen)); }
    return frag;
  }

  function renderOutline() {
    const list = h('div', { class: 'outline' });
    const entries = (run.outline || []).filter(e => e.sessionId === state.current);
    if (!entries.length) list.append(h('div', { class: 'muted small' }, 'No outline entries.'));
    for (const e of entries) {
      const row = h('div', { class: `ol ol-${e.kind}${e.status === 'error' || e.status === 'killed' || e.status === 'failed' ? ' err' : ''}` },
        navLink(blockHref(e.sessionId, e.turn, e.block), { class: 'ol-target', title: e.label || '' },
          h('span', { class: 'ol-kind' }, e.kind), h('span', { class: 'ol-time muted mono' }, fmt.time(e.at)), h('span', { class: 'ol-label' }, e.label || '')),
        e.childSessionId && byId.has(e.childSessionId) ? navLink(sessionHref(e.childSessionId), { class: 'link', title: 'open sub-agent', 'aria-label': 'Open sub-agent' }, '↗') : null);
      list.append(row);
    }
    return list;
  }

  function breadcrumb() {
    const chain = [], seen = new Set(); let s = byId.get(state.current);
    while (s && !seen.has(s.id)) { seen.add(s.id); chain.unshift(s); s = s.parentId ? byId.get(s.parentId) : null; }
    return h('nav', { class: 'crumbs' }, chain.map((s, i) => [i ? h('span', { class: 'muted' }, ' › ') : null, i === chain.length - 1 ? h('strong', {}, s.title || s.id) : navLink(sessionHref(s.id), { class: 'link' }, s.title || s.id)]));
  }

  const toggle = (label, key) => h('label', { class: 'tgl' }, h('input', { type: 'checkbox', checked: state[key], onchange: e => { state[key] = e.target.checked; render(); } }), label);
  function renderHeader() {
    const st = root.stats || {};
    return h('header', { class: 'top' },
      h('div', { class: 'top-title' }, run.options?.indexHref ? h('a', { href: run.options.indexHref, class: 'brand' }, 'Traceview', h('small', {}, ' / RUN INSPECTOR')) : h('span', { class: 'brand' }, 'Traceview / RUN INSPECTOR'), h('span', { class: 'local-indicator' }, 'LOCAL · READ ONLY')),
      h('div', { class: 'controls' },
        h('input', { id: 'q', type: 'search', 'aria-label': 'Search all threads', placeholder: 'Search all threads  /', oninput: e => { state.query = e.target.value.trim().toLowerCase(); scheduleRender(); } }),
        toggle('Reasoning', 'showReasoning'), toggle('Narration', 'showText'), toggle('System', 'showSystem'), toggle('Errors only', 'errorsOnly'),
        h('button', { onclick: () => expandAll(true) }, 'Expand'), h('button', { onclick: () => expandAll(false) }, 'Collapse'),
        run.options?.indexHref ? h('button', { onclick: () => location.reload(), title: 'Load a fresh snapshot from the transcript store' }, 'Refresh') : null));
  }

  function renderSearch() {
    const results = h('div', { class: 'search-results' });
    let total = 0;
    for (const s of run.sessions) for (const t of s.turns) {
      const hits = t.blocks.map((b, i) => ({ b, i })).filter(({ b }) => searchText(b).includes(state.query));
      if (t.prompt?.text.toLowerCase().includes(state.query)) hits.unshift({ b: { kind: 'prompt', text: t.prompt.text }, i: -1 });
      for (const { b, i } of hits) {
        total++;
        if (total > 150) continue;
        results.append(navLink(blockHref(s.id, t.index, i), { class: 'search-hit' }, h('span', { class: 'eyebrow' }, `${b.name || b.kind} · Turn ${t.index + 1}`), h('strong', {}, firstLine(b.summary || b.text || b.output, 110)), h('span', { class: 'muted small' }, s.title)));
      }
    }
    return h('section', {}, h('h2', {}, `${total} matches across all threads`), total > 150 ? h('p', { class: 'small muted' }, 'Showing first 150. Narrow your search for more.') : null, total ? results : h('p', { class: 'empty' }, 'No matches in this snapshot. Large fields may be clipped.'));
  }

  function renderWorkflow() {
    const container = h('section', { class: 'workflow-record', id: 'workflow-record' });
    if (!run.workflows?.length) return h('div', { class: 'notice' }, h('strong', {}, 'Transcript view'), ' · No linked workflow ledger. The tree below shows actual sessions and turns; workflow steps have not been inferred.');
    container.append(h('div', { class: 'section-heading' }, h('h2', {}, 'Workflow assignments'), h('span', { class: 'muted small' }, 'Recorded expectations → linked evidence')));
    for (const w of run.workflows) {
      container.append(h('div', { class: 'workflow-path' }, h('code', {}, w.path), chip(`Part ${w.partId || 'unknown'}`)));
      w.steps.forEach((step, index) => {
        const detail = h('details', { class: 'workflow-step' });
        detail.append(h('summary', {}, h('span', { class: 'step-no' }, String(index + 1).padStart(2, '0')), h('div', { class: 'step-label' }, h('strong', {}, step.id), h('span', { class: 'muted small' }, step.phase)), chip(step.status), chip(step.sessionIds.length ? `${step.sessionIds.length} linked thread(s)` : 'transcript unlinked', step.sessionIds.length ? 'agent' : '')));
        container.append(lazy(detail, () => {
          const body = h('div', { class: 'workflow-body' });
          body.append(h('div', { class: 'sec-title' }, 'Assigned work'), h('div', { class: 'md prompt', html: md(step.prompt) }), step.promptTruncated ? truncNote(step.promptTruncated) : null, h('code', { class: 'muted small' }, step.taskFile));
          if (step.schema) body.append(h('details', { class: 'raw' }, h('summary', {}, 'Expected output schema'), h('pre', { class: 'code' }, JSON.stringify(step.schema, null, 2))));
          body.append(h('div', { class: 'sec-title' }, 'Observed activity'));
          if (step.sessionIds.length) {
            body.append(h('p', { class: 'muted small' }, `Linked by ${step.linkBasis}. A linked thread can span multiple assignments.`));
            for (const id of step.sessionIds) body.append(navLink(sessionHref(id), { class: 'thread-link' }, `Inspect ${byId.get(id)?.title || id} →`));
          } else body.append(h('p', { class: 'muted' }, `No exact transcript link${step.nativeAgentId ? ` for ${step.nativeAgentId}` : ''}. This does not establish whether the stage ran.`));
          for (const ref of step.references) body.append(navLink(blockHref(ref.sessionId, ref.turn, ref.block), { class: 'link' }, `Task-path reference · turn ${ref.turn + 1}, block ${ref.block + 1} ↗`));
          if (step.result !== null) body.append(h('details', { class: 'recorded-result' }, h('summary', {}, `Recorded result · ${step.recordedAt || ''}`), h('pre', { class: 'out' }, JSON.stringify(step.result, null, 2))));
          body.append(copyBtn(() => `Workflow: ${w.path}\nStep: ${step.id}\nStatus: ${step.status}\nLink basis: ${step.linkBasis || 'none'}\nAssigned:\n${step.prompt}\nRecorded result (preview may be clipped):\n${JSON.stringify(step.result, null, 2)}\n\n${step.sessionIds.map(id => sessionText(byId.get(id))).join('\n\n')}`, 'Copy step for AI'));
          detail.append(body);
        }));
      });
      container.append(h('details', { class: 'ledger-meta' }, h('summary', {}, 'Inputs & human review gates'), h('pre', { class: 'out' }, JSON.stringify({ inputs: w.config, gates: w.gates }, null, 2))));
    }
    container.append(h('p', { class: 'muted small' }, '“Recorded” means the ledger contains a result. Tool success and transcript links do not establish machining correctness.'));
    return container;
  }

  function renderRunIntro() {
    const tools = run.sessions.reduce((n, s) => n + s.stats.toolCalls, 0);
    const errors = run.sessions.reduce((n, s) => n + s.stats.errors, 0);
    const href = suffix => `/${suffix}/${run.source}/${encodeURIComponent(run.rootId)}`;
    return h('section', { class: 'run-intro' },
      h('div', { class: 'eyebrow' }, 'RUN RECORD', h('span', { class: `src src-${run.source}` }, run.source)),
      h('h1', {}, run.bookmark?.label || root.title || root.id),
      h('p', { class: 'muted' }, `${fmt.date(root.startedAt)} · Snapshot ${fmt.date(run.generatedAt)}`),
      h('div', { class: 'run-metrics' }, [[run.sessions.length, 'threads'], [tools, 'tool calls'], [errors, 'tool / API errors']].map(([n, label]) => h('div', {}, h('strong', {}, fmt.num(n)), h('span', {}, label)))),
      run.options?.indexHref ? h('div', { class: 'exports' }, h('span', { class: 'muted small' }, 'For a conversation alongside this view:'), h('a', { href: href('transcript'), download: `${run.rootId}.md` }, 'Full transcript ↓'), h('a', { href: href('data'), download: `${run.rootId}.json` }, 'JSON ↓'), h('a', { href: href('outline'), download: `${run.rootId}-outline.md` }, 'Outline ↓')) : h('p', { class: 'muted small' }, 'Offline snapshot. Preview limits apply; regenerate to include new activity.'),
    );
  }

  function expandAll(open) {
    const skip = d => d.classList.contains('raw') || d.classList.contains('reminders') || d.classList.contains('img') || d.classList.contains('assigned');
    for (let guard = 0, changed = true; changed && guard < 30; guard++) {
      changed = false;
      for (const d of document.querySelectorAll('#main details')) { if (skip(d) || d.open === open) continue; d.open = open; changed = true; if (open) d._fill?.(); }
    }
  }
  function selectSession(id, push = true) { if (!byId.has(id)) return; state.current = id; if (push) history.pushState(null, '', `#session-${id}`); render(); window.scrollTo({ top: 0 }); }
  function openTo(sid, turn, block) {
    state.current = sid;
    state.query = ''; state.tool = null; state.errorsOnly = false; state.showText = true; state.showReasoning = true; state.showSystem = true;
    document.getElementById('q').value = '';
    document.querySelectorAll('.tgl input').forEach(input => { input.checked = input.parentElement.textContent !== 'Errors only'; });
    render();
    history.replaceState(null, '', `#${anchorId(sid, turn, block)}`);
    const td = document.getElementById(anchorId(sid, turn, -1));
    if (!td) return;
    if (!td.open) { td.open = true; td._fill?.(); }
    const el = block >= 0 ? document.getElementById(anchorId(sid, turn, block)) : td;
    if (!el) return;
    if (el.tagName === 'DETAILS' && !el.open) { el.open = true; el._fill?.(); }
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500);
  }
  let timer = null;
  const scheduleRender = () => { clearTimeout(timer); timer = setTimeout(render, 150); };
  function render() {
    const layout = document.getElementById('layout');
    const cur = byId.get(state.current) || root;
    const side = h('aside', { class: 'side' }, h('div', { class: 'eyebrow' }, 'EXECUTION TREE'), h('h2', {}, `Threads / ${String(run.sessions.length).padStart(2, '0')}`), h('div', { class: 'tree' }, renderTree(root, 0)), state.query ? renderSearch() : [h('h2', {}, 'Selected thread outline'), renderOutline()]);
    const main = h('main', { id: 'main' }, state.current === root.id ? [renderRunIntro(), renderWorkflow()] : null, (run.warnings || []).map(w => h('p', { class: 'notice' }, w)), breadcrumb(), state.tool ? h('div', { class: 'chips' }, h('button', { class: 'chip tool active', onclick: () => { state.tool = null; render(); } }, `showing only ${state.tool} calls ×`)) : null, renderSession(cur, 0));
    layout.replaceChildren(side, main);
  }

  const app = document.getElementById('app');
  app.replaceChildren(renderHeader(), h('div', { id: 'layout', class: 'layout' }));
  new ResizeObserver(entries => document.documentElement.style.setProperty('--header-height', `${entries[0].target.offsetHeight}px`)).observe(document.querySelector('.top'));
  render();
  document.addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { e.preventDefault(); document.getElementById('q').focus(); } });
  function followHash() {
    const m = location.hash.match(/^#b-(.+)-(-?\d+)-(-?\d+)$/);
    if (m && byId.has(m[1])) openTo(m[1], Number(m[2]), Number(m[3]));
    else if (location.hash.startsWith('#session-')) selectSession(location.hash.slice(9), false);
    else if (!location.hash) selectSession(root.id, false);
  }
  window.addEventListener('hashchange', followHash);
  window.addEventListener('popstate', followHash);
  followHash();
})();
