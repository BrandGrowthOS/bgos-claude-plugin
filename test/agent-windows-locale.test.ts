/**
 * lib/agent-windows.mjs on a Mac whose watcher runs from launchd with no UTF-8 locale (board row
 * c502fb7b, found by the 5.28.1 live run of "Show or hide each agent's window").
 *
 * A tmux client with no UTF-8 locale prints every character of a -F answer outside printable ASCII
 * as `_`, a tab included: tmux 3.6a answered `hoai-912_1794619730` for
 * `#{session_name}<tab>#{session_created}`, so the windows pass found no agent session and never
 * opened a window, though the app's switch was on. The fake tmux here renders the -F format it is
 * given, the way tmux does, and rewrites what tmux rewrites:
 *
 *   - `always`: as tmux does with no UTF-8 locale, whatever environment it is given (the worst
 *     case: the pass must read it by its separator alone);
 *   - `locale`: only when the environment it is given has no UTF-8 locale (LC_ALL, else LC_CTYPE,
 *     else LANG), as the real tmux does.
 *
 * Only runWindowsPass is imported, so this file runs unchanged against the code before the fix
 * (which fails it). Run: npx tsx --test test/agent-windows-locale.test.ts
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { emptyViewerMemory } from '../lib/agent-windows-plan.mjs'
import { POSIX_VIEWER_FILE_NAME, runWindowsPass } from '../lib/agent-windows.mjs'
import { nodeExec } from '../lib/watcher-bundle.mjs'
import { PANE_STATE_FORMAT } from '../lib/compact-inject.ts'
import { parsePaneState } from '../lib/model-effort-pane.ts'
import { memoryFs } from './helpers/memory-fs.ts'

const T0 = Date.parse('2026-11-11T12:00:00.000Z')
const PHOME = '/Users/person'
const TMUX = '/opt/homebrew/bin/tmux'

type Session = { name: string; created: number }
type Client = { name: string; pid: number; readonly: 0 | 1; session: string }
type Server = { sessions: Session[]; clients: Client[] }

/** The locale a tmux client goes by: LC_ALL, else LC_CTYPE, else LANG, the first one set. */
function utf8(env: Record<string, string | undefined> | undefined): boolean {
  const value = [env?.LC_ALL, env?.LC_CTYPE, env?.LANG].find((v) => typeof v === 'string' && v !== '') ?? ''
  return /utf-?8/i.test(value)
}

/** What tmux with no UTF-8 locale prints: printable ASCII as it is, any other character as `_`. */
function sanitize(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.codePointAt(0)!
    return code > 0x1f && code < 0x7f ? ch : '_'
  }).join('')
}

function render(format: string, vars: Record<string, string | number>): string {
  return format.replace(/#\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''))
}

/** A fake tmux that answers list-sessions and list-clients from its -F format, per socket ('' = the default server). */
function renderingTmux(servers: Record<string, Server>, rewrite: 'always' | 'locale') {
  const execs: Array<{ file: string; args: string[]; env: Record<string, string | undefined> | undefined }> = []
  const spawns: Array<{ file: string; args: string[]; opts: any }> = []
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', error: null, timedOut: false })
  const exec = async (file: string, args: readonly string[], opts: { env?: Record<string, string | undefined> } = {}) => {
    execs.push({ file, args: [...args], env: opts.env })
    if (file !== TMUX) return ok('')
    const list = [...args]
    let socket = ''
    if (list[0] === '-L') {
      socket = list[1]!
      list.splice(0, 2)
    }
    const server = servers[socket]
    if (!server) return { code: 1, stdout: '', stderr: `no server running on /tmp/tmux-501/${socket || 'default'}`, error: null, timedOut: false }
    const format = list[list.indexOf('-F') + 1] ?? ''
    let lines: string[] = []
    if (list[0] === 'list-sessions') lines = server.sessions.map((s) => render(format, { session_name: s.name, session_created: s.created }))
    else if (list[0] === 'list-clients') {
      lines = server.clients.map((c) => render(format, { client_name: c.name, client_pid: c.pid, client_readonly: c.readonly, session_name: c.session }))
    } else return ok('')
    const rewritten = rewrite === 'always' || !utf8(opts.env) ? lines.map(sanitize) : lines
    return ok(rewritten.map((line) => `${line}\n`).join(''))
  }
  return {
    execs,
    spawns,
    exec,
    spawnDetached: (file: string, args: readonly string[], opts: any) => {
      spawns.push({ file, args: [...args], opts })
      return { pid: 7777 }
    },
  }
}

function row(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return { assistantId: id, cwd, stateDir: `${PHOME}/.bgos-agent/${id}`, launcherLive: true, supervisor: 'service', keepalive: null, ...extra }
}

/** A launchd job's environment: PATH, HOME and no locale at all. */
const LAUNCHD_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: PHOME }

