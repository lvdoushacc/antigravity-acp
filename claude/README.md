# antigravity-acp

A Claude Code plugin that lets Claude hand tasks to Antigravity (`agy`) as a
subagent, over a warm ACP (Agent Client Protocol) connection, so `agy` is not
started from scratch on every call.

## Install

```
/plugin install antigravity-acp --marketplace lvdoushacc/antigravity-acp
```

Answer `y` to add the marketplace, then pick a scope.

## Usage

- `/agy <task>`: send a task straight to Antigravity. Claude's model is not involved, and the reply is shown in the chat.
- `/agy --new <task>`: start the Antigravity conversation over.
- Or just ask Claude ("let Antigravity check this bug"). Claude then calls the
  tool `mcp__antigravity-acp__ask`, which takes these fields:
  - `task` (required): full instructions; Antigravity cannot see the chat.
  - `session`: conversation name to continue (default `default`).
  - `fresh`: start that conversation over.
  - `cwd`: folder Antigravity works in (default: the session's folder).
  - `model`: an agy model id, e.g. `gemini-4-neon-high`.
  - `readOnly`: refuse every permission Antigravity asks for.
  - `timeoutSec`: give up after this long (default 900).

## How it works

- At session start the plugin launches `bridge/acp-bridge.mjs` (Node). The
  bridge keeps one `agy acp` process running, pre-opens a conversation for the
  session's folder, and listens on `127.0.0.1:47821`. Every request needs the
  token in `~/.agy-acp/token`, which is created on first use.
- The bridge answers Antigravity's permission requests itself. They are
  allowed unless `readOnly` is set. The result lists the steps Antigravity took.
- Interrupting Claude cancels the Antigravity turn (`session/cancel`). If `agy`
  crashes, the bridge restarts it on the next call. If the bridge dies, the
  plugin restarts it.
- Other clients can share the same bridge. `bridge/agy-client.mjs` is a small CLI:
  `node bridge/agy-client.mjs [--new] [--read-only] "task"`. The companion
  Codex plugin `agy` uses the same bridge and token.

## Requirements

- Node.js 18+ and `agy` (Antigravity CLI) on PATH
- `agy` logged in: `agy acp --login`

## License

MIT
