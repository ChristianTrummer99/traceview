# Traceview

**See what your agents actually did.**

A local, read-only viewer for OpenCode, Claude Code and Codex sessions. Follow a run
through its agent tree, expand individual tool calls, and take precise evidence
into a conversation alongside the viewer.

No model calls, runtime npm dependencies, frontend build, or agent plugins.

## Quick start

Requires **Node.js 22.13+**. Clone this repository, then run from its directory:

```sh
npm start -- --dir /path/to/your/project --open
```

Open <http://127.0.0.1:8787>. No `npm install` is necessary.
Use `--port 8788` if the default port is occupied. `Ctrl-C` stops the server.

You can also run the CLI directly from the project you want to inspect:

```sh
node /path/to/traceview/cli.mjs serve --open
```

Without `--dir`, the selected project is the Git root of the current working
directory, or the current directory when it is not inside a repository.

## Explore a run

- **Session index:** search by title or ID, filter by source, and bookmark runs.
- **Agent tree:** inspect parent conversations, subagents and nested/resumed work.
- **Collapsible transcripts:** user prompts, assistant narration, recorded reasoning,
  commands, file edits, tool inputs/outputs, errors and metadata.
- **Cross-thread search:** find evidence across the entire run, then jump to its
  exact turn and block. Press `/` to focus search.
- **Tool/error filters:** inspect one tool type or failed tool/API calls.
- **Real links:** Command-click, Ctrl-click, middle-click and the browser's
  “Open Link in New Tab” action work on thread, breadcrumb, outline, search and
  workflow-evidence links. Normal clicks navigate in place.
- **AI-ready evidence:** copy a thread, turn, tool call or linked workflow stage,
  or export the full run as text/JSON with stable session references.
- **Offline HTML:** save a self-contained snapshot with no external assets.

Turns and tools start collapsed and render their contents when expanded.
**Refresh** reloads source records. Each page is a snapshot, not a live stream.

For a conversation alongside the viewer, try:

> Which commands actually performed this check? Which claims have observable
> results, and which appear only in the final response? Cite session IDs and
> turn/block references.

Traceview reads and displays evidence; it does not send it to an AI service.

## CLI

Run these commands from the Traceview checkout. Set `--dir` to the project whose
sessions you want to inspect:

```sh
node cli.mjs list --dir /path/to/project
node cli.mjs list --dir /path/to/project --source opencode
node cli.mjs list --dir /path/to/project --source codex
node cli.mjs serve --dir /path/to/project --open
node cli.mjs tag SESSION_ID --dir /path/to/project --label "Feature / attempt one"
node cli.mjs untag SESSION_ID --dir /path/to/project
node cli.mjs render SESSION_ID --dir /path/to/project --open
node cli.mjs outline SESSION_ID --dir /path/to/project
node cli.mjs transcript SESSION_ID --dir /path/to/project
node cli.mjs transcript SESSION_ID --dir /path/to/project --json
```

Unique session ID prefixes are accepted. Add `--source opencode`,
`--source claude` or `--source codex` to select a source explicitly; all three are
enabled by default.
`list --all-dirs` helps discover sessions across projects. For Claude sessions,
use the matching `--dir` when opening a session in another project.

### Bookmarks and exports

Tags are stored in the selected project's `.session-viewer/runs.json`.
Refresh the index and choose **Bookmarked runs** after tagging. Traceview keeps
this directory name compatible with the original viewer.

Default HTML output is `.session-viewer/<source>-<session-id>.html` in the selected
project. Override it with `--out /path/to/review.html`.

Copy controls use the visible preview; full transcript/JSON exports avoid HTML
text-preview limits. Exports are normalized evidence rather than byte-for-byte
source backups. Downloads and refresh are available in server mode; HTML snapshots
work offline and can be regenerated to include newer activity.

## Optional workflow evidence

Traceview originated in an AI-assisted CNC workflow. Its optional adapter reads
existing **version-1 AICNC stage ledgers** at `pipeline/runs/*/state.json` inside
the selected project. Ordinary sessions require no ledger.

A ledger is shown when explicitly bookmarked, referenced by a run/task path in
prompts or tool inputs, or connected by a recorded native agent ID. Showing a
referenced ledger does not establish that it was executed in that conversation.

Each stage exposes its assigned prompt, output schema, recorded result and human
gates. Transcript links require an exact recorded `nativeAgentId` or an exact
task-descriptor path in a worker's assigned prompt. Other mentions are labeled
**task-path references**, not proof of execution. Missing links stay explicit;
there is no title-based guessing or LLM-generated reconstruction.

To link a ledger manually:

