/**
 * hoai under HOAI_SUPERVISED=1: the launch bin/bgos-agent's run.sh v2 makes
 * (design section 4), where NOBODY is at the terminal.
 *
 * Every path that would wait for a person (a startup screen hoai will not
 * answer, a missing expect that leaves claude on its first screen, a folder
 * that does not say which agent it is, two agents and nothing to choose
 * between them, no identity at all so no pair code was ever given) instead
 * stops with a NAMED exit code and one line in ~/.bgos-agent/<id>/launch-status,
 * so run.sh counts it, `hoai-agent status` shows it, and the agent heals by
 * itself once the cause is fixed. A person-facing hoai is untouched: the same
 * screens still go to `interact` there.
 *
 * Also pinned: the supervised expect script holds a live session with
 * `expect eof` when there is no terminal (no tmux) and relays one with
 * `interact` inside tmux (where /compact is typed in, finding 8), carries the
 * compact state into launch-status, and reads run.sh's fail count for the
 * extra settle; and a supervised launch always resumes THIS agent's pin
 * (finding 7), using the service's own id when the folder declares none.
 *
 * Run: npx tsx --test test/hoai-core.supervised.test.ts
 */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_ALREADY_SUPERVISED,
  EXIT_CHANNEL_UNRESOLVED,
  EXIT_SUPERVISED_GATE,
  EXIT_SUPERVISED_IDENTITY_MISMATCH,
  EXIT_SUPERVISED_NO_EXPECT,
  EXIT_SUPERVISED_SIGNED_OUT,
  EXIT_SUPERVISED_STARTUP_EXIT,
  EXIT_UNATTENDED_NEEDS_PERSON,
  FOLDER_PIN_FILE,
  LAUNCH_STATUS_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  buildGateAutoAcceptExpect,
  hostHasExpect,
  isSupervisedLaunch,
  main,
  readGateBlock,
  superviseClaude,
  supervisedServiceId,
} from '../bin/hoai-core.mjs'

const CLONE_SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '900' }

test('isSupervisedLaunch and supervisedServiceId: exactly "1", and digits only', () => {
  assert.equal(isSupervisedLaunch({ HOAI_SUPERVISED: '1' }), true)
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1x']) assert.equal(isSupervisedLaunch({ HOAI_SUPERVISED: v }), false, String(v))
  assert.equal(supervisedServiceId({ HOAI_SUPERVISED_ASSISTANT_ID: '900' }), '900')
  for (const v of [undefined, '', 'abc', '9 0', '-1', '../x']) assert.equal(supervisedServiceId({ HOAI_SUPERVISED_ASSISTANT_ID: v }), '', String(v))
})

// -- the supervised expect script --------------------------------------------

test('supervised expect script: fail-count settle first, then spawn, trap, the shared block VERBATIM, then a tail that names every failure and never waits for a person', () => {
  const block = readGateBlock()
  const script = buildGateAutoAcceptExpect({
    claudePath: 'claude',
    args: ['--dangerously-skip-permissions', '--resume', 'abc'],
    supervised: { stateDir: '/home/kc/.bgos-agent/900', interactive: false, compact: 'compact=off reason=no-tmux' },
  })
  assert.ok(script.includes(block), 'the shared block, byte for byte')
  const pre = script.slice(0, script.indexOf(block))
  const tail = script.slice(script.indexOf(block) + block.length)
  // run.sh's fail count drives the extra settle (a launch that lost the startup race waits longer next time).
  assert.match(pre, /set hoai_statedir "\/home\/kc\/\.bgos-agent\/900"/)
  assert.match(pre, /set hoai_extra_settle 0/)
  assert.match(pre, /open "\$hoai_statedir\/failcount"/)
  assert.match(pre, /\$hoai_fails >= 5 \? 10 : 2 \* \$hoai_fails/)
  assert.ok(pre.indexOf('spawn claude') < pre.indexOf('trap '), 'trap after spawn, before the block')
  // The tail presses nothing, writes the measured outcome, and stops on every failure by name.
  assert.doesNotMatch(tail, /\bsend\b/)
  assert.match(tail, /open "\$hoai_statedir\/launch-status" w/)
  assert.match(tail, /append hoai_line \{ compact=off reason=no-tmux\}/)
  assert.match(tail, new RegExp(`string match "gate-\\*" \\$hoai_outcome\\]\\} \\{ catch \\{close\\}; exit ${EXIT_SUPERVISED_GATE} \\}`))
  assert.match(tail, new RegExp(`"exited-during-startup"\\} \\{ exit ${EXIT_SUPERVISED_STARTUP_EXIT} \\}`))
  assert.match(tail, new RegExp(`"live-but-not-signed-in"\\} \\{ catch \\{close\\}; exit ${EXIT_SUPERVISED_SIGNED_OUT} \\}`))
  // With no terminal (no tmux) the live session is HELD, never interacted with: interact on
  // /dev/null reads EOF and would end the agent the moment it came up.
  assert.ok(tail.trimEnd().endsWith('expect eof'), tail)
  assert.doesNotMatch(tail, /interact/)
  assert.doesNotMatch(tail, /Nothing was pressed/, 'the person-facing handoff is not in the supervised script')
})

