import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openOpenCodeDatabase, listOpenCodeSessions, loadOpenCodeRun, resolveOpenCodeSession } from '../opencode.mjs';
import { loadClaudeRun } from '../claude.mjs';
import { attachWorkflowEvidence, bookmarkRun, readBookmarks } from '../catalog.mjs';
import { context, parseArgs, serve } from '../cli.mjs';
import { clipRun, embedJson, renderIndexPage, renderRunPage } from '../render.mjs';
import { makeSession, makeTurn, buildRun, transcriptMarkdown } from '../model.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceview-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function sqliteFixture(t) {
  const directory = temporary(t), file = path.join(directory, 'opencode.db');
  const db = new DatabaseSync(file);
  // Old OpenCode versions have no aggregate cost, model or token columns.
  db.exec(`create table session(id text primary key, parent_id text, title text, directory text, time_created integer, time_updated integer, version text);
    create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
    create table part(id text primary key, message_id text, session_id text, data text, time_created integer);`);
  const session = db.prepare('insert into session values (?, ?, ?, ?, ?, ?, ?)');
  session.run('ses_root', null, 'Customer run', directory, 1000, 9000, '1');
  session.run('ses_child', 'ses_root', 'Measurement', directory, 2000, 7000, '1');
  session.run('ses_grandchild', 'ses_child', 'Inspect topology', directory, 3000, 6000, '1');
  session.run('ses_pipeline', null, 'Subdirectory run', path.join(directory, 'pipeline'), 3000, 6000, '1');
  session.run('ses_other', null, 'Other project', `${directory}-unrelated`, 3000, 6000, '1');
  let n = 0;
  const message = (sid, role, parts) => {
    const id = `msg_${String(++n).padStart(3, '0')}`;
    db.prepare('insert into message values (?, ?, ?, ?, ?)').run(id, sid, JSON.stringify({ role, modelID: 'test-model', providerID: 'test' }), 1000 + n, 1000 + n);
    for (const [i, data] of parts.entries()) db.prepare('insert into part values (?, ?, ?, ?, ?)').run(`prt_${n}_${i}`, id, sid, JSON.stringify(data), 1000 + n);
  };
  const tool = (id, name, state) => ({ type: 'tool', callID: id, tool: name, state });
  message('ses_root', 'user', [{ type: 'text', text: 'Program the part.' }]);
  message('ses_root', 'assistant', [
    { type: 'text', text: 'Assigning measurement.' },
    tool('spawn', 'task', { status: 'completed', input: { prompt: 'Measure only', description: 'Measure' }, metadata: { sessionId: 'ses_child' }, output: 'done', time: { start: 2000, end: 2200 } }),
    { type: 'reasoning', text: 'Recorded provider text' },
    tool('resume', 'task', { status: 'completed', input: { task_id: 'ses_child' }, output: 'resumed' }),
    tool('missing', 'task', { status: 'completed', input: {}, output: 'task_id: ses_deleted' }),
    tool('bad', 'bash', { status: 'error', input: { command: 'exit 1', workdir: directory }, error: 'Failed command' }),
    tool('pending', 'read', { status: 'running', input: { filePath: 'drawing.json' } }),
    tool('large', 'read', { status: 'completed', input: {}, output: 'captured preview', metadata: { truncated: true, outputPath: '/recorded/output' } }),
  ]);
  message('ses_child', 'user', [{ type: 'text', text: 'Measure only' }]);
  message('ses_child', 'assistant', [tool('nested', 'task', { status: 'completed', input: {}, metadata: { sessionId: 'ses_grandchild' }, output: 'done' })]);
  db.close();
  return { directory, file };
}

