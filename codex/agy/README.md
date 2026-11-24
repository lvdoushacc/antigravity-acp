# agy — Antigravity in Codex, via ACP

Type `/agy <task>` (or `agy: <task>`) in a Codex chat. A `UserPromptSubmit` hook
catches it, sends it to Antigravity (`agy`) through a warm ACP bridge, and shows
Antigravity's reply. Codex's own model never sees that prompt.

- `/agy <task>`: continue this Codex chat's Antigravity conversation (each chat has its own)
- `/agy --new <task>`: start that conversation over
- any other prompt passes through untouched

## How it works

`bridge/acp-bridge.mjs` keeps one `agy acp` process running and talks ACP
(JSON-RPC over stdio) to it, so there is no cold start per call. It listens on
`127.0.0.1:47821` and requires a token stored in `~/.agy-acp/token`, created on
first use. The hook (`bridge/codex-hook.mjs`) starts the bridge in the
background when it is not running. Antigravity's permission requests (edit a
file, run a command) are approved by the bridge, and the reply lists the steps it took.

The same bridge and token are shared with the Claude Code plugin
`antigravity-acp`, so both can be installed side by side.

## Requirements

- Node.js 18+ and `agy` (Antigravity CLI) on PATH
- `agy` logged in: `agy acp --login`

## Install: one line

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/lvdoushacc/antigravity-acp/main/install-codex.ps1 | iex
```

The script does the manual steps below, keeping any other plugins you have
listed. Then restart Codex and trust the hook under **Settings > Hooks**
(or `/hooks` in the CLI). Installing a plugin does not trust its hooks.

## Install by hand (Codex desktop)

1. Copy this folder to `~/.codex/plugins/agy`.
2. Create or extend `~/.agents/plugins/marketplace.json`:

   ```json
   {
     "name": "personal-local",
     "interface": { "displayName": "Personal Local" },
     "plugins": [
       {
         "name": "agy",
         "source": { "source": "local", "path": "./.codex/plugins/agy" },
         "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
         "category": "Productivity"
       }
     ]
   }
   ```

3. Restart Codex, enable `agy` in the plugin browser, then trust its hook under
   **Settings > Hooks** (installing a plugin does not trust its hooks).

## Codex CLI

OpenAI documents plugin hooks for manually installed desktop plugins. If the
CLI does not run them, copy the `UserPromptSubmit` block from `hooks/hooks.json`
into `~/.codex/hooks.json`, replace `${PLUGIN_ROOT}` with this folder's absolute
path, and trust it with `/hooks`.

## Troubleshooting

- Codex rejects `/agy` as an unknown command: type `agy: <task>` instead, or
  `$agy <task>` to let Codex's model run the bundled skill.
- Bridge log: `~/.agy-acp/bridge.log`.
- Terminal use without Codex: `node bridge/agy-client.mjs [--new] [--read-only] "task"`.

Status: tested by feeding the hook simulated Codex input; not yet tested inside Codex itself.

## License

MIT
