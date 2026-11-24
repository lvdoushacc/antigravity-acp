import type { EngineInterface, Register } from 'claude-code'

// The bridge (bridge/acp-bridge.mjs) keeps one `agy acp` process warm and
// serves it on this port; this module starts it, then talks to it over HTTP.
const PORT = 47821
const BASE = `http://127.0.0.1:${PORT}`
const TOOL = 'ask'
const FULL = 'mcp__antigravity-acp__ask'
const COMMAND = 'agy'
const MODEL_COMMAND = 'agym'

type Job = {
  id: string
  status: 'running' | 'done' | 'cancelled' | 'error'
  session: string
  sessionId: string | null
  text: string
  toolCalls: { title?: string; kind?: string; status?: string }[]
  permissions: { title: string; decision: string }[]
  plan: { content: string; status: string }[]
  stopReason: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
}

type AskInput = {
  task?: string
  session?: string
  fresh?: boolean
  cwd?: string
  model?: string
  readOnly?: boolean
  timeoutSec?: number
}

const DESCRIPTION = `Hand a task to Antigravity (Google's agy agent, Gemini models) and get its answer back. It runs as an independent coding agent in the given folder: it can read and edit files and run commands there, then reports back.

Antigravity cannot see this conversation: put everything it needs in "task" (goal, files, constraints, what to report). Calls with the same "session" name continue the same Antigravity conversation, so follow-ups can be short; set "fresh": true to start that session over. Use "readOnly": true when it should only look, not change anything. Typical turn takes seconds to a few minutes.`

const SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Complete, self-contained instructions for Antigravity.' },
    session: { type: 'string', description: 'Conversation name to continue (default "default").' },
    fresh: { type: 'boolean', description: 'Start this session over instead of continuing it.' },
    cwd: { type: 'string', description: "Absolute working folder for Antigravity (default: this session's folder)." },
    model: { type: 'string', description: 'Optional agy model id, e.g. gemini-4-neon-high.' },
    readOnly: { type: 'boolean', description: 'Refuse every edit/command permission Antigravity asks for.' },
    timeoutSec: { type: 'number', description: 'Give up after this many seconds (default 900).' },
  },
  required: ['task'],
}

let cwd = ''
let token = ''
let bridgeDir = ''

/** Starts the shared bridge detached when it is not running (`agy-client.mjs --ensure`). */
async function ensureBridge($: EngineInterface): Promise<string | null> {
  if (!bridgeDir) return 'plugin folder unknown'
  try {
    const r = await $.process.run(['node', `${bridgeDir}/agy-client.mjs`, '--ensure', '--cwd', cwd], {
      env: { AGY_ACP_PORT: String(PORT) },
      timeoutMs: 20000,
    })
    if (r.exitCode === 0) return null
    $.ui.log(`antigravity: bridge did not start: ${r.stderr}`, { to: 'debug' })
    return r.stderr.trim() || `exit ${r.exitCode}`
  } catch (err) {
    $.ui.log(`antigravity: bridge did not start: ${String(err)}`, { to: 'debug' })
    return String(err)
  }
}

function headers() {
  return { 'content-type': 'application/json', 'x-bridge-token': token }
}

/** 'ok', 'denied' (a bridge with another token holds the port), or 'down'. */
async function bridgeState($: EngineInterface): Promise<'ok' | 'denied' | 'down'> {
  try {
    const r = await $.http.fetch(`${BASE}/health`, { headers: headers() })
    return r.ok ? 'ok' : r.status === 401 ? 'denied' : 'down'
  } catch {
    return 'down'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd

    const env = await $.process.hookEnv()
    bridgeDir = `${env.CLAUDE_PLUGIN_ROOT}/bridge`

    // One token per user (~/.agy-acp/token), shared by every session and
    // the CLI, so whichever client started the bridge, the others can use it.
    const got = await $.process.run(['node', `${bridgeDir}/token.mjs`])
    token = got.stdout.trim()
    if (got.exitCode !== 0 || !token) $.ui.log(`antigravity: could not read token: ${got.stderr}`, { to: 'debug' })

    await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    await $.command.register({
      name: COMMAND,
      description: 'Send a task straight to Antigravity (--new starts over, -m switches model, models lists them)',
      argumentHint: '[--new] [-m model] <task> | models',
    })
    await $.command.register({
      name: MODEL_COMMAND,
      description: 'Pick the Antigravity model (click to choose; ls lists, a number switches)',
      argumentHint: '[ls | number]',
    })

    // The bridge belongs to no session: start it detached if it is not
    // running (it warms up while the session opens), and let every session
    // and the CLI share it. It exits after 2 h idle.
    void ensureBridge($)

    return started
  })

  on('tool.run', { tool: FULL }, async ($, e, next) => {
    const input = e as unknown as AskInput
    if (!input.task?.trim()) return { deny: 'task is required' }
    const r = await runJob($, input, next.signal)
    return 'error' in r ? { deny: r.error } : { result: format(r.job) }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'Antigravity bridge call failed; see `claude --debug` for details.' },
  )

  // Quick path: `/agy <task>` goes straight to Antigravity, no Claude turn in
  // between. The reply is shown, and stays in the transcript so Claude can
  // see it afterwards. Options (before the task):
  //   --new             start the conversation over
  //   -m / --model X    use model X (loose names like carbon-high work) and
  //                     remember it; alone, just switch
  //   models            list the models, the current one marked
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const a = parseArgs(e.args)
    if (a.list) return { text: await listModels($), isTextDisplayOnly: true }
    if (a.model) {
      const switched = await switchModel($, a.model)
      if (!a.task || switched.startsWith('Antigravity:')) return { text: switched, isTextDisplayOnly: true }
    }
    if (!a.task) return { text: USAGE, isTextDisplayOnly: true }
    const r = await runJob($, { task: a.task, fresh: a.fresh, session: 'default' }, next.signal)
    return { text: 'error' in r ? `Antigravity: ${r.error}` : format(r.job) }
  }).catch(() => ({ text: 'Antigravity 调用失败，详情见 `claude --debug`。' }))

  // `/agym` lists the models numbered; `/agym 3` switches to number 3.
  on('command.run', { command: MODEL_COMMAND }, async ($, e) => ({
    text: await pickModel($, e.args.trim()),
    isTextDisplayOnly: true,
  })).catch(() => ({ text: '换模型失败，详情见 `claude --debug`。' }))
}