function ctx(platform: string, fx: ReturnType<typeof renderingTmux>, fs: any, rows: any[], show: boolean, env: Record<string, string>, memory = emptyViewerMemory()) {
  return { platform, home: PHOME, env, fs, exec: fx.exec, spawnDetached: fx.spawnDetached, kill: () => {}, now: () => T0, log: () => {}, listAgents: () => rows, tmuxPath: TMUX, show, memory }
}

const opens = (fx: ReturnType<typeof renderingTmux>) => fx.execs.filter((c) => c.file === 'open').map((c) => c.args)

test('darwin, no locale: a tmux that prints a tab in a format as _ (3.6a under launchd) still lets the pass find each agent session and open its Terminal', async () => {
  const fs = memoryFs()
  const rows = [row('912', '/Users/person/hoai-agents/Wolf'), row('55', '/Users/person/hoai-agents/Nova', { supervisor: 'launcher-live' })]
  const fx = renderingTmux(
    {
      'hoai-912': { sessions: [{ name: 'hoai-912', created: 1794619730 }], clients: [] },
      '': { sessions: [{ name: 'hoai-55', created: 1794619000 }, { name: 'scratch', created: 10 }], clients: [] },
    },
    'always',
  )
  const out = await runWindowsPass(ctx('darwin', fx, fs, rows, true, LAUNCHD_ENV) as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' })
  assert.deepEqual(opens(fx), [
    ['-g', '-a', 'Terminal', `${PHOME}/.bgos-agent/55/${POSIX_VIEWER_FILE_NAME}`],
    ['-g', '-a', 'Terminal', `${PHOME}/.bgos-agent/912/${POSIX_VIEWER_FILE_NAME}`],
  ])
  assert.match(fs.files.get(`${PHOME}/.bgos-agent/912/${POSIX_VIEWER_FILE_NAME}`)!, /\nexec '\/opt\/homebrew\/bin\/tmux' -L 'hoai-912' attach-session -r -t '=hoai-912'\n$/)
  // The agent session started at 1794619730 s: the pass read the time too, not only the name.
  assert.deepEqual(Object.values(out.memory.opened ?? {}).sort(), ['default:hoai-55:1794619000', 'hoai-912:hoai-912:1794619730'])
})

test('darwin, no locale: switched off, the read only viewer is detached and a person\'s read-write attach is left alone, though tmux printed every tab as _', async () => {
  const fs = memoryFs()
  const rows = [row('912', '/Users/person/hoai-agents/Wolf')]
  const fx = renderingTmux(
    {
      'hoai-912': {
        sessions: [{ name: 'hoai-912', created: 1794619730 }],
        clients: [
          { name: '/dev/ttys003', pid: 3003, readonly: 1, session: 'hoai-912' },
          { name: '/dev/ttys004', pid: 3004, readonly: 0, session: 'hoai-912' },
        ],
      },
    },
    'always',
  )
  const out = await runWindowsPass(ctx('darwin', fx, fs, rows, false, LAUNCHD_ENV, { ...emptyViewerMemory(), lastShow: true, scanned: true }) as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'setting_off' })
  assert.deepEqual(fx.execs.filter((c) => c.args.includes('detach-client')).map((c) => c.args), [['-L', 'hoai-912', 'detach-client', '-t', '/dev/ttys003']])
})

