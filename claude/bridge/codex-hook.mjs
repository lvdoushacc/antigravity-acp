// Codex UserPromptSubmit hook: a prompt that starts with `/agy` (or `agy:`)
// goes straight to Antigravity through the warm ACP bridge, and Codex's own
// model never sees it. Any other prompt passes through untouched.
//
//   /agy <task>          continue this Codex chat's Antigravity conversation
//   /agy --new <task>    start that conversation over
//
// Reads the hook input (JSON) on stdin; on a match prints one JSON object
// that blocks the prompt and shows Antigravity's reply.
import { format, runJob } from './agy-client.mjs';

// `/agy` must end at a space (so `/agyx` is not it); `agy:` / `agy：` may be
// followed by the task right away.
const TRIGGER = /^\s*(?:\/agy(?=\s|$)|agy[:：])\s*/i;
// Leave headroom under the hook's own timeout (hooks.json sets 900 s).
const JOB_TIMEOUT_SEC = 840;

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function answer(text) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: text, systemMessage: text }));
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  process.exit(0); // not hook input we understand: let the prompt through
}

const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
const m = prompt.match(TRIGGER);
if (!m) process.exit(0);

let task = prompt.slice(m[0].length).trim();
const fresh = /^--new(\s|$)/.test(task);
if (fresh) task = task.replace(/^--new\s*/, '').trim();

if (!task) {
  answer('用法：/agy 任务内容    （/agy --new 任务内容 = 开新对话）');
  process.exit(0);
}

try {
  const job = await runJob({
    task,
    fresh,
    cwd: input.cwd || process.cwd(),
    session: input.session_id ? `codex-${input.session_id}` : 'codex',
    timeoutSec: JOB_TIMEOUT_SEC,
  });
  answer(format(job));
} catch (err) {
  answer(`Antigravity: ${err.message}`);
}
process.exit(0);
