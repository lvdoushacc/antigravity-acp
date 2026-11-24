# antigravity-acp

A Claude Code plugin that lets Claude hand tasks to Antigravity (`agy`) as a
subagent, over a warm ACP (Agent Client Protocol) connection, so `agy` is not
started from scratch on every call.

## Install (PowerShell)

```powershell
irm https://raw.githubusercontent.com/lvdoushacc/antigravity-acp/main/install-claude.ps1 | iex
```

Run it again to update.

## Usage

- `/agy <task>`: send a task straight to Antigravity. Claude's model is not involved, and the reply is shown in the chat.
- `/agy --new <task>`: start the Antigravity conversation over.
- `/agym`: pick the model in two clicks (family, then level). `/agym ls` lists
  them numbered, `/agym 2` switches to number 2. The choice is remembered.
- `/agy -m carbon-high <task>`: switch model and run. Loose names work.
- Or just ask Claude ("let Antigravity check this bug"). Claude then calls the
  tool `mcp__antigravity-acp__ask`, which takes these fields:
  - `task` (required): full instructions; Antigravity cannot see the chat.
  - `session`: conversation name to continue (default `default`).
  - `fresh`: start that conversation over.
  - `cwd`: folder Antigravity works in (default: the session's folder).
  - `model`: an agy model id, e.g. `gemini-4-neon-high` (default: the one picked with `/agym`).
  - `readOnly`: refuse every permission Antigravity asks for.
  - `timeoutSec`: give up after this long (default 900).

## How it works

- `bridge/acp-bridge.mjs` (Node) keeps one `agy acp` process running and
  listens on `127.0.0.1:47821`. It belongs to no session: the first session
  that needs it starts it in the background, every session shares it, and it
  exits after 2 hours idle. If it is gone, the next call starts it again.
- Every request needs the token in `~/.agy-acp/token`, created on first use.
- The bridge reuses one ACP session per folder and conversation name, answers
  Antigravity's permission requests (allowed unless `readOnly`), and cancels a
  turn on interrupt (`session/cancel`). If `agy` crashes, the bridge restarts it.
- `bridge/agy-client.mjs` is a small CLI on the same bridge:
  `node bridge/agy-client.mjs [--new] [--read-only] [--model ID] "task"`.

## Requirements

- Node.js 18+ and `agy` (Antigravity CLI) on PATH
- `agy` logged in: `agy acp --login`

## License

MIT
