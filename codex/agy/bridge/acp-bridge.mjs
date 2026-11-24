// acp-bridge: keeps one `agy acp` process warm and serves it over local HTTP.
//
//   POST /jobs               { task, cwd, session?, fresh?, model?, readOnly?, timeoutSec? } -> { jobId }
//   GET  /jobs/:id?wait=ms   long-poll a job until it finishes or `wait` elapses
//   POST /jobs/:id/cancel    cancel a running job (session/cancel)
//   GET  /health
//
// Every request must carry `x-bridge-token` equal to the shared token
// (~/.agy-acp/token, see token.mjs), or AGY_BRIDGE_TOKEN when that is set.
import { spawn } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import { readToken } from './token.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port || process.env.AGY_ACP_PORT || 47821);
const AGY = args.agy || process.env.AGY_BIN || 'agy';
const WARM_CWD = args.cwd;
const TOKEN = process.env.AGY_BRIDGE_TOKEN || readToken();
const IDLE_EXIT_MS = 2 * 60 * 60 * 1000;

const log = (...m) => console.error(new Date().toISOString(), '[acp-bridge]', ...m);

// ---------------------------------------------------------------- ACP client
let agy = null;          // { child, ready: Promise, send, request }
let lastUse = Date.now();
const sessions = new Map(); // key `${cwd}\n${name}` -> { sessionId, queue: Promise, models }
const bySessionId = new Map(); // sessionId -> active job