```sh
node cli.mjs tag SESSION_ID --dir /path/to/project --label "Part / rebuild" --workflow-run pipeline/runs/part-r1
```

Include `--workflow-run` again if relabeling a manually linked bookmark.
**Recorded** only means a result exists, including failed results. Tool success
does not establish task correctness. A linked/resumed thread can span multiple
assignments; ledger order is issuance order, not necessarily serial execution.
Process instructions and validation remain owned by the source project.

## Data sources and limits

| Source | Default location |
| --- | --- |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db`, or `~/.local/share/opencode/opencode.db` |
| Claude Code | `~/.claude/projects/<project-slug>/*.jsonl` and session `subagents/` directories |
| Codex | `$CODEX_HOME/sessions/**/*.jsonl` and `archived_sessions/`, falling back to `~/.codex/` |

Override with `--db /path/opencode.db`, `--projects /path/projects`, or
`--codex-home /path/to/codex-home`.

- OpenCode sessions link through `parent_id` and captured task/resume IDs.
  Schema versions without aggregate model/cost/token columns are supported.
- Claude's native tool IDs, metadata and result records link agents. Partial
  trailing JSONL records are skipped with a visible note.
- Codex's original `rollout-*.jsonl` files provide the transcript, including newer
  `item_completed` events. The SQLite UI/history projections are not required.
  Root and subdirectory sessions are discovered by their recorded `cwd`;
  `session_index.jsonl` supplies saved titles when present. Archived transcripts
  are included. Metadata/summary caches refresh when a rollout changes.
- Codex agent links use explicit parent-thread IDs and spawn results. Both UUID
  and run-scoped `/root/...` agent identities are supported. Forks are separate
  sessions, not inferred subagents. Unlinked/internal agent sessions can be listed
  with `list --children`; no parent is guessed for missing metadata.
- Codex UI echoes of messages/tool calls are deduplicated. Commands recorded
  inside an `exec` wrapper have an **observed execution** badge and remain
  inspectable separately; tool counts include both wrapper calls and distinct
  inner executions. The JavaScript wrapper is displayed, never evaluated.
- Codex encrypted reasoning/inter-agent payloads are marked unavailable; no
  decryption is attempted. Task prompts unavailable in plaintext cannot be
  recovered by this viewer. Compacted replacement histories are not replayed as
  new work. Missing results, orphan outputs and partial records stay explicit.
- The server binds to `127.0.0.1`, accepts local hosts and GET requests, and opens
  SQLite read-only. No source sessions are edited and no recorded commands run.
- HTML previews default to 200,000 characters per tool string, 80,000 per text
  block and 400,000 base64 characters per image. Adjust with `--max-output`,
  `--max-text` and `--max-image`. Clipping is labeled; large images may be omitted
  from exports too.
- Source truncation/compaction cannot be undone. OpenCode persisted output paths
  are displayed but not read automatically. The Claude reader can inline saved
  tool outputs; use `--no-inline-files` to disable it.
- Only reasoning text actually recorded by the source is shown. Session **span**
  includes idle time. Tool durations may overlap, and cost/token data may be
  incomplete.
- The SQLite reader retains a `sqlite3` CLI fallback, but Node 22.13+ is the
  supported project/test baseline.

Local transcripts, bookmarks and generated files are excluded by `.gitignore`.

## Development and verification

```sh
npm test
```

Synthetic fixture tests cover source readers, recursive/resumed/missing agents,
exact stage linking, bookmarks, safe HTML embedding, clipping, CLI validation and
the read-only HTTP routes. GitHub Actions runs these on Node 22 and 24.

The optional browser test uses `uv` and Playwright. With the server running against
a project containing a session with tool calls:

```sh
uv run --no-project --with 'playwright>=1.51,<2' playwright install chromium
uv run tests/browser_smoke.py --source opencode --session SESSION_ID --screenshots .session-viewer
```

It checks collapsed defaults, tool/stage inspection, cross-thread search, deep
links, child navigation, clipboard/export, desktop/mobile layout, real new-tab
clicks and history. Screenshots are optional and remain local. Pass `--url` for
another server address, or `--snapshot /path/review.html` to also test an export.

### Source map

| File | Responsibility |
| --- | --- |
| `cli.mjs` | CLI and local HTTP server |
| `opencode.mjs`, `claude.mjs` | Transcript readers |
| `model.mjs` | Shared transcript model and text exports |
| `catalog.mjs` | Bookmarks and optional workflow links |
| `render.mjs` | HTML generation and preview clipping |
| `viewer.js`, `index.js`, `viewer.css` | Browser UI |
| `tests/` | Fixture and browser checks |