test('supervised expect script: inside tmux the live session is relayed with interact (what /compact is typed into), and the compact state is on', () => {
  const script = buildGateAutoAcceptExpect({
    claudePath: 'claude',
    args: [],
    supervised: { stateDir: '/s', interactive: true, compact: 'compact=on' },
  })
  const tail = script.slice(script.indexOf(readGateBlock()) + readGateBlock().length)
  assert.ok(tail.trimEnd().endsWith('interact'), tail)
  assert.match(tail, /append hoai_line \{ compact=on\}/)
})

test('supervised expect script: a state dir with Tcl specials is quoted, never evaluated', () => {
  const script = buildGateAutoAcceptExpect({
    claudePath: 'claude',
    args: [],
    gateBlock: '# block',
    supervised: { stateDir: '/Users/a b/[exec rm]/$x/"q"\\', interactive: false, compact: 'compact=on' },
  })
  assert.ok(script.includes('set hoai_statedir "/Users/a b/\\[exec rm\\]/\\$x/\\"q\\"\\\\"'), script.split('\n')[0])
})

test('the person-facing script is unchanged: no launch-status, no supervised exits, interact at the end', () => {
  const script = buildGateAutoAcceptExpect({ claudePath: 'claude', args: [] })
  assert.doesNotMatch(script, /launch-status|hoai_statedir/)
  assert.ok(script.trimEnd().endsWith('interact'))
})

// -- main() and the loop under HOAI_SUPERVISED ---------------------------------

interface Spawn {
  file: string
  args: string[]
}

function childExiting(code: number) {
  const child = new EventEmitter() as EventEmitter & { kill: () => void }
  child.kill = () => child.emit('exit', null, 'SIGTERM')
  setImmediate(() => child.emit('exit', code, null))
  return child
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'hoai-sup-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-sup-agent-'))
  const statusOf = (id: string) => {
    const path = join(home, '.bgos-agent', id, LAUNCH_STATUS_FILE_NAME)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }
  const cleanup = () => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
  return { home, cwd, statusOf, cleanup }
}

async function runMain(
  sb: ReturnType<typeof sandbox>,
  { env = SUPERVISED as Record<string, string>, codes = [0], scriptDir = CLONE_SCRIPT_DIR, extra = {} }: { env?: Record<string, string>, codes?: number[], scriptDir?: string, extra?: Record<string, unknown> } = {},
) {
  const spawns: Spawn[] = []
  const prints: string[] = []
  let n = 0
  // The env object main() is handed. In production that is process.env, which claude (and so
  // the daemon claude starts) inherits, so what main() adds to it is what the launch carries.
  const launchEnv: Record<string, string | undefined> = { ...env }
  const code = await main([], {
    platform: 'linux',
    env: launchEnv,
    home: sb.home,
    cwd: sb.cwd,
    scriptDir,
    listProcesses: () => [],
    print: (l: string) => prints.push(l),
    healthyMs: 60_000,
    spawnImpl: ((file: string, args: readonly string[]) => {
      spawns.push({ file, args: [...args] })
      return childExiting(codes[n++] ?? 0)
    }) as never,
    ...extra,
  } as never)
  return { code, spawns, prints, launchEnv }
}

