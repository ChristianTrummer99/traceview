// Viewer-owned bookmarks and read-only links to the CNC stage ledger.
// A session is not a workflow step. Only exact IDs or task-path references link them.
import fs from 'node:fs';
import path from 'node:path';

const registryPath = directory => path.join(directory, '.session-viewer', 'runs.json');
const strings = value => typeof value === 'string' ? value : value && typeof value === 'object' ? Object.values(value).map(strings).join('\n') : '';
export function readBookmarks(directory) {
  const file = registryPath(directory);
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.runs)) throw new Error(`Unsupported bookmark registry: ${file}`);
  return data.runs;
}

export function bookmarkRun(directory, run, { label, workflowRun, remove = false } = {}) {
  const rows = readBookmarks(directory).filter(r => !(r.id === run.rootId && r.source === run.source));
  if (!remove) {
    if (workflowRun) readLedger(directory, workflowRun); // Validate before writing the registry.
    rows.push({ id: run.rootId, source: run.source, label: label || run.sessions[0].title, workflowRun: workflowRun || null });
  }
  const file = registryPath(directory);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: rows }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readLedger(directory, relative) {
  const base = path.resolve(directory, 'pipeline/runs');
  const dir = path.resolve(directory, relative);
  if (!dir.startsWith(base + path.sep)) throw new Error('Workflow run must be inside this project’s pipeline/runs/');
  const file = path.join(dir, 'state.json');
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(base) + path.sep)) throw new Error('Workflow ledger resolves outside pipeline/runs/');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.version !== 1 || !state.issued || !state.results) throw new Error(`Unsupported workflow ledger: ${file}`);
  return { path: path.relative(directory, dir).split(path.sep).join('/'), state };
}

// Match path tokens, not substrings (r1 must not match r10, nor .json.bak).
function mentions(text, value) {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'\x60(=])${escaped}(?=$|[\\s"'\x60),;]|[.](?:$|\\s))`).test(text);
}

export function attachWorkflowEvidence(run, directory, bookmark = null) {
  run.bookmark = bookmark;
  run.workflows = [];
  run.warnings = [];
  const refs = run.sessions.map(s => ({
    sessionId: s.id,
    // Ignore tool outputs: reading an old ledger is not executing its stages.
    text: [s.prompt, ...s.turns.flatMap(t => [t.prompt?.text, ...t.blocks.filter(b => b.kind === 'tool').map(b => strings(b.input))])].filter(Boolean).join('\n'),
  }));
  const base = path.join(directory, 'pipeline/runs');
  const candidates = new Set(bookmark?.workflowRun ? [bookmark.workflowRun] : []);
  if (fs.existsSync(base)) for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(base, entry.name, 'state.json'))) candidates.add(`pipeline/runs/${entry.name}`);
  }
  for (const relative of candidates) {
    let ledger;
    try { ledger = readLedger(directory, relative); }
    catch (e) { run.warnings.push(`${relative}: ${e.message}`); continue; }
    const { state } = ledger;
    const knownIds = new Set(run.sessions.map(s => s.id));
    const linkedById = Object.values(state.results).some(r => knownIds.has(r.nativeAgentId));
    const linkedByPath = refs.some(r => mentions(r.text, ledger.path) || mentions(r.text, path.join(directory, ledger.path)) || r.text.includes(`${ledger.path}/tasks/`));
    if (relative !== bookmark?.workflowRun && !linkedById && !linkedByPath) continue;
    const steps = Object.entries(state.issued).map(([id, task]) => {
      const result = state.results[id];
      const exact = result?.nativeAgentId && knownIds.has(result.nativeAgentId) ? [result.nativeAgentId] : [];
      const taskPath = `${ledger.path}/tasks/${id}.json`;
      const assigned = run.sessions.filter(s => mentions(s.prompt || s.turns[0]?.prompt?.text || '', taskPath) || mentions(s.prompt || '', path.join(directory, taskPath))).map(s => s.id);
      // Parent references are evidence locations, not proof that it performed the stage.
      const references = [];
      for (const s of run.sessions) for (const t of s.turns) t.blocks.forEach((b, i) => {
        if (b.kind !== 'tool') return;
        const text = strings(b.input);
        if (mentions(text, taskPath) || mentions(text, path.join(directory, taskPath))) references.push({ sessionId: s.id, turn: t.index, block: i });
      });
      const sessionIds = exact.length ? exact : assigned;
      return {
        id, phase: task.phase || '', prompt: task.prompt || '', schema: task.schema || null, taskFile: task.task_file || taskPath,
        resultFile: task.result_file || `${ledger.path}/results/${id}.json`,
        nativeAgentId: result?.nativeAgentId || null, recordedAt: result?.recorded || null,
        status: result ? 'recorded' : 'issued', result: result?.result ?? null,
        sessionIds, linkBasis: exact.length ? 'recorded native agent ID' : assigned.length ? 'exact task path in assigned prompt' : null,
        references,
      };
    });
    run.workflows.push({ path: ledger.path, partId: state.config?.part_id, created: state.created, config: state.config, gates: state.gates || {}, steps });
  }
  return run;
}
