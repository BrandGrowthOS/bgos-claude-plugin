/**
 * The REAL server.ts, booted with an attach scope (board row bab90cdb, design
 * BGOS #1244). What is real: `bun server.ts` from this checkout, a pairing
 * credentials file for agent 42 with its home folder and folder pin, the plugin
 * state dir, and the MCP stdio protocol. What is stood in: the backend (nothing
 * listens on port 9) and the launcher, whose HOAI_ATTACH_SCOPE is set by hand.
 *
 * Four boots:
 *   - scoped to agent 41, mode wrong-agent: REFUSED, the one notice tool, the
 *     refusal counted;
 *   - scoped to agent 41, setting OFF (the default): the full daemon, exactly as
 *     before this change, and the start counted as a wrong-agent would-refuse;
 *   - scoped to agent 42, mode strict: the right agent, the full daemon;
 *   - an unreadable scope, mode strict: FAILS OPEN, the full daemon.
 *
 * Skipped where it cannot run: a host without bun.
 *
 * Run: npx tsx --test test/attach-scope.e2e.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { removeScratchDir } from './helpers/scratch-dirs'
import { ATTACH_SCOPE_DIR_ENV, ATTACH_SCOPE_ENV, ATTACH_SCOPE_EVENTS_FILE, ATTACH_SCOPE_MODE_ENV } from '../lib/attach-scope.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0
const SLOW = { timeout: 120_000, skip: hasBun ? false : 'needs bun' }
const NOTICE_TOOL = 'hoai_not_this_agent'

interface Rig {
  home: string
  folder: string
  stateDir: string
}

function rig(): Rig {
  // Native: Windows temp folders can be 8.3 names (RUNNER~1), which bun's realpath expands and node's does not.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hoai-scope-e2e-')))
  const folder = join(home, 'agent')
  const stateDir = join(home, '.bgos-plugin-state')
  for (const dir of [folder, join(home, '.bgos-agent')]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(home, '.bgos-agent', 'credentials-42.json'),
    JSON.stringify({ backendUrl: 'http://127.0.0.1:9/api/v1', pairingToken: 'TESTTOKEN', pairingId: 420, userId: 'u1', assistantId: 42, homeDir: folder, homeSource: 'pairing' }),
  )
  writeFileSync(join(folder, '.bgos-agent-id'), '42\n')
  return { home, folder, stateDir }
}

interface Answer {
  tools: Array<{ name: string; description?: string }>
  names: string[]
  stderr: string
}

/**
 * Boot the daemon with `extraEnv`, speak MCP, list its tools, then stop it (a
 * PID this test started). Driven by the answers, not by timers: initialize is
 * written at once (the pipe holds it until the server reads), tools/list once
 * initialize is answered, and stdin closes once tools/list is answered. A hard
 * deadline only bounds a daemon that never answers.
 */