test('supervised: a pinless folder on a MULTI-agent host launches as the SERVICE agent, on its own pin, and hands the daemon BGOS_ASSISTANT_ID', async () => {
  // The service names its agent (HOAI_SUPERVISED_ASSISTANT_ID). buildRunPlan used to refuse
  // this folder as identity-ambiguous (exit 6) before that id was ever consulted, so run.sh
  // lapped forever on a folder it was installed for. The daemon inside the session needs the id
  // too: on a host with two paired agents and no pin it refuses to boot without one.
  const sb = sandbox()
  try {
    mkdirSync(join(sb.home, '.bgos-agent'), { recursive: true })
    writeFileSync(join(sb.home, '.bgos-agent', 'credentials-7.json'), '{}')
    writeFileSync(join(sb.home, '.bgos-agent', 'credentials-900.json'), '{}')
    const r = await runMain(sb)
    assert.equal(r.code, 0, r.prints.join('\n'))
    assert.equal(r.spawns.length, 1)
    assert.equal(r.launchEnv.BGOS_ASSISTANT_ID, '900', 'the daemon is told which agent it is')
    const pin = readFileSync(join(sb.home, '.bgos-agent', '900', SESSION_ID_FILE_NAME), 'utf8').trim()
    assert.match(r.spawns[0]!.args[1] ?? '', new RegExp(`\\{--session-id\\} \\{${pin}\\}`), 'the SERVICE agent\'s pin')
    assert.equal(existsSync(join(sb.home, '.bgos-agent', '7', SESSION_ID_FILE_NAME)), false, 'never the other agent\'s')
    assert.doesNotMatch(sb.statusOf('900'), /identity-ambiguous/)
  } finally {
    sb.cleanup()
  }
})

test('unattended with NO service id (two paired agents and nothing saying which) still stops with exit 6 instead of guessing', async () => {
  const sb = sandbox()
  try {
    mkdirSync(join(sb.home, '.bgos-agent'), { recursive: true })
    writeFileSync(join(sb.home, '.bgos-agent', 'credentials-7.json'), '{}')
    writeFileSync(join(sb.home, '.bgos-agent', 'credentials-8.json'), '{}')
    const r = await runMain(sb, { env: { HOAI_SUPERVISED: '1' } })
    assert.equal(r.code, EXIT_UNATTENDED_NEEDS_PERSON)
    assert.equal(r.spawns.length, 0)
    assert.equal(r.launchEnv.BGOS_ASSISTANT_ID, undefined)
  } finally {
    sb.cleanup()
  }
})

test('supervised: an undetermined channel stops with EXIT_CHANNEL_UNRESOLVED and says so in launch-status', async () => {
  const sb = sandbox()
  try {
    writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
    const npx = join(sb.home, '.npm', '_npx', 'c00bcfc5e22688dd', 'node_modules', 'claude-channel-bgos', 'bin')
    const r = await runMain(sb, { scriptDir: npx })
    assert.equal(r.code, EXIT_CHANNEL_UNRESOLVED)
    assert.equal(r.spawns.length, 0)
    assert.match(sb.statusOf('900'), /outcome=channel-unresolved detail="/)
  } finally {
    sb.cleanup()
  }
})

test('supervised: a folder pinned to ANOTHER agent than the service is refused (exit 7), never launched as either', async () => {
  const sb = sandbox()
  try {
    writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '871\n')
    const r = await runMain(sb)
    assert.equal(r.code, EXIT_SUPERVISED_IDENTITY_MISMATCH)
    assert.equal(r.spawns.length, 0)
    assert.match(sb.statusOf('900'), /outcome=identity-mismatch folder=871 service=900/)
    assert.equal(r.launchEnv.BGOS_ASSISTANT_ID, undefined, 'the service id never overrides what the folder declares')
    assert.equal(existsSync(join(sb.home, '.bgos-agent', '871', SUPERVISOR_FILE_NAME)), false)
  } finally {
    sb.cleanup()
  }
})

test('supervised: no identity anywhere (never paired, so no pair code was ever given) stops with exit 6 instead of a fresh unpinned session', async () => {
  const sb = sandbox()
  try {
    const r = await runMain(sb, { env: { HOAI_SUPERVISED: '1' } })
    assert.equal(r.code, EXIT_UNATTENDED_NEEDS_PERSON)
    assert.equal(r.spawns.length, 0)
    assert.ok(r.prints.some((l) => /identity-unknown/.test(l)), r.prints.join('\n'))
  } finally {
    sb.cleanup()
  }
})

test('supervised: a folder that declares no id launches as the SERVICE agent, on that agent\'s own pinned session', async () => {
  const sb = sandbox()
  try {
    const r = await runMain(sb)
    assert.equal(r.code, 0)
    assert.equal(r.spawns.length, 1)
    const pin = readFileSync(join(sb.home, '.bgos-agent', '900', SESSION_ID_FILE_NAME), 'utf8').trim()
    assert.match(pin, /^[0-9a-f-]{36}$/)
    assert.equal(r.spawns[0]!.file, 'expect', 'always under expect: nobody can answer a gate')
    assert.match(r.spawns[0]!.args[1] ?? '', new RegExp(`\\{--session-id\\} \\{${pin}\\}`))
  } finally {
    sb.cleanup()
  }
})