const USAGE = [
  `用法：/${COMMAND} 任务内容`,
  `  /${COMMAND} --new 任务内容          开新对话`,
  `  /${COMMAND} -m carbon-high 任务内容  换模型并执行（之后一直用这个模型）`,
  `  /${COMMAND} -m neon-high             只换模型`,
  `  /${MODEL_COMMAND}                       点选换模型`,
  `  /${MODEL_COMMAND} ls                    列出模型（带编号）`,
  `  /${MODEL_COMMAND} 2                     切换到 2 号模型`,
].join('\n')

type Args = { task: string; fresh: boolean; model?: string; list: boolean }

function parseArgs(raw: string): Args {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  const out: Args = { task: '', fresh: false, list: false }
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]
    if (w === '--new') out.fresh = true
    else if ((w === '-m' || w === '--model') && i + 1 < words.length) out.model = words[++i]
    else if (w === '-m' || w === '--model' || w === '--models') out.list = true
    else break
  }
  const rest = words.slice(i)
  if (rest.length === 1 && rest[0]?.toLowerCase() === 'models' && !out.model && !out.fresh) out.list = true
  else out.task = rest.join(' ')
  return out
}

/** null when the bridge answers, else why it does not. */
async function waitForBridge($: EngineInterface): Promise<string | null> {
  // Down: start it and check again. The start waits inside a `$` call, which
  // does not count against the hook's 10 s budget (a sleep would).
  for (let i = 0; i < 2; i++) {
    const state = await bridgeState($)
    if (state === 'ok') return null
    if (state === 'denied') {
      return `另一个接线员占着端口 ${PORT}，但口令对不上（多半是旧版本留下的）。结束那个 node acp-bridge.mjs 进程，或者重启电脑后再试。`
    }
    if (i === 0) {
      const why = await ensureBridge($)
      if (why) return `接线员启动失败（检查 node 和 agy 是否在 PATH 里）：${why}`
    }
  }
  return '接线员没在运行。详情见 `claude --debug`。'
}

async function switchModel($: EngineInterface, model: string): Promise<string> {
  const down = await waitForBridge($)
  if (down) return `Antigravity: ${down}`
  const r = await $.http.fetch(`${BASE}/model`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ cwd, session: 'default', model }),
  })
  const body = JSON.parse(r.text) as { current?: string; name?: string; error?: string }
  if (!r.ok || !body.current) return `Antigravity: 换模型失败：${body.error ?? r.text}`
  await $.store.set('model', body.current)
  return `已切换到 ${body.name}（${body.current}），之后的 /${COMMAND} 都用它。`
}

type ModelList = { current: string | null; available: { id: string; name: string }[] }

async function fetchModels($: EngineInterface): Promise<ModelList | string> {
  const down = await waitForBridge($)
  if (down) return `Antigravity: ${down}`
  const r = await $.http.fetch(`${BASE}/models?cwd=${encodeURIComponent(cwd)}&session=default`, { headers: headers() })
  if (!r.ok) return `Antigravity: 读不到模型列表：${r.text}`
  return JSON.parse(r.text) as ModelList
}

/** Numbered, so `/agym 3` can pick one. */
async function listModels($: EngineInterface): Promise<string> {
  const got = await fetchModels($)
  if (typeof got === 'string') return got
  const lines = got.available.map((m, i) => `${m.id === got.current ? '▶' : ' '} ${String(i + 1).padStart(2)}. ${m.name}`)
  return [`Antigravity 模型（▶ 当前）：`, ...lines, '', `切换：/${MODEL_COMMAND} 编号，或只输 /${MODEL_COMMAND} 点选`].join('\n')
}