function boot(r: Rig, extraEnv: Record<string, string>): Promise<Answer> {
  return new Promise((resolve) => {
    const child = spawn('bun', [join(repoRoot, 'server.ts')], {
      cwd: r.folder,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: r.home,
        USERPROFILE: r.home, // what os.homedir() reads on Windows
        CLAUDE_CONFIG_DIR: join(r.home, '.claude'),
        BGOS_LAUNCH_CWD: r.folder,
        BGOS_PLUGIN_STATE_DIR: r.stateDir,
        HOAI_BROWSER_HOST: 'off',
        ...extraEnv,
      },
    })
    let out = ''
    let err = ''
    let tools: Answer['tools'] = []
    let initialized = false
    let done = false
    const send = (m: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(m)}\n`)
      } catch {}
    }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(deadline)
      resolve({ tools, names: tools.map((t) => t.name), stderr: err })
    }
    const stop = () => {
      try {
        child.stdin.end()
      } catch {}
      // A full daemon does not end with stdin at once: stop it (our own PID).
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
        }, 1500).unref()
      }, 500).unref()
    }
    child.stdout.on('data', (d) => {
      out += d
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        let msg: { id?: number; result?: { tools?: Answer['tools'] } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1 && !initialized) {
          initialized = true
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        } else if (msg.id === 2) {
          tools = msg.result?.tools ?? []
          // Answer once it has gone: on Windows a live daemon's working folder cannot be removed.
          stop()
        }
      }
    })
    child.stderr.on('data', (d) => (err += d))
    // 'close' so the last of stderr has arrived; a process holding the pipes after the exit only gets a second.
    child.on('close', finish)
    child.on('exit', () => setTimeout(finish, 1000))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })
    const deadline = setTimeout(() => {
      stop()
      finish()
    }, 45_000)
  })
}

function events(r: Rig): Array<Record<string, unknown>> {
  const path = join(r.stateDir, ATTACH_SCOPE_EVENTS_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('wrong agent, setting ON (wrong-agent): REFUSED with the one notice tool, and the refusal is counted', SLOW, async () => {
  const r = rig()
  try {
    const a = await boot(r, { [ATTACH_SCOPE_ENV]: '41', [ATTACH_SCOPE_MODE_ENV]: 'wrong-agent' })
    assert.deepEqual(a.names, [NOTICE_TOOL], a.stderr)
    assert.doesNotMatch(String(a.tools[0]!.description), /outside that agent/, 'the scope refusal tells its own story')
    assert.match(String(a.tools[0]!.description), /attach scope/)
    assert.match(a.stderr, /REFUSING to attach: this session was launched for agent 41/)
    const e = events(r)
    assert.equal(e.length, 1)
    assert.equal(e[0]!.outcome, 'wrong-agent')
    assert.equal(e[0]!.verdict, 'refuse')
    assert.equal(e[0]!.assistantId, '42')
    assert.equal(e[0]!.scope, '41')
  } finally {
    removeScratchDir(r.home)
  }
})

test('wrong agent, setting OFF (the default): the full daemon as before, counted as a would-refuse', SLOW, async () => {
  const r = rig()
  try {
    const a = await boot(r, { [ATTACH_SCOPE_ENV]: '41' })
    assert.ok(a.names.includes('reply'), `the full tool set: ${a.names.join(', ')}\n${a.stderr}`)
    assert.ok(!a.names.includes(NOTICE_TOOL))
    assert.match(a.stderr, /attach scope: mode=off \(default\).*WRONG agent; attaching; mode wrong-agent WOULD refuse/)
    const e = events(r)
    assert.equal(e.length, 1)
    assert.equal(e[0]!.outcome, 'wrong-agent')
    assert.equal(e[0]!.verdict, 'attach')
    assert.equal(e[0]!.refusedFrom, 'wrong-agent')
  } finally {
    removeScratchDir(r.home)
  }
})

test('right agent, strict: the full daemon', SLOW, async () => {
  const r = rig()
  try {
    const a = await boot(r, { [ATTACH_SCOPE_ENV]: '42', [ATTACH_SCOPE_MODE_ENV]: 'strict' })
    assert.ok(a.names.includes('reply'), `${a.names.join(', ')}\n${a.stderr}`)
    assert.equal(events(r)[0]!.outcome, 'match')
  } finally {
    removeScratchDir(r.home)
  }
})

test('an unreadable scope, strict: FAILS OPEN to the full daemon', SLOW, async () => {
  const r = rig()
  try {
    const a = await boot(r, { [ATTACH_SCOPE_ENV]: 'agent-41', [ATTACH_SCOPE_MODE_ENV]: 'strict' })
    assert.ok(a.names.includes('reply'), `${a.names.join(', ')}\n${a.stderr}`)
    assert.equal(events(r)[0]!.outcome, 'unreadable')
    assert.equal(events(r)[0]!.verdict, 'attach')
  } finally {
    removeScratchDir(r.home)
  }
})

test('THE BOARD ROW: a worker in agent 42\'s folder that inherited agent 41\'s env pin and scope is the wrong agent (by folder) and is refused when on', SLOW, async () => {
  const r = rig()
  try {
    writeFileSync(
      join(r.home, '.bgos-agent', 'credentials-41.json'),
      JSON.stringify({ backendUrl: 'http://127.0.0.1:9/api/v1', pairingToken: 'TESTTOKEN41', pairingId: 410, userId: 'u1', assistantId: 41, homeDir: join(r.home, 'other'), homeSource: 'pairing' }),
    )
    const inherited = { BGOS_ASSISTANT_ID: '41', [ATTACH_SCOPE_ENV]: '41', [ATTACH_SCOPE_DIR_ENV]: join(r.home, 'other') }
    const off = await boot(r, inherited)
    assert.ok(off.names.includes('reply'), `off: the full daemon, as today\n${off.stderr}`)
    assert.match(off.stderr, /pinned to agent 42, resolved agent 41: the WRONG agent; attaching; mode wrong-agent WOULD refuse/)
    const on = await boot(r, { ...inherited, [ATTACH_SCOPE_MODE_ENV]: 'wrong-agent' })
    assert.deepEqual(on.names, [NOTICE_TOOL], on.stderr)
    assert.match(on.stderr, /REFUSING to attach: this folder is pinned to agent 42/)
    const e = events(r)
    assert.deepEqual(e.map((x) => [x.outcome, x.by, x.launcher, x.verdict]), [
      ['wrong-agent', 'folder', 'inherited', 'attach'],
      ['wrong-agent', 'folder', 'inherited', 'refuse'],
    ])
  } finally {
    removeScratchDir(r.home)
  }
})

test('unscoped, strict: refused; the machine file sets the mode for every agent here', SLOW, async () => {
  const r = rig()
  try {
    writeFileSync(join(r.home, '.bgos-agent', 'attach-scope.json'), JSON.stringify({ mode: 'strict' }))
    const a = await boot(r, {})
    assert.deepEqual(a.names, [NOTICE_TOOL], a.stderr)
    assert.match(a.stderr, /mode=strict \(file\)/)
    assert.match(a.stderr, /REFUSING to attach: no launcher named the agent/)
    assert.equal(events(r)[0]!.outcome, 'unscoped')
    assert.equal(events(r)[0]!.verdict, 'refuse')
  } finally {
    removeScratchDir(r.home)
  }
})