test('OpenCode: legacy schema, project descendants, recursive agents, resumes and missing evidence', async t => {
  const fixture = sqliteFixture(t);
  const db = await openOpenCodeDatabase(fixture.file); t.after(() => db.close());
  assert.deepEqual(new Set(listOpenCodeSessions({ db, directory: fixture.directory }).map(s => s.id)), new Set(['ses_root', 'ses_pipeline']));
  const run = loadOpenCodeRun({ db, id: 'ses_root' });
  assert.deepEqual(run.sessions.map(s => s.id), ['ses_root', 'ses_child', 'ses_grandchild']);
  const blocks = run.sessions[0].turns[0].blocks;
  assert.equal(blocks.find(b => b.id === 'resume').childSessionId, 'ses_child');
  assert.equal(blocks.find(b => b.id === 'missing').childMissing, true);
  assert.equal(blocks.find(b => b.id === 'bad').status, 'error');
  assert.equal(blocks.find(b => b.id === 'pending').status, 'running');
  assert.equal(blocks.find(b => b.id === 'large').sourceTruncated, true);
  assert.equal(run.sessions[0].model, 'test/test-model');
  assert.equal(run.sessions[0].stats.errors, 1);
  assert.ok(blocks[0].partId && blocks[0].messageId);
  assert.equal(resolveOpenCodeSession(db, 'ses_ro'), 'ses_root');
  assert.throws(() => resolveOpenCodeSession(db, 'ses_'), /Ambiguous/);
  assert.equal(resolveOpenCodeSession(db, '%'), null);
  assert.equal(db.all('select count(*) as n from session')[0].n, 5);
});

