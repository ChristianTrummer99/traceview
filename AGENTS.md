# Traceview

Traceview is a local, read-only transcript inspector for OpenCode and Claude Code.
Keep it runnable with Node 22.13+ and no runtime npm dependencies or build step.

## Development

- `cli.mjs` owns CLI commands and the loopback HTTP server.
- `opencode.mjs` and `claude.mjs` normalize source transcripts into `model.mjs`.
- `catalog.mjs` owns local bookmarks and optional version-1 AICNC ledger links.
- `render.mjs`, `viewer.js`, `index.js` and `viewer.css` provide self-contained HTML.
- Keep navigation as real links so modified clicks and browser history work.
- Treat transcripts as untrusted data: escape text/HTML and never execute tools
  from a transcript. Open transcript databases read-only.
- Use synthetic fixtures for automated tests. Never commit real transcripts,
  exports, bookmarks, screenshots, local databases or credentials.
- Keep `.session-viewer/` compatible with existing bookmarks and exports.
- Use `uv` for Python tooling; browser tests declare their dependencies inline.

## Verification

Run `npm test` after source edits. For UI changes, also run the browser smoke test
against a local server as described in README.md. Report checks actually run and
any limitations. CI must stay enabled.