test('supervised: the spawned script is the SUPERVISED one (launch-status, named exits, expect eof without a terminal)', async () => {
  const sb = sandbox()
  try {
    writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
    const r = await runMain(sb)
    const script = r.spawns[0]?.args[1] ?? ''
    assert.match(script, /set hoai_statedir ".*\/\.bgos-agent\/900"/)
    assert.match(script, new RegExp(`exit ${EXIT_SUPERVISED_GATE} \\}`))
    assert.match(script, /append hoai_line \{ compact=off reason=no-tmux\}/, 'no BGOS_TMUX_SESSION in this env')
    // The test runner has no terminal on stdin, exactly like a launchd job without tmux.
    if (!process.stdin.isTTY) assert.ok(script.trimEnd().endsWith('expect eof'))
  } finally {
    sb.cleanup()
  }
})

test('supervised: inside tmux (BGOS_TMUX_SESSION set) the status line says compact=on', async () => {
  const sb = sandbox()
  try {
    writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
    const r = await runMain(sb, { env: { ...SUPERVISED, BGOS_TMUX_SESSION: 'hoai-900', BGOS_TMUX_SOCKET: 'hoai-900' } })
    assert.match(r.spawns[0]?.args[1] ?? '', /append hoai_line \{ compact=on\}/)
  } finally {
    sb.cleanup()
  }
})

test('supervised: the gate is answered under expect even when detection says "unknown" (a workspace .mcp.json run from an npx root)', async () => {
  for (const [env, viaExpect] of [
    [SUPERVISED, true],
    [{}, false], // a person-facing launch keeps today's behaviour
  ] as const) {
    const sb = sandbox()
    try {
      writeFileSync(
        join(sb.cwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: ['w.mjs'], env: { BGOS_ASSISTANT_ID: '900' } } } }),
      )
      const npx = join(sb.home, '.npm', '_npx', 'c00bcfc5e22688dd', 'node_modules', 'claude-channel-bgos', 'bin')
      const r = await runMain(sb, { env, scriptDir: npx })
      assert.equal(r.code, 0, r.prints.join('\n'))
      assert.equal(r.spawns[0]?.file, viaExpect ? 'expect' : 'claude', JSON.stringify(env))
    } finally {
      sb.cleanup()
    }
  }
})