/** "Gemini 4 Neon (High)" -> family "Gemini 4 Neon", level "High". */
function splitName(name: string): { family: string; level: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name)
  return m ? { family: m[1] ?? name, level: m[2] ?? name } : { family: name, level: name }
}

/**
 * Two clicks in the engine's own choice dialog: the family, then the level.
 * The dialog shows at most 4 choices; anything else can be typed under
 * "Other" (a family, a model id or a loose name).
 */
async function chooseModel($: EngineInterface): Promise<string> {
  const got = await fetchModels($)
  if (typeof got === 'string') return got
  const currentName = got.available.find(m => m.id === got.current)?.name ?? got.current ?? '?'

  const families: { family: string; models: { id: string; level: string }[] }[] = []
  for (const m of got.available) {
    const { family, level } = splitName(m.name)
    let f = families.find(x => x.family === family)
    if (!f) families.push((f = { family, models: [] }))
    f.models.push({ id: m.id, level })
  }

  let answer: string
  try {
    answer = await $.ui.ask(`选哪个系列？（当前：${currentName}）`, {
      header: '模型系列',
      options: families.slice(0, 4).map(f => f.family),
    })
  } catch {
    return '已取消，模型没变。'
  }
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const fam = families.find(f => f.family === answer) ?? families.find(f => squash(f.family).includes(squash(answer)))
  if (!fam) return switchModel($, answer) // typed a model name under "Other"
  if (fam.models.length === 1 && fam.models[0]) return switchModel($, fam.models[0].id)

  let level: string
  try {
    level = await $.ui.ask(`${fam.family} 用哪一档？`, {
      header: '档位',
      options: fam.models.slice(0, 4).map(m => (m.id === got.current ? `${m.level}（当前）` : m.level)),
    })
  } catch {
    return '已取消，模型没变。'
  }
  const pick = fam.models.find(m => level === m.level || level === `${m.level}（当前）`)
    ?? fam.models.find(m => squash(m.level) === squash(level))
  return pick ? switchModel($, pick.id) : switchModel($, level)
}

/** `/agym` opens the picker; `/agym ls` lists; `/agym 3` or `/agym neon-xhigh` switches. */
async function pickModel($: EngineInterface, arg: string): Promise<string> {
  if (!arg) return chooseModel($)
  if (arg === 'ls' || arg === 'list') return listModels($)
  if (/^\d+$/.test(arg)) {
    const got = await fetchModels($)
    if (typeof got === 'string') return got
    const m = got.available[Number(arg) - 1]
    if (!m) return `没有 ${arg} 号模型，输入 /${MODEL_COMMAND} ls 看编号。`
    return switchModel($, m.id)
  }
  return switchModel($, arg)
}

type RunResult = { job: Job } | { error: string }

async function runJob($: EngineInterface, input: AskInput, signal: AbortSignal): Promise<RunResult> {
  const down = await waitForBridge($)
  if (down) return { error: down }

  // No model named: use the one last chosen with /agy -m, so it survives a
  // bridge restart.
  if (!input.model) {
    const saved = await $.store.get('model')
    if (typeof saved === 'string' && saved) input = { ...input, model: saved }
  }

  const created = await $.http.fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...input, cwd: input.cwd || cwd }),
  })
  if (!created.ok) return { error: `bridge refused the job: ${created.text}` }
  const { jobId } = JSON.parse(created.text) as { jobId: string }

  try {
    for (;;) {
      if (signal.aborted) {
        await $.http.fetch(`${BASE}/jobs/${jobId}/cancel`, { method: 'POST', headers: headers() })
        return { error: 'Interrupted; Antigravity was asked to stop.' }
      }
      const r = await $.http.fetch(`${BASE}/jobs/${jobId}?wait=25000`, { headers: headers() })
      if (!r.ok) return { error: `bridge lost the job: ${r.text}` }
      const job = JSON.parse(r.text) as Job
      if (job.status !== 'running') return { job }
      const secs = Math.round((Date.now() - job.startedAt) / 1000)
      $.ui.status(`Antigravity working · ${secs}s · ${job.toolCalls.length} steps`)
    }
  } finally {
    $.ui.status(undefined)
  }
}

function format(job: Job): string {
  const secs = job.endedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : 0
  const out: string[] = []
  out.push(`[Antigravity · session "${job.session}" · ${job.status}${job.stopReason ? ` (${job.stopReason})` : ''} · ${secs}s]`)
  if (job.error) out.push(`Error: ${job.error}`)
  out.push('', job.text.trim() || '(no reply text)')
  if (job.toolCalls.length) {
    out.push('', `Steps it took (${job.toolCalls.length}):`)
    for (const t of job.toolCalls.slice(-40)) out.push(`- [${t.status ?? '?'}] ${t.title ?? t.kind ?? 'tool'}`)
  }
  const refused = job.permissions.filter(p => p.decision !== 'allowed')
  if (refused.length) {
    out.push('', 'Permissions refused (readOnly):')
    for (const p of refused) out.push(`- ${p.title}`)
  }
  return out.join('\n')
}