test('darwin: every tmux the pass asks gets a UTF-8 LC_ALL when the watcher has none (launchd) or a non UTF-8 one (LC_ALL=C), so a session name outside ASCII is read as it is', async () => {
  for (const env of [LAUNCHD_ENV, { ...LAUNCHD_ENV, LC_ALL: 'C', LANG: 'en_US.UTF-8' }, { ...LAUNCHD_ENV, LANG: 'C' }]) {
    const fs = memoryFs()
    // A keep-alive agent in the owner's own tmux session, named by the owner.
    const rows = [row('77', '/Users/person/hoai-agents/Cafe', { supervisor: 'keepalive', keepalive: { tmuxSession: 'café-agent' } })]
    const fx = renderingTmux({ '': { sessions: [{ name: 'café-agent', created: 1794619100 }], clients: [] } }, 'locale')
    const out = await runWindowsPass(ctx('darwin', fx, fs, rows, true, env) as any)
    assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' }, JSON.stringify(env))
    assert.deepEqual(opens(fx), [['-g', '-a', 'Terminal', `${PHOME}/.bgos-agent/77/${POSIX_VIEWER_FILE_NAME}`]], JSON.stringify(env))
    const asked = fx.execs.filter((c) => c.file === TMUX)
    assert.ok(asked.length > 0)
    for (const call of asked) {
      assert.equal(call.env?.LC_ALL, 'en_US.UTF-8', `${call.args.join(' ')} under ${JSON.stringify(env)}`)
      assert.equal(call.env?.PATH, env.PATH, 'the rest of the environment is kept')
    }
  }
})

test('linux: an environment that already has a UTF-8 locale reaches tmux as it is (only TMUX and TMUX_PANE dropped, no LC_ALL added), and the terminal runs the same read only attach', async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/home/person', LANG: 'en_US.UTF-8', DISPLAY: ':0', TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%1' }
  const rows = [row('912', '/home/person/hoai-agents/Wolf', { stateDir: '/home/person/.bgos-agent/912' })]
  const fx = renderingTmux({ 'hoai-912': { sessions: [{ name: 'hoai-912', created: 1794619730 }], clients: [] } }, 'locale')
  const out = await runWindowsPass({ ...ctx('linux', fx, memoryFs(), rows, true, env), home: '/home/person', hasCommand: (n: string) => n === 'gnome-terminal' } as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' })
  const { TMUX: _t, TMUX_PANE: _p, ...expected } = env
  for (const call of fx.execs.filter((c) => c.file === TMUX)) assert.deepEqual(call.env, expected, call.args.join(' '))
  assert.deepEqual(fx.spawns.map((s) => [s.file, ...s.args]), [['gnome-terminal', '--', TMUX, '-L', 'hoai-912', 'attach-session', '-r', '-t', '=hoai-912']])
  assert.deepEqual(fx.spawns[0]!.opts.env, expected, 'the terminal gets the environment it got before')
})

test('linux, no locale: the tmux the pass asks gets LC_ALL=C.UTF-8, and the pass opens the window', async () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/home/person', DISPLAY: ':0' }
  const rows = [row('912', '/home/person/hoai-agents/Wolf', { stateDir: '/home/person/.bgos-agent/912' })]
  const fx = renderingTmux({ 'hoai-912': { sessions: [{ name: 'hoai-912', created: 1794619730 }], clients: [] } }, 'always')
  const out = await runWindowsPass({ ...ctx('linux', fx, memoryFs(), rows, true, env), home: '/home/person', hasCommand: (n: string) => n === 'gnome-terminal' } as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' })
  assert.equal(fx.spawns.length, 1)
  for (const call of fx.execs.filter((c) => c.file === TMUX)) assert.equal(call.env?.LC_ALL, 'C.UTF-8')
  assert.equal(fx.spawns[0]!.opts.env.LC_ALL, undefined, 'the terminal environment is unchanged')
})

