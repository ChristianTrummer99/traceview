import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverCodexSessions, listCodexSessions, loadCodexRun, parseCodexTranscript, resolveCodexSession } from '../codex.mjs';
import { context, listAll, loadRun, serve } from '../cli.mjs';
import { transcriptMarkdown } from '../model.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceview-codex-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  const directory = path.join(home, 'project'); fs.mkdirSync(directory);
  let tick = 0;
  const rec = (type, payload, at) => ({ timestamp: new Date(at ?? 1700000000000 + ++tick * 1000).toISOString(), type, payload });
  const response = p => rec('response_item', p);
  const write = (id, rows, meta = {}, archived = false) => {
    const dir = path.join(home, archived ? 'archived_sessions' : 'sessions/2026/09/22'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-test-${id}.jsonl`);
    const head = rec('session_meta', { id, cwd: directory, timestamp: '2026-09-22T10:00:00Z', source: 'cli', cli_version: 'test', ...meta });
    fs.writeFileSync(file, [head, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  return { home, directory, rec, response, write };
}
const text = (role, value, extra = {}) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }], ...extra });
const call = (id, name, input) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) });
const result = (id, output) => ({ type: 'function_call_output', call_id: id, output: typeof output === 'string' ? output : JSON.stringify(output) });

test('Codex legacy rollouts: mirrored messages, repeated prompts, pairing, failures, encrypted reasoning and token totals', t => {
  const f = fixture(t), { rec, response } = f;
  const user = response(text('user', 'Inspect this project'));
  const answer = response(text('assistant', 'Here is the result.', { id: 'message-a' }));
  const file = f.write('root', [
    response(text('user', '# AGENTS.md instructions for /project\n<INSTRUCTIONS>Context</INSTRUCTIONS>')),
    user, rec('event_msg', { type: 'user_message', message: 'Inspect this project' }, Date.parse(user.timestamp)),
    rec('turn_context', { model: 'test-codex' }),
    response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Check the tests.' }], encrypted_content: 'PRIVATE_CIPHERTEXT' }),
    response(call('cmd', 'functions.exec_command', { cmd: 'exit 2', workdir: f.directory })),
    response(result('cmd', 'Wall time: 0.2 seconds\nProcess exited with code 2\nOutput:\nfailed')),
    response({ type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: example.txt\n+fixture\n*** End Patch' }),
    response({ type: 'custom_tool_call_output', call_id: 'patch', output: [{ type: 'input_text', text: 'Success' }] }),
    answer, rec('event_msg', { type: 'agent_message', message: 'Here is the result.' }, Date.parse(answer.timestamp)),
    rec('token_usage_record', { thread_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 4 } }),
    rec('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 4 } } }),
    response(text('user', 'Inspect this project')), // an actual repeated prompt is not deduplicated
    response(call('unfinished', 'exec_command', { cmd: 'long-running-check' })),
    response(result('orphan', 'An output with no retained call')),
    rec('compacted', { message: 'Summary retained', replacement_history: [text('user', 'Not another turn')] }),
  ]);
  fs.appendFileSync(file, '{"partial":');
  const s = parseCodexTranscript(file), blocks = s.turns.flatMap(t => t.blocks);
  assert.equal(s.turns.filter(t => t.prompt).length, 2);
  assert.equal(blocks.filter(b => b.kind === 'text').length, 1);
  assert.equal(blocks.find(b => b.id === 'cmd').status, 'error');
  assert.equal(blocks.find(b => b.id === 'patch').input.patchText.includes('example.txt'), true);
  assert.equal(blocks.find(b => b.id === 'unfinished').status, 'incomplete');
  assert.equal(blocks.find(b => b.label === 'orphan-result').text, 'An output with no retained call');
  assert.equal(s.tokens.input, 60); assert.equal(s.tokens.cacheRead, 40); assert.equal(s.tokens.output, 10);
  assert.ok(!JSON.stringify(s).includes('PRIVATE_CIPHERTEXT'));
  assert.ok(s.notes.some(n => n.includes('encrypted reasoning')));
  assert.ok(s.notes.some(n => n.includes('partial JSONL')));
});

test('Codex current rollouts: deduplicate item events and preserve inner exec execution evidence', t => {
  const f = fixture(t), { rec, response } = f;
  const message = response(text('user', 'Run the checks', { internal_chat_message_metadata_passthrough: { turn_id: 'turn-one' } }));
  const file = f.write('current', [
    rec('event_msg', { type: 'task_started', turn_id: 'turn-one' }),
    message,
    rec('event_msg', { type: 'item_completed', turn_id: 'turn-one', item: { type: 'UserMessage', id: 'ui-user', content: [{ type: 'text', text: 'Run the checks' }] } }),
    response(call('direct', 'exec_command', { cmd: 'direct-check' })),
    rec('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'direct', command: ['sh', '-c', 'direct-check'], status: 'completed', exit_code: 0, stdout: 'passed' } }),
    response(result('direct', { output: 'passed', metadata: { exit_code: 0 } })),
    response({ type: 'custom_tool_call', call_id: 'wrapper', name: 'exec', input: 'text(await tools.exec_command({cmd: "nested-check"}));' }),
    rec('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'nested', command: ['sh', '-c', 'nested-check'], status: 'failed', exit_code: 3, stdout: 'failed check', stderr: 'details' } }),
    response({ type: 'custom_tool_call_output', call_id: 'wrapper', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n{"exit_code":3}' }] }),
    rec('event_msg', { type: 'item_completed', item: { type: 'FileChange', id: 'file-edit', status: 'completed', changes: { 'file.txt': { type: 'add', content: 'fixture' } } } }),
  ]);
  const run = loadCodexRun({ home: f.home, id: 'current' }), s = run.sessions[0], blocks = s.turns.flatMap(t => t.blocks);
  assert.equal(s.turns.length, 1);
  assert.equal(s.stats.toolCalls, 4); // direct call + wrapper + nested execution + file change
  assert.equal(blocks.filter(b => b.id === 'direct').length, 1);
  assert.equal(blocks.find(b => b.id === 'nested').meta.observedExecution, true);
  assert.equal(blocks.find(b => b.id === 'nested').status, 'error');
  assert.match(blocks.find(b => b.id === 'file-edit').summary, /file.txt/);
  assert.match(transcriptMarkdown(run), /nested-check/);
  assert.ok(fs.existsSync(file));
});

test('Codex discovery: project boundaries, archived files, title index, refresh and ambiguous IDs', t => {
  const f = fixture(t);
  const root = f.write('root-1', [f.response(text('user', 'Original prompt'))]);
  f.write('root-2', [], { cwd: path.join(f.directory, 'subdir') }, true);
  f.write('other', [], { cwd: f.directory + '-other' });
  f.write('child', [], { source: { subagent: { thread_spawn: { parent_thread_id: 'root-1' } } } });
  fs.writeFileSync(path.join(f.home, 'session_index.jsonl'), JSON.stringify({ id: 'root-1', thread_name: 'Renamed run' }) + '\n');
  const rows = listCodexSessions({ home: f.home, directory: f.directory });
  assert.deepEqual(new Set(rows.map(r => r.id)), new Set(['root-1', 'root-2']));
  assert.equal(rows.find(r => r.id === 'root-1').title, 'Renamed run');
  assert.equal(rows.find(r => r.id === 'root-1').children, 1);
  assert.equal(listCodexSessions({ home: f.home, directory: f.directory, includeChildren: true }).length, 3);
  assert.throws(() => resolveCodexSession(discoverCodexSessions(f.home), 'root'), /Ambiguous/);
  fs.appendFileSync(root, JSON.stringify(f.response(call('new', 'exec_command', { cmd: 'new activity' }))) + '\n');
  assert.equal(listCodexSessions({ home: f.home, directory: f.directory }).find(r => r.id === 'root-1').toolCalls, 1);
});

test('Codex agent trees: UUID and path-style spawns, nested agents, missing transcripts and encrypted tasks', t => {
  const f = fixture(t), { response, rec } = f;
  f.write('parent', [response(text('user', 'Delegate tasks')), response(call('spawn-path', 'functions.collaboration.spawn_agent', { task_name: 'worker', message: 'Check it' })), response(result('spawn-path', { task_name: '/root/worker' })), response(call('gone', 'spawn_agent', { prompt: 'Missing agent' })), response(result('gone', { agent_id: 'deleted' }))], { agent_path: '/root' });
  f.write('worker', [
    rec('event_msg', { type: 'task_started', turn_id: 'worker-turn' }),
    response({ type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'ENCRYPTED_ASSIGNMENT' }] }),
    response(call('nested', 'spawn_agent', { prompt: 'Child assignment' })), response(result('nested', { agent_id: 'nested' })),
    response(call('to-parent', 'send_message', { target: '/root', message: 'Progress' })), response(result('to-parent', { delivered: true })),
  ], { session_id: 'parent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', agent_path: '/root/worker' } } } });
  f.write('nested', [response(text('user', 'Child assignment'))], { parent_thread_id: 'worker', agent_path: '/root/worker/nested' }, true);
  f.write('fork', [], { forked_from_id: 'parent' });
  const run = loadCodexRun({ home: f.home, id: 'parent' });
  assert.deepEqual(run.sessions.map(s => s.id), ['parent', 'worker', 'nested']);
  const [root, worker] = run.sessions;
  assert.equal(root.turns[0].blocks.find(b => b.id === 'spawn-path').childSessionId, 'worker');
  assert.equal(root.turns[0].blocks.find(b => b.id === 'gone').childMissing, true);
  assert.equal(worker.spawnedBy.toolCallId, 'spawn-path');
  assert.equal(worker.turns[0].blocks.find(b => b.id === 'to-parent').childSessionId, undefined);
  assert.equal(root.spawnedBy, null);
  assert.match(worker.prompt, /Encrypted content unavailable/);
  assert.ok(!JSON.stringify(run).includes('ENCRYPTED_ASSIGNMENT'));
});

test('Codex image limits, aborted turns and unknown response types remain inspectable', t => {
  const f = fixture(t);
  const file = f.write('media', [f.response({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }), f.rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' }), f.response({ type: 'future_item', value: 'preserved', encrypted_content: 'opaque' })]);
  const s = parseCodexTranscript(file, { maxImage: 2 });
  assert.equal(s.turns[0].prompt.attachments[0].omitted, true);
  assert.ok(s.turns[0].blocks.some(b => b.label === 'turn_aborted'));
  assert.ok(s.turns[0].blocks.some(b => b.text.includes('preserved')));
  assert.ok(!JSON.stringify(s).includes('opaque'));
});

test('Codex CLI/HTTP routes and all-source resolution work without an OpenCode installation', async t => {
  const f = fixture(t);
  f.write('test-session', [f.response(text('user', 'Only Codex is installed'))]);
  const ctx = context({ dir: f.directory, 'codex-home': f.home, db: path.join(f.home, 'missing.db'), projects: path.join(f.home, 'missing-claude') });
  const { rows } = await listAll(ctx); assert.equal(rows.length, 1); assert.equal(rows[0].source, 'codex');
  const run = await loadRun(ctx, 'test-session'); assert.equal(run.source, 'codex');
  const server = await serve(ctx, 0);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(`${base}/run/codex/test-session`)).text(); assert.match(html, /Only Codex is installed/);
  const index = await (await fetch(base)).text(); assert.match(index, /value="codex"/);
  const data = await (await fetch(`${base}/data/codex/test-session`)).json(); assert.equal(data.source, 'codex');
  const exported = await (await fetch(`${base}/transcript/codex/test-session`)).text(); assert.match(exported, /Only Codex is installed/);
});
