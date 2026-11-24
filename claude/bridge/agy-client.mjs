// agy-client: talk to the warm ACP bridge from anything that runs Node.
// Usable from any terminal, and from any other client that runs Node:
//
//   node agy-client.mjs [--new] [--read-only] [--session NAME] [--cwd DIR] "task"
//
// Starts the bridge in the background when it is not running.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken, STATE_DIR } from './token.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGY_ACP_PORT || 47821);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  return { 'content-type': 'application/json', 'x-bridge-token': readToken() };
}

async function healthy() {
  try {
    const r = await fetch(`${BASE}/health`, { headers: headers(), signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureBridge(cwd) {
  if (await healthy()) return;
  const log = openSync(join(STATE_DIR, 'bridge.log'), 'a');
  const argv = [join(HERE, 'acp-bridge.mjs'), '--port', String(PORT)];
  if (cwd) argv.push('--cwd', cwd);
  spawn(process.execPath, argv, { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await healthy()) return;
  }
  throw new Error(`bridge did not start; see ${join(STATE_DIR, 'bridge.log')}`);
}

/** Runs one task; resolves the finished job. `signal` aborting cancels it. */
export async function runJob({ task, cwd = process.cwd(), session = 'default', fresh = false, readOnly = false, model, timeoutSec, signal } = {}) {
  await ensureBridge(cwd);
  const created = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ task, cwd, session, fresh, readOnly, model, timeoutSec }),
  });
  if (!created.ok) throw new Error(`bridge refused the job: ${await created.text()}`);
  const { jobId } = await created.json();
  const cancel = () => fetch(`${BASE}/jobs/${jobId}/cancel`, { method: 'POST', headers: headers() }).catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const r = await fetch(`${BASE}/jobs/${jobId}?wait=25000`, { headers: headers() });
      if (!r.ok) throw new Error(`bridge lost the job: ${await r.text()}`);
      const job = await r.json();
      if (job.status !== 'running') return job;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Same layout as the Claude plugin's format() in hooks/register.ts. */
export function format(job) {
  const secs = job.endedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : 0;
  const out = [];
  out.push(`[Antigravity · session "${job.session}" · ${job.status}${job.stopReason ? ` (${job.stopReason})` : ''} · ${secs}s]`);
  if (job.error) out.push(`Error: ${job.error}`);
  out.push('', (job.text || '').trim() || '(no reply text)');
  if (job.toolCalls?.length) {
    out.push('', `Steps it took (${job.toolCalls.length}):`);
    for (const t of job.toolCalls.slice(-40)) out.push(`- [${t.status ?? '?'}] ${t.title ?? t.kind ?? 'tool'}`);
  }
  const refused = (job.permissions || []).filter((p) => p.decision !== 'allowed');
  if (refused.length) {
    out.push('', 'Permissions refused (readOnly):');
    for (const p of refused) out.push(`- ${p.title}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = { cwd: process.cwd() };
  const words = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--new') opts.fresh = true;
    else if (a === '--read-only') opts.readOnly = true;
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--ensure') opts.ensure = true;
    else words.push(a);
  }
  if (opts.ensure) {
    // Start the shared bridge in the background if it is not running, then
    // exit. The bridge belongs to no client and outlives this process.
    ensureBridge(opts.cwd)
      .then(() => { console.log('ok'); process.exit(0); })
      .catch((err) => { console.error(err.message); process.exit(1); });
  } else {
  opts.task = words.join(' ').trim();
  if (!opts.task) {
    console.error('usage: node agy-client.mjs [--new] [--read-only] [--session NAME] [--cwd DIR] [--model ID] "task"');
    process.exit(2);
  }
  const ac = new AbortController();
  process.on('SIGINT', () => { ac.abort(); setTimeout(() => process.exit(130), 1000); });
  runJob({ ...opts, signal: ac.signal })
    .then((job) => { console.log(format(job)); process.exit(job.status === 'done' ? 0 : 1); })
    .catch((err) => { console.error(`Antigravity: ${err.message}`); process.exit(1); });
  }
}