// -- a real tmux ---------------------------------------------------------------------------------
// HOAI_TEST_TMUX names another tmux binary (the 3.6a of board row c502fb7b, say); the tmux on PATH
// otherwise. Skipped where there is none (Windows). Only a private server on its own socket is
// started, and it is killed at the end.

const REAL_TMUX = process.env.HOAI_TEST_TMUX || 'tmux'
const realTmux = process.platform !== 'win32' && spawnSync(REAL_TMUX, ['-V']).status === 0
const NO_LOCALE = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }
const realSockets: string[] = []

after(() => {
  for (const socket of realSockets) spawnSync(REAL_TMUX, ['-L', socket, 'kill-server'], { env: NO_LOCALE })
})

function realServer(): { id: string; socket: string } {
  const id = String(900_000_000 + Math.floor(Math.random() * 99_999_999))
  const socket = `hoai-${id}`
  realSockets.push(socket)
  const run = spawnSync(REAL_TMUX, ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', socket, '-x', '80', '-y', '24', 'sleep 120'], { env: NO_LOCALE })
  assert.equal(run.status, 0, String(run.stderr))
  return { id, socket }
}

test('real tmux, a watcher environment with no locale: the pass finds the agent session on its own socket and opens its Terminal', { skip: !realTmux && 'no tmux here' }, async () => {
  const { id, socket } = realServer()
  const fs = memoryFs()
  const realExec = nodeExec()
  const opened: string[][] = []
  const exec = async (file: string, args: readonly string[], opts: any) => {
    if (file === 'open') {
      opened.push([...args])
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    }
    // Only this test's own server: any other socket (or the default server) reads as no server.
    if (file === REAL_TMUX && !(args[0] === '-L' && args[1] === socket)) return { code: 1, stdout: '', stderr: 'no server running', error: null, timedOut: false }
    return realExec(file, args, opts)
  }
  const rows = [row(id, `/Users/person/hoai-agents/Real${id}`)]
  const out = await runWindowsPass({ platform: 'darwin', home: PHOME, env: NO_LOCALE, fs, exec, spawnDetached: () => ({ pid: null }), kill: () => {}, now: () => T0, log: () => {}, listAgents: () => rows, tmuxPath: REAL_TMUX, show: true, memory: emptyViewerMemory() } as any)
  assert.deepEqual(out.report, { mode: 'tmux', reason: 'showing' })
  assert.deepEqual(opened, [['-g', '-a', 'Terminal', `${PHOME}/.bgos-agent/${id}/${POSIX_VIEWER_FILE_NAME}`]])
  assert.match(fs.files.get(`${PHOME}/.bgos-agent/${id}/${POSIX_VIEWER_FILE_NAME}`)!, new RegExp(` -L '${socket}' attach-session -r -t '=${socket}'\\n$`))
})

test('real tmux, no locale at all: display -p of the pane state format parses (the daemon gives tmux no locale of its own)', { skip: !realTmux && 'no tmux here' }, () => {
  const { socket } = realServer()
  const run = spawnSync(REAL_TMUX, ['-L', socket, 'display-message', '-p', '-t', `=${socket}:`, PANE_STATE_FORMAT], { env: NO_LOCALE, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const pane = parsePaneState(run.stdout)
  assert.ok(pane, `parsed ${JSON.stringify(run.stdout)}`)
  assert.match(pane!.paneId, /^%\d+$/)
  assert.match(pane!.tty, /^\/dev\//)
  assert.equal(pane!.dead, false)
  assert.ok(pane!.cursor, 'the cursor fields too')
})