test('supervised: a gate nobody can answer (exit 9) on a RESUME is not retried fresh; a resume that dies during startup (exit 10) still gets the one-shot fresh fallback', async () => {
  for (const [first, expectSpawns, expectCode] of [
    [EXIT_SUPERVISED_GATE, 1, EXIT_SUPERVISED_GATE],
    [EXIT_SUPERVISED_SIGNED_OUT, 1, EXIT_SUPERVISED_SIGNED_OUT],
    [EXIT_SUPERVISED_STARTUP_EXIT, 2, 0],
  ] as const) {
    const sb = sandbox()
    try {
      writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
      const pin = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      mkdirSync(join(sb.home, '.bgos-agent', '900'), { recursive: true })
      writeFileSync(join(sb.home, '.bgos-agent', '900', SESSION_ID_FILE_NAME), pin)
      const projects = join(sb.home, '.claude', 'projects', sb.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
      mkdirSync(projects, { recursive: true })
      writeFileSync(join(projects, `${pin}.jsonl`), '{}\n')
      const r = await runMain(sb, { codes: [first, 0] })
      assert.match(r.spawns[0]?.args[1] ?? '', /\{--resume\}/)
      assert.equal(r.spawns.length, expectSpawns, `exit ${first}`)
      assert.equal(r.code, expectCode, `exit ${first}`)
    } finally {
      sb.cleanup()
    }
  }
})

test('supervised: with no expect on a posix host the launch is refused (exit 8), because claude would sit on its first screen forever', async () => {
  const sb = sandbox()
  try {
    writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
    let spawned = 0
    const code = await superviseClaude(['--dangerously-skip-permissions'], {
      platform: 'linux',
      env: { ...SUPERVISED },
      home: sb.home,
      cwd: sb.cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      listProcesses: () => [],
      print: () => {},
      writeErr: () => {},
      hasExpect: false,
      spawnImpl: (() => {
        spawned += 1
        return childExiting(0)
      }) as never,
    })
    assert.equal(code, EXIT_SUPERVISED_NO_EXPECT)
    assert.equal(spawned, 0)
    assert.match(sb.statusOf('900'), /outcome=expect-missing/)
  } finally {
    sb.cleanup()
  }
})

test('hostHasExpect: the well-known paths AND every PATH directory, because the installer only required `command -v expect` and baked its directory into the service PATH', () => {
  const only = (paths: string[]) => (p: string) => paths.includes(p)
  assert.equal(hostHasExpect({ platform: 'darwin', env: { PATH: '' }, exists: only(['/usr/bin/expect']) }), true)
  // A Nix or Linuxbrew expect, found only through PATH: refusing it as "expect-missing" would
  // keep an agent down on a host where the installer had just found it.
  assert.equal(
    hostHasExpect({ platform: 'linux', env: { PATH: '/home/kc/.nix-profile/bin:/usr/bin' }, exists: only(['/home/kc/.nix-profile/bin/expect']) }),
    true,
  )
  assert.equal(hostHasExpect({ platform: 'linux', env: { PATH: '/a:/b' }, exists: only([]) }), false)
  assert.equal(hostHasExpect({ platform: 'win32', env: { PATH: 'C:\\x' }, exists: () => true }), false, 'never on Windows')
})

test('supervised: the launch finds expect through ITS OWN PATH (the service PATH), and refuses only when that PATH has none either', async () => {
  for (const [path, spawnedVia, code] of [
    ['/opt/nix/bin:/usr/bin', 'expect', 0],
    ['/usr/bin', null, EXIT_SUPERVISED_NO_EXPECT],
  ] as const) {
    const sb = sandbox()
    try {
      writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
      const spawns: string[] = []
      const got = await superviseClaude(['--dangerously-skip-permissions'], {
        platform: 'linux',
        env: { ...SUPERVISED, PATH: path },
        home: sb.home,
        cwd: sb.cwd,
        scriptDir: CLONE_SCRIPT_DIR,
        listProcesses: () => [],
        print: () => {},
        writeErr: () => {},
        // Only the Nix expect exists on this pretend host.
        expectExists: (p: string) => p === '/opt/nix/bin/expect',
        spawnImpl: ((file: string) => {
          spawns.push(file)
          return childExiting(0)
        }) as never,
      } as never)
      assert.equal(got, code, path)
      assert.deepEqual(spawns, spawnedVia ? [spawnedVia] : [], path)
    } finally {
      sb.cleanup()
    }
  }
})

test('supervised: a live launcher already owning the agent is a named outcome in launch-status, not a silent exit', async () => {
  const sb = sandbox()
  try {
    writeFileSync(join(sb.cwd, FOLDER_PIN_FILE), '900\n')
    mkdirSync(join(sb.home, '.bgos-agent', '900'), { recursive: true })
    // The parent of this test process is alive and is not us: a live owner, once its command
    // line says it runs hoai (the pid identity check; the real parent is the test runner).
    writeFileSync(join(sb.home, '.bgos-agent', '900', SUPERVISOR_FILE_NAME), JSON.stringify({ pid: process.ppid, capabilities: ['relaunch'] }))
    const r = await runMain(sb, { extra: { pidProcess: (pid: number) => (pid === process.ppid ? { command: '/usr/local/bin/node /p/bin/hoai-core.mjs', startedAtMs: null } : null) } })
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.equal(r.spawns.length, 0)
    assert.match(sb.statusOf('900'), new RegExp(`outcome=already-supervised owner=${process.ppid}`))
  } finally {
    sb.cleanup()
  }
})

test('NOT supervised: the same refusals stay exactly as they were (exit 1, no launch-status written)', async () => {
  const sb = sandbox()
  try {
    mkdirSync(join(sb.home, '.bgos-agent'), { recursive: true })
    writeFileSync(join(sb.home, '.bgos-agent', 'credentials-7.json'), '{}')
    writeFileSync(join(sb.home, '.bgos-agent', 'credentials-8.json'), '{}')
    const r = await runMain(sb, { env: {} })
    assert.equal(r.code, 1)
    assert.equal(sb.statusOf('7') + sb.statusOf('8') + sb.statusOf('900'), '')
  } finally {
    sb.cleanup()
  }
})