function startAgy() {
  const child = spawn(AGY, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let nextId = 0;
  const pending = new Map();
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      send({ jsonrpc: '2.0', id, method, params });
    });

  child.stderr.on('data', (d) => log('[agy stderr]', String(d).trimEnd()));
  child.on('error', (err) => log('agy failed to start:', err.message));
  child.on('exit', (code, signal) => {
    log('agy exited', code, signal);
    for (const p of pending.values()) p.reject(new Error(`agy acp exited (${code ?? signal}) during ${p.method}`));
    pending.clear();
    sessions.clear();
    for (const job of bySessionId.values()) finish(job, 'error', `agy acp exited (${code ?? signal})`);
    bySessionId.clear();
    if (agy && agy.child === child) agy = null;
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(Object.assign(new Error(m.error.message || 'ACP error'), { data: m.error })) : p.resolve(m.result);
    } else if (m.method === 'session/update') {
      onUpdate(m.params);
    } else if (m.method === 'session/request_permission') {
      onPermission(m, send);
    } else if (m.id !== undefined) {
      // fs/* or terminal/*: we advertise neither capability, so refuse.
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} not supported by bridge` } });
    }
  });

  const ready = request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }).then((r) => { log('initialized', r?.agentInfo?.name, r?.agentInfo?.version); return r; });

  agy = { child, ready, send, request };
  return agy;
}

async function getAgy() {
  const a = agy || startAgy();
  await a.ready;
  return a;
}

const normCwd = (cwd) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');

// sessions holds a Promise per key, so callers racing for the same session
// (the warm-up and the first job) share one session/new.
async function getSession(cwd, name, fresh, model) {
  const key = `${normCwd(cwd)}\n${name}`;
  let p = sessions.get(key);
  if (!p || fresh) {
    p = (async () => {
      const a = await getAgy();
      const r = await a.request('session/new', { cwd, mcpServers: [] });
      log('new session', r.sessionId, 'for', JSON.stringify(name), 'in', cwd);
      return { sessionId: r.sessionId, queue: Promise.resolve(), models: r.models, model: null };
    })();
    sessions.set(key, p);
    p.catch(() => { if (sessions.get(key) === p) sessions.delete(key); });
  }
  const s = await p;
  if (model) await setModel(await getAgy(), s, model);
  return s;
}

async function setModel(a, s, model) {
  if (!model || s.model === model) return;
  try {
    await a.request('session/set_model', { sessionId: s.sessionId, modelId: model });
    s.model = model;
  } catch (err) {
    const ids = (s.models?.availableModels || []).map((m) => m.modelId).join(', ');
    throw new Error(`could not set model "${model}": ${err.message}. Available: ${ids}`);
  }
}

// ---------------------------------------------------------------- jobs
const jobs = new Map();
let jobSeq = 0;

function snapshot(job) {
  const { waiters, timer, ...rest } = job;
  return rest;
}

function finish(job, status, error) {
  if (job.status !== 'running') return;
  job.status = status;
  if (error) job.error = error;
  job.endedAt = Date.now();
  clearTimeout(job.timer);
  if (job.sessionId && bySessionId.get(job.sessionId) === job) bySessionId.delete(job.sessionId);
  for (const w of job.waiters.splice(0)) w();
  setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref();
}

function onUpdate({ sessionId, update }) {
  const job = bySessionId.get(sessionId);
  if (!job || !update) return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content?.type === 'text') job.text += update.content.text;
      break;
    case 'tool_call':
      job.toolCalls.push({ id: update.toolCallId, title: update.title, kind: update.kind, status: update.status || 'pending' });
      break;
    case 'tool_call_update': {
      const t = job.toolCalls.find((x) => x.id === update.toolCallId);
      if (t) {
        if (update.status) t.status = update.status;
        if (update.title) t.title = update.title;
      }
      break;
    }
    case 'plan':
      job.plan = (update.entries || []).map((e) => ({ content: e.content, status: e.status }));
      break;
  }
}

function onPermission(m, send) {
  const { sessionId, toolCall, options = [] } = m.params || {};
  const job = bySessionId.get(sessionId);
  const allow = job && !job.readOnly;
  const pick =
    options.find((o) => o.kind === (allow ? 'allow_once' : 'reject_once')) ||
    options.find((o) => (allow ? o.kind?.startsWith('allow') : o.kind?.startsWith('reject')));
  if (job) job.permissions.push({ title: toolCall?.title || toolCall?.toolCallId || '?', decision: allow ? 'allowed' : 'rejected' });
  send({
    jsonrpc: '2.0',
    id: m.id,
    result: { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } },
  });
}

function createJob(body) {
  const job = {
    id: String(++jobSeq),
    status: 'running',
    session: body.session || 'default',
    sessionId: null,
    cwd: body.cwd,
    readOnly: !!body.readOnly,
    text: '',
    toolCalls: [],
    permissions: [],
    plan: [],
    stopReason: null,
    usage: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    waiters: [],
    timer: null,
  };
  jobs.set(job.id, job);
  run(job, body).catch((err) => finish(job, 'error', err.message));
  return job;
}

async function run(job, body) {
  const s = await getSession(body.cwd, job.session, !!body.fresh, body.model);
  // One prompt at a time per ACP session.
  const turn = s.queue.then(async () => {
    if (job.status !== 'running') return;
    const a = await getAgy();
    if (body.model) await setModel(a, s, body.model);
    job.sessionId = s.sessionId;
    bySessionId.set(s.sessionId, job);
    const timeoutMs = Math.max(10, Number(body.timeoutSec) || 900) * 1000;
    job.timer = setTimeout(() => cancel(job, 'timed out'), timeoutMs);
    const r = await a.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: body.task }] });
    job.stopReason = r?.stopReason ?? null;
    job.usage = r?.usage ?? null;
    finish(job, r?.stopReason === 'cancelled' ? 'cancelled' : 'done');
  });
  s.queue = turn.catch(() => {});
  await turn;
}

function cancel(job, why) {
  if (job.status !== 'running') return;
  job.error = why;
  if (agy && job.sessionId) agy.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: job.sessionId } });
  // If agy does not wind the turn down promptly, give up on it.
  setTimeout(() => finish(job, 'cancelled', why), 15000).unref();
}

// ---------------------------------------------------------------- HTTP
function reply(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  lastUse = Date.now();
  try {
    if (req.headers['x-bridge-token'] !== TOKEN) return reply(res, 401, { error: 'bad token' });
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(res, 200, { ok: true, pid: process.pid, agyRunning: !!agy, sessions: sessions.size, jobs: jobs.size });
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = await readBody(req);
      if (!body.task || !body.cwd) return reply(res, 400, { error: 'task and cwd are required' });
      return reply(res, 200, { jobId: createJob(body).id });
    }
    if (parts[0] === 'jobs' && parts[1]) {
      const job = jobs.get(parts[1]);
      if (!job) return reply(res, 404, { error: 'no such job' });
      if (req.method === 'POST' && parts[2] === 'cancel') {
        cancel(job, 'cancelled by caller');
        return reply(res, 200, snapshot(job));
      }
      if (req.method === 'GET') {
        const wait = Math.min(Number(url.searchParams.get('wait')) || 0, 55000);
        if (job.status === 'running' && wait > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, wait);
            job.waiters.push(() => { clearTimeout(t); resolve(); });
          });
        }
        lastUse = Date.now();
        return reply(res, 200, snapshot(job));
      }
    }
    reply(res, 404, { error: 'not found' });
  } catch (err) {
    reply(res, 500, { error: err.message });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 0;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use; another bridge is serving`);
    process.exit(3);
  }
  log('server error', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${PORT}`);
  // Warm up: start agy and open the default session now, so the first call is fast.
  getAgy()
    .then(() => (WARM_CWD ? getSession(WARM_CWD, 'default', false) : null))
    .then(() => log('warm'))
    .catch((err) => log('warm-up failed:', err.message));
});

setInterval(() => {
  const busy = [...jobs.values()].some((j) => j.status === 'running');
  if (!busy && Date.now() - lastUse > IDLE_EXIT_MS) {
    log('idle, exiting');
    process.exit(0);
  }
}, 60000).unref();

const shutdown = () => { try { agy?.child.kill(); } catch {} process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', () => {}); // stdin is closed by the host; that's fine.
