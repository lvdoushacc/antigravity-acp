---
name: agy
description: Hand a task to Antigravity (Google's agy agent) and report its answer. Use only when the user explicitly asks for Antigravity or agy.
---

Antigravity runs through a warm ACP bridge on this machine. The client script ships with this plugin: it is `bridge/agy-client.mjs` in the plugin's root folder, two levels above the folder holding this SKILL.md (`../../bridge/agy-client.mjs`). Resolve that to an absolute path, run exactly one command, and show the user its output as is:

```
node "<plugin root>/bridge/agy-client.mjs" --session codex --cwd "<current working folder>" "<the full task>"
```

- Antigravity cannot see this conversation: write the full task (goal, files, constraints, what to report) into the quoted task.
- Add `--new` to start the Antigravity conversation over, `--read-only` when it must not change anything.
- It can take a few minutes; do not run it in the background.

Usually the user does not need this skill: typing `/agy <task>` (or `agy: <task>`) is caught by this plugin's hook and goes to Antigravity directly.