test('Claude: tool results, async child linking, nested agents and malformed trailing JSONL', t => {
  const directory = temporary(t), project = path.join(directory, 'claude');
  fs.mkdirSync(path.join(project, 'root/subagents'), { recursive: true });
  const rec = (type, content, extra = {}) => ({ type, timestamp: '2026-09-21T10:00:00Z', message: { content }, ...extra });
  const write = (file, records) => fs.writeFileSync(path.join(project, file), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  write('root.jsonl', [rec('user', 'Build the part'), rec('assistant', [{ type: 'tool_use', id: 'call1', name: 'Agent', input: { prompt: 'Measure', description: 'Measurement' } }]), rec('user', [{ type: 'tool_result', tool_use_id: 'call1', content: 'Agent launched' }], { toolUseResult: { agentId: 'worker', status: 'async_launched' } })]);
  write('root/subagents/agent-worker.jsonl', [rec('user', 'Measure'), rec('assistant', [{ type: 'tool_use', id: 'call2', name: 'Agent', input: { prompt: 'Check topology' } }])]);
  write('root/subagents/agent-nested.jsonl', [rec('user', 'Check topology')]);
  json(path.join(project, 'root/subagents/agent-nested.meta.json'), { toolUseId: 'call2', description: 'Topology' });
  fs.appendFileSync(path.join(project, 'root/subagents/agent-nested.jsonl'), '{"unfinished":');
  const run = loadClaudeRun({ projectDir: project, id: 'root', inlineFiles: false });
  assert.deepEqual(run.sessions.map(s => s.id), ['root', 'worker', 'nested']);
  assert.equal(run.sessions[1].parentId, 'root');
  assert.equal(run.sessions[2].parentId, 'worker');
  assert.equal(run.sessions[0].turns[0].blocks[0].async, true);
  assert.match(run.sessions[2].notes[0], /unparseable/);
});

function workflowFixture(t) {
  const directory = temporary(t), relative = 'pipeline/runs/part-r1';
  const state = {
    version: 1, config: { part_id: 'part' },
    issued: { measure: { phase: 'Measure', prompt: 'Measure all dimensions', schema: { type: 'object' } }, build: { phase: 'Build', prompt: 'Build the approved plan' }, validate: { phase: 'Validate', prompt: 'Check the result' } },
    results: { measure: { nativeAgentId: 'worker', result: { ok: false }, recorded: '2026-09-21' } }, gates: { plan: { decision: 'approved' } },
  };
  json(path.join(directory, relative, 'state.json'), state);
  const root = makeSession({ id: 'root', source: 'opencode', title: 'Root', turns: [makeTurn({ prompt: { text: 'Build the part' }, blocks: [{ kind: 'tool', name: 'task', id: 'task', input: { prompt: `Read ${relative}/tasks/build.json` }, output: 'done' }] })] });
  const worker = makeSession({ id: 'worker', source: 'opencode', parentId: 'root', title: 'Measurement' });
  return { directory, relative, state, root, worker };
}

test('Workflow links exact native IDs or assigned task paths; never infers execution from a read/reference', t => {
  const f = workflowFixture(t);
  const run = attachWorkflowEvidence(buildRun(f.root, [f.root, f.worker]), f.directory);
  assert.equal(run.workflows.length, 1);
  const [measure, build, validate] = run.workflows[0].steps;
  assert.deepEqual(measure.sessionIds, ['worker']);
  assert.equal(measure.status, 'recorded');
  assert.deepEqual(measure.result, { ok: false }); // recorded != passed
  assert.deepEqual(build.sessionIds, []); // caller references are not worker execution
  assert.equal(build.references.length, 1);
  assert.equal(validate.status, 'issued');
  f.worker.id = 'unrecorded-worker';
  f.worker.prompt = `Read ${path.join(f.directory, f.relative)}/tasks/build.json; perform only this assignment.`;
  const second = attachWorkflowEvidence(buildRun(f.root, [f.root, f.worker]), f.directory);
  assert.deepEqual(second.workflows[0].steps[1].sessionIds, ['unrecorded-worker']);
  f.worker.prompt += '.bak';
  f.worker.prompt = `Read ${f.relative}/tasks/build.json.bak`;
  assert.deepEqual(attachWorkflowEvidence(buildRun(f.root, [f.root, f.worker]), f.directory).workflows[0].steps[1].sessionIds, []);
});

test('Bookmarks are viewer-owned, validate ledgers, and never modify workflow state', t => {
  const f = workflowFixture(t), run = buildRun(f.root, [f.root]);
  const before = fs.readFileSync(path.join(f.directory, f.relative, 'state.json'), 'utf8');
  bookmarkRun(f.directory, run, { label: 'Part / attempt one', workflowRun: f.relative });
  assert.equal(readBookmarks(f.directory)[0].label, 'Part / attempt one');
  assert.throws(() => bookmarkRun(f.directory, run, { workflowRun: '../outside' }), /inside/);
  assert.equal(fs.readFileSync(path.join(f.directory, f.relative, 'state.json'), 'utf8'), before);
  bookmarkRun(f.directory, run, { remove: true });
  assert.deepEqual(readBookmarks(f.directory), []);
});

test('Rendering escapes untrusted transcript HTML, retains code, and discloses clipped evidence', () => {
  const malicious = '</script><script>globalThis.pwned=true</script><!--\u2028';
  assert.deepEqual(JSON.parse(embedJson({ malicious })), { malicious });
  const s = makeSession({ source: 'opencode', id: 'root', title: malicious, turns: [makeTurn({ blocks: [{ kind: 'tool', id: 'tool', name: 'apply_patch', input: { patchText: 'x'.repeat(100) }, output: 'y'.repeat(100), status: 'ok' }] })] });
  const run = buildRun(s, [s]);
  assert.match(transcriptMarkdown(run), /y{100}/);
  clipRun(run, { maxOutput: 10 });
  assert.equal(s.turns[0].blocks[0].inputTruncated, true);
  assert.equal(s.turns[0].blocks[0].outputTruncated.length, 100);
  const page = renderRunPage(run);
  assert.ok(!page.includes('<script>globalThis.pwned'));
  const script = page.match(/<script>(window\.__RUN__=.*?);<\/script>/s)[1];
  const sandbox = { window: {} }; vm.runInNewContext(script, sandbox);
  assert.equal(sandbox.window.__RUN__.sessions[0].title, malicious);
  assert.equal(sandbox.pwned, undefined);
  assert.match(renderIndexPage([{ ...s, bookmark: { label: malicious } }], { directory: '/project' }), /&lt;script&gt;/);
});

test('HTTP serves read-only pages and unabridged evidence, rejects foreign hosts and writes', async t => {
  const f = sqliteFixture(t);
  const ctx = context({ dir: f.directory, source: 'opencode', db: f.file });
  const server = await serve(ctx, 0); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const index = await fetch(base); assert.equal(index.status, 200); assert.match(await index.text(), /Customer run/);
  const page = await fetch(`${base}/run/opencode/ses_root`); assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  const data = await (await fetch(`${base}/data/opencode/ses_root`)).json(); assert.equal(data.sessions.length, 3);
  const transcript = await (await fetch(`${base}/transcript/opencode/ses_root`)).text(); assert.match(transcript, /Failed command/); assert.match(transcript, /Source output was truncated/);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  const foreignStatus = await new Promise((resolve, reject) => http.get(base, { headers: { host: 'foreign.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.equal(foreignStatus, 403);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

test('CLI parses boolean flags before arguments and rejects invalid preview limits', () => {
  assert.deepEqual(parseArgs(['render', '--open', 'ses_root']).positional, ['ses_root']);
  assert.equal(parseArgs(['serve', '--no-inline-files']).flags['inline-files'], false);
  assert.throws(() => context({ 'max-output': 'nope' }), /nonnegative finite/);
  assert.throws(() => context({ source: 'guess' }), /--source/);
});
