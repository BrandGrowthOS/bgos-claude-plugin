/**
 * The rig's stand-in for the `claude` CLI, compiled with `bun build --compile`
 * to a claude.exe that only the rig's PATH can find. It does what the daemon
 * and hoai need from Claude Code, and nothing a model does:
 *
 *   - a session launch (`--dangerously-load-development-channels <spec>`, then
 *     `--resume <id>` or `--session-id <id>`): resolves the plugin the way the
 *     CLI does (plugin:hoai@<mkt> through <config>/plugins/installed_plugins.json,
 *     server:<name> through the folder's .mcp.json), starts its `bgos` MCP
 *     server from the manifest with stdio pipes, speaks MCP to it (initialize,
 *     initialized, tools/list), and keeps the session's transcript at
 *     <config>/projects/<munged cwd>/<id>.jsonl, appending on --resume;
 *   - the plugin's own hooks from hooks/hooks.json, run as the CLI runs them
 *     (the payload on stdin), so the daemon sees turns and tools by the real path;
 *   - the dev channels gate: prints the line the gate helper waits for;
 *   - every other call (`plugin marketplace update`, `--version`, the
 *     --append-system-prompt-file probe): recorded, answered, exit.
 *
 * The rig drives it through files: each JSON file dropped in <cwd>/.rig/cmd/
 * is one step ({op: 'prompt' | 'stop' | 'tool' | 'call'}), done in name order,
 * then deleted; its outcome goes to <cwd>/.rig/results.jsonl. Every launch is
 * a line of <cwd>/.rig/launches.jsonl and every channel event a line of
 * <cwd>/.rig/inbound.jsonl.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const cwd = process.cwd()
const home = process.env.USERPROFILE || process.env.HOME || ''
const configDir = (process.env.CLAUDE_CONFIG_DIR ?? '').trim() || join(home, '.claude')
const rigDir = (process.env.HOAI_RIG_DIR ?? '').trim()
const now = () => new Date().toISOString()

function appendJson(path: string, value: unknown): void {
  try {
    appendFileSync(path, `${JSON.stringify(value)}\n`)
  } catch {
    // The rig reads what landed; a lost line shows as a missing outcome.
  }
}

if (rigDir) appendJson(join(rigDir, 'stand-in-calls.jsonl'), { at: now(), pid: process.pid, cwd, argv })

function valueOf(name: string): string | null {
  const at = argv.indexOf(name)
  if (at < 0) return null
  const value = argv[at + 1]
  return value !== undefined && !value.startsWith('--') ? value : null
}

// -- Calls that are not a session ----------------------------------------------------------------

if (argv.includes('--version') || argv.includes('-v')) {
  console.log('2.1.999 (Claude Code, rig stand-in)')
  process.exit(0)
}
if (argv.includes('--append-system-prompt-file') && valueOf('--append-system-prompt-file') === null) {
  // hoai's probe (lib/claude-binary.mjs): this text means the flag is supported.
  console.error("error: option '--append-system-prompt-file <file>' argument missing")
  process.exit(1)
}
const spec = valueOf('--dangerously-load-development-channels')
if (!spec) {
  if (argv[0] === 'plugin' && argv[1] === 'list') console.log('[]')
  process.exit(0)
}

// -- A session -----------------------------------------------------------------------------------

const rigLocal = join(cwd, '.rig')
const cmdDir = join(rigLocal, 'cmd')
mkdirSync(cmdDir, { recursive: true })
const resumeId = valueOf('--resume')
const sessionId = resumeId ?? valueOf('--session-id') ?? randomUUID()
const transcriptDir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`)
mkdirSync(transcriptDir, { recursive: true })
const resumedLines = resumeId && existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).length : 0
let parentUuid: string | null = null

function transcript(type: 'user' | 'assistant', content: unknown): void {
  const uuid = randomUUID()
  appendJson(transcriptPath, { type, message: { role: type, content }, uuid, parentUuid, sessionId, cwd, timestamp: now() })
  parentUuid = uuid
}

type PluginServer = { command: string; args?: string[]; env?: Record<string, string> }
function resolvePlugin(): { root: string | null; server: PluginServer | null; version: string | null } {
  if (spec!.startsWith('plugin:')) {
    const id = spec!.slice('plugin:'.length)
    const doc = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    const raw = doc?.plugins?.[id]
    const entry = Array.isArray(raw) ? (raw.find((e: { scope?: string }) => e?.scope === 'user') ?? raw[0]) : raw
    const root = String(entry?.installPath ?? '')
    const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
    return { root, server: manifest?.mcpServers?.bgos ?? null, version: manifest?.version ?? null }
  }
  if (spec!.startsWith('server:')) {
    const name = spec!.slice('server:'.length)
    const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))
    return { root: null, server: mcp?.mcpServers?.[name] ?? null, version: null }
  }
  return { root: null, server: null, version: null }
}

let plugin: ReturnType<typeof resolvePlugin>
try {
  plugin = resolvePlugin()
} catch (err) {
  plugin = { root: null, server: null, version: null }
  appendJson(join(rigLocal, 'launches.jsonl'), { at: now(), pid: process.pid, error: `plugin unresolved: ${String(err)}` })
}
const sub = (text: string) => text.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.root ?? '')

appendJson(join(rigLocal, 'launches.jsonl'), {
  at: now(),
  pid: process.pid,
  mode: resumeId ? 'resume' : 'session-id',
  sessionId,
  resumedLines,
  spec,
  pluginRoot: plugin.root,
  pluginVersion: plugin.version,
  identityFlag: valueOf('--append-system-prompt-file') !== null,
})
transcript('assistant', [{ type: 'text', text: resumeId ? `rig: resumed with ${resumedLines} earlier lines` : 'rig: new session' }])

// The dev channels gate: the helper (bin/win32-accept-dev-channels.ps1) waits for this line on screen.
console.log('Loading development channels: plugin channel servers will start. Press Enter to continue.')
// The live footer hoai's macOS and Linux expect gate (lib/gate-block.tcl) reads as a session that is up.
console.log('  bypass permissions on (shift+tab to cycle)')
process.stdin.on('data', (chunk) => {
  if (String(chunk).includes('\r') || String(chunk).includes('\n')) appendJson(join(rigLocal, 'gate.jsonl'), { at: now(), pid: process.pid, enter: true })
})
process.stdin.on('error', () => {})

// -- Hooks, as the CLI runs them -----------------------------------------------------------------

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string; args?: string[]; timeout?: number; async?: boolean }> }
let hooks: Record<string, HookEntry[]> = {}
try {
  if (plugin.root) hooks = JSON.parse(readFileSync(join(plugin.root, 'hooks', 'hooks.json'), 'utf8'))?.hooks ?? {}
} catch {
  hooks = {}
}

const pluginEnv = () => ({ ...process.env, CLAUDE_PLUGIN_ROOT: plugin.root ?? '', CLAUDE_PROJECT_DIR: cwd })

async function runHooks(event: string, extra: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd, permission_mode: 'bypassPermissions', hook_event_name: event, ...extra })
  const toolName = typeof extra.tool_name === 'string' ? extra.tool_name : ''
  const waits: Promise<void>[] = []
  let ran = 0
  for (const entry of hooks[event] ?? []) {
    if (entry.matcher && toolName && !new RegExp(entry.matcher).test(toolName)) continue
    if (entry.matcher && !toolName) continue
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== 'command' || !hook.command) continue
      ran++
      const child = spawn(sub(hook.command), (hook.args ?? []).map(sub), { cwd, env: pluginEnv(), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      child.on('error', () => {})
      child.stdin.on('error', () => {})
      child.stdin.end(payload)
      if (!hook.async) {
        waits.push(
          new Promise((resolve) => {
            const timer = setTimeout(resolve, (hook.timeout ?? 60) * 1000)
            child.on('exit', () => {
              clearTimeout(timer)
              resolve()
            })
          }),
        )
      }
    }
  }
  await Promise.all(waits)
  return ran
}

// -- The channel server (MCP over stdio) ---------------------------------------------------------

let mcp: ChildProcessWithoutNullStreams | null = null
let nextId = 1
const pending = new Map<number, (msg: Record<string, unknown>) => void>()

function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    mcp?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function startServer(): void {
  if (!plugin.server) return
  const server = plugin.server
  const env: Record<string, string> = { ...(pluginEnv() as Record<string, string>), CLAUDE_CODE_SESSION_ID: sessionId }
  for (const [key, value] of Object.entries(server.env ?? {})) env[key] = sub(String(value))
  const child = spawn(sub(server.command), (server.args ?? []).map(sub), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  mcp = child
  appendJson(join(rigLocal, 'launches.jsonl'), { at: now(), pid: process.pid, mcpPid: child.pid, command: server.command })
  child.stderr.on('data', (chunk) => {
    try {
      appendFileSync(join(rigLocal, 'mcp-stderr.log'), chunk)
    } catch {}
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof msg.id === 'number' && pending.has(msg.id) && !('method' in msg)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
        continue
      }
      if (msg.method === 'notifications/claude/channel') {
        const params = (msg.params ?? {}) as { content?: unknown; meta?: Record<string, unknown> }
        appendJson(join(rigLocal, 'inbound.jsonl'), { at: now(), pid: process.pid, meta: params.meta ?? null, content: String(params.content ?? '').slice(0, 500) })
        transcript('user', `<channel source="bgos">${String(params.content ?? '')}</channel>`)
        continue
      }
      if (typeof msg.id === 'number' && typeof msg.method === 'string') {
        // A request from the server: none is expected; answer empty so it never hangs.
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
      }
    }
  })
  child.stdin.on('error', () => {})
  child.on('exit', (code, signal) => {
    appendJson(join(rigLocal, 'launches.jsonl'), { at: now(), pid: process.pid, mcpExit: code, signal })
    mcp = null
  })
  void (async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { experimental: { 'claude/channel': {} } }, clientInfo: { name: 'claude-code', version: '2.1.999-rig' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await rpc('tools/list', {})
    const tools = ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name)
    appendJson(join(rigLocal, 'launches.jsonl'), { at: now(), pid: process.pid, mcpInitialized: Boolean(init.result), tools: tools.length })
  })()
}

// -- The rig's steps -----------------------------------------------------------------------------

type Step = {
  op: 'prompt' | 'stop' | 'tool' | 'call' | 'goal'
  text?: string
  name?: string
  phase?: 'pre' | 'post'
  tool?: string
  arguments?: Record<string, unknown>
  condition?: string
  met?: boolean
  /** What the Stop tells its hooks is scheduled: Claude Code's own `session_crons`. */
  sessionCrons?: unknown[]
}
let busy = false
async function runStep(file: string, step: Step): Promise<unknown> {
  if (step.op === 'prompt') {
    transcript('user', String(step.text ?? 'rig prompt'))
    return { hooks: await runHooks('UserPromptSubmit', { prompt: String(step.text ?? 'rig prompt') }) }
  }
  if (step.op === 'stop') {
    transcript('assistant', [{ type: 'text', text: 'rig: turn done' }])
    return { hooks: await runHooks('Stop', { stop_hook_active: false, ...(step.sessionCrons ? { session_crons: step.sessionCrons } : {}) }) }
  }
  if (step.op === 'tool') {
    const toolUseId = `toolu_rig_${file}`
    const event = step.phase === 'post' ? 'PostToolUse' : 'PreToolUse'
    return { hooks: await runHooks(event, { tool_name: step.name, tool_input: {}, tool_use_id: toolUseId, ...(step.phase === 'post' ? { tool_response: {} } : {}) }) }
  }
  if (step.op === 'goal') {
    // The goal Stop hook's own transcript row: a set sentinel arms the goal, a met one clears it.
    const uuid = randomUUID()
    const attachment = { type: 'goal_status', condition: String(step.condition ?? 'rig goal'), sentinel: true, met: step.met === true }
    appendJson(transcriptPath, { type: 'attachment', attachment, uuid, parentUuid, sessionId, cwd, timestamp: now() })
    parentUuid = uuid
    return { goal: attachment }
  }
  if (step.op === 'call') {
    if (!mcp) return { error: 'no server' }
    const toolUseId = `toolu_rig_${file}`
    transcript('assistant', [{ type: 'tool_use', id: toolUseId, name: `mcp__plugin_hoai_bgos__${step.tool}`, input: step.arguments ?? {} }])
    const res = await rpc('tools/call', { name: step.tool, arguments: step.arguments ?? {} })
    const content = (res.result as { content?: Array<{ text?: string }> })?.content ?? []
    const text = content.map((c) => c.text ?? '').join('\n')
    transcript('user', [{ type: 'tool_result', tool_use_id: toolUseId, content: text }])
    return { result: text.slice(0, 500), error: res.error ?? null }
  }
  return { error: `unknown op ${String((step as { op?: unknown }).op)}` }
}

setInterval(async () => {
  if (busy) return
  busy = true
  try {
    for (const name of readdirSync(cmdDir).filter((n) => n.endsWith('.json')).sort()) {
      const path = join(cmdDir, name)
      let step: Step
      try {
        step = JSON.parse(readFileSync(path, 'utf8'))
        unlinkSync(path)
      } catch {
        continue
      }
      const outcome = await runStep(name, step)
      appendJson(join(rigLocal, 'results.jsonl'), { at: now(), pid: process.pid, file: name, step, outcome })
    }
  } catch {
    // The folder can vanish at teardown.
  } finally {
    busy = false
  }
}, 500)

startServer()
void runHooks('SessionStart', { source: resumeId ? 'resume' : 'startup' })
