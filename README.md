# antigravity-acp

Use **Antigravity** (`agy`) as a subagent from **Claude Code** and **Codex**, over a warm
ACP (Agent Client Protocol) connection: one `agy acp` process stays running, so a
follow-up typically comes back in a few seconds instead of paying a cold start every call.

在 **Claude Code** 和 **Codex** 里把 **Antigravity**（`agy`）当子代理用。底层走 ACP，`agy` 一直开着，所以不用每次重新启动，接着问通常几秒就回。

| | Claude Code | Codex |
| --- | --- | --- |
| Folder | [`claude/`](claude/) | [`codex/agy/`](codex/agy/) |
| Quick call | `/agy <task>` (skips Claude's model) | `/agy <task>` or `agy: <task>` (a hook skips Codex's model) |
| Via the AI | tool `mcp__antigravity-acp__ask` | skill `$agy` |
| Status | tested | tested with simulated hook input only |

## Requirements / 需要

- Node.js 18+ and `agy` (Antigravity CLI) on PATH
- `agy` logged in: `agy acp --login`

## Install in Claude Code / 在 Claude Code 里安装

```
/plugin install antigravity-acp --marketplace lvdoushacc/antigravity-acp
```

Answer `y` to add the marketplace, then pick a scope. Then type `/agy hello`.

## Install in Codex / 在 Codex 里安装

Copy [`codex/agy/`](codex/agy/) to `~/.codex/plugins/agy` and follow
[`codex/agy/README.md`](codex/agy/README.md) (marketplace entry, then trust the hook).

## How it works / 原理

```
Claude Code plugin ─┐
Codex hook ─────────┼─ HTTP 127.0.0.1:47821 (token) ─► acp-bridge.mjs ─ ACP stdio ─► agy acp
agy-client.mjs CLI ─┘
```

`bridge/acp-bridge.mjs` keeps one `agy acp` process warm, reuses one ACP session
per folder and conversation name, answers Antigravity's permission requests
(allowed unless `readOnly`), and cancels a turn on interrupt. Every client shares
one bridge and one token in `~/.agy-acp/token`, created on first use. Each plugin
folder carries its own copy of `bridge/`, so it can be installed on its own.

Note: the bridge approves the edits and commands Antigravity asks for, unless a
call is made read-only. Use it on folders you are happy to let Antigravity change.

## License

MIT
