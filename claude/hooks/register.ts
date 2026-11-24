import type { EngineInterface, Register } from 'claude-code'

// The bridge (bridge/acp-bridge.mjs) keeps one `agy acp` process warm and
// serves it on this port; this module starts it, then talks to it over HTTP.
const PORT = 47821
const BASE = `http://127.0.0.1:${PORT}`
const TOOL = 'ask'
const FULL = 'mcp__antigravity-acp__ask'
const COMMAND = 'agy'

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

function headers() {
  return { 'content-type': 'application/json', 'x-bridge-token': token }
}

async function healthy($: EngineInterface) {
  try {
    const r = await $.http.fetch(`${BASE}/health`, { headers: headers() })
    return r.ok
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd

    const env = await $.process.hookEnv()
    const bridgeDir = `${env.CLAUDE_PLUGIN_ROOT}/bridge`
    const script = `${bridgeDir}/acp-bridge.mjs`

    // One token per user (~/.agy-acp/token), shared with the Codex hook and
    // the CLI, so whichever client started the bridge, the others can use it.
    const got = await $.process.run(['node', `${bridgeDir}/token.mjs`])
    token = got.stdout.trim()
    if (got.exitCode !== 0 || !token) $.ui.log(`antigravity: could not read token: ${got.stderr}`, { to: 'debug' })

    await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    await $.command.register({
      name: COMMAND,
      description: 'Send a task straight to Antigravity (--new starts over)',
      argumentHint: '[--new] <task>',
    })

    // Supervisor: keep a bridge alive for the session's life. If another
    // session's bridge already holds the port (exit 3), check back later and
    // take over once it is gone.
    void (async () => {
      for (;;) {
        let code: number | null = null
        try {
          const child = $.process.spawn({ argv: ['node', script, '--port', String(PORT), '--cwd', cwd] })
          for await (const { text } of child) $.ui.log(text, { to: 'debug' })
          code = (await child.result).code
        } catch (err) {
          $.ui.log(`antigravity bridge failed: ${String(err)}`, { to: 'debug' })
        }
        try {
          await $.clock.sleep(code === 3 ? 30000 : 3000)
        } catch {
          return
        }
      }
    })()

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
  // between. `/agy --new <task>` starts the conversation over. The reply is
  // shown, and stays in the transcript so Claude can see it afterwards.
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    let task = e.args.trim()
    const fresh = /^--new(\s|$)/.test(task)
    if (fresh) task = task.replace(/^--new\s*/, '')
    if (!task) return { text: `用法：/${COMMAND} 任务内容    （/${COMMAND} --new 任务内容 = 开新对话）`, isTextDisplayOnly: true }
    const r = await runJob($, { task, fresh, session: 'default' }, next.signal)
    return { text: 'error' in r ? `Antigravity: ${r.error}` : format(r.job) }
  }).catch(() => ({ text: 'Antigravity 调用失败，详情见 `claude --debug`。' }))
}

type RunResult = { job: Job } | { error: string }

async function runJob($: EngineInterface, input: AskInput, signal: AbortSignal): Promise<RunResult> {
  // Wait for the bridge (it starts with the session; give it a moment).
  for (let i = 0; !(await healthy($)); i++) {
    if (i >= 20) return { error: 'Antigravity bridge is not running (is `node` and `agy` on PATH?). See `claude --debug` for its log.' }
    await $.clock.sleep(500)
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
