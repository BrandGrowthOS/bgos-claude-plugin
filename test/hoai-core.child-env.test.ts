/**
 * The supervision variables stop at hoai (plugin-supervisor review F7).
 *
 * run.sh (and the Windows task's vbs) start hoai with HOAI_SUPERVISED=1 and
 * HOAI_SUPERVISED_ASSISTANT_ID=<A>. hoai is their only reader, but claude
 * inherited them, and so did every Bash tool process it ran. An agent that
 * typed `cd ../worker-B && hoai` then launched as if it were A's service: exit
 * 7 (identity-mismatch) in a folder pinned to B, exit 3 (already-supervised)
 * in a pinless one, and either way A's own launch-status was overwritten, so
 * `hoai-agent status` and the watcher misreported A. claude is now started
 * without them; hoai's own env keeps them (a relaunch resolves the service's
 * identity from them).
 *
 * Every OS effect is a fake: spawn is injected, HOME and the folders are temp dirs.
 *
 * Run: npx tsx --test test/hoai-core.child-env.test.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FOLDER_PIN_FILE,
  LAUNCH_STATUS_FILE_NAME,
  childEnvWithoutSupervision,
  main,
  superviseClaude,
} from '../bin/hoai-core.mjs'

const CLONE_SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '871' }

interface Spawned {
  file: string
  args: string[]
  opts: { env?: Record<string, string | undefined> } & Record<string, unknown>
}

function exitingChild(code = 0) {
  const child = new EventEmitter() as EventEmitter & { kill: () => void }
  child.kill = () => child.emit('exit', null, 'SIGTERM')
  setImmediate(() => child.emit('exit', code, null))
  return child
}

function launch(platform: 'linux' | 'win32', env: Record<string, string | undefined>) {
  const spawns: Spawned[] = []
  const files = new Map<string, string>()
  const home = platform === 'win32' ? 'C:\\Users\\kc' : '/home/kc'
  const cwd = platform === 'win32' ? 'C:\\agents\\athena' : '/agents/athena'
  const pin = platform === 'win32' ? `${cwd}\\${FOLDER_PIN_FILE}` : `${cwd}/${FOLDER_PIN_FILE}`
  const done = superviseClaude(['--dangerously-skip-permissions'], {
    platform,
    env,
    home,
    cwd,
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) => (p === pin ? '871' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((file: string, args: readonly string[], opts: Spawned['opts']) => {
      spawns.push({ file, args: [...args], opts })
      return exitingChild(0)
    }) as never,
    spawnGateHelper: () => ({ pid: 1 }),
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, c: string) => {
      files.set(p, c)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: () => {},
    hasExpect: true,
    stdinIsTTY: false,
    listProcesses: () => [],
    pidCommandLine: () => null,
  } as never)
  return { spawns, done }
}

test('childEnvWithoutSupervision: drops exactly the two supervision variables (any case on win32), keeps everything else, never mutates the input', () => {
  const env = { ...SUPERVISED, PATH: '/usr/bin', BGOS_TMUX_SESSION: 'hoai-871', BGOS_ASSISTANT_ID: '871', GONE: undefined }
  const out = childEnvWithoutSupervision(env, 'linux')
  assert.deepEqual(out, { PATH: '/usr/bin', BGOS_TMUX_SESSION: 'hoai-871', BGOS_ASSISTANT_ID: '871' })
  assert.equal(env.HOAI_SUPERVISED, '1', 'hoai keeps them: a relaunch resolves the service identity from them')
  // posix names are case sensitive: a lowercase variable is somebody else's.
  assert.deepEqual(childEnvWithoutSupervision({ hoai_supervised: 'x' }, 'linux'), { hoai_supervised: 'x' })
  // Windows names are not.
  assert.deepEqual(childEnvWithoutSupervision({ Hoai_Supervised: '1', hoai_supervised_assistant_id: '871', Path: 'C:\\x' }, 'win32'), { Path: 'C:\\x' })
})

test('supervised, posix: expect (and the claude under it) is started WITHOUT the supervision variables, with everything else', async () => {
  const env = { ...SUPERVISED, PATH: '/usr/bin:/bin', BGOS_TMUX_SESSION: 'hoai-871' }
  const h = launch('linux', env)
  await h.done
  assert.equal(h.spawns.length, 1)
  assert.equal(h.spawns[0]!.file, 'expect')
  const childEnv = h.spawns[0]!.opts.env
  assert.ok(childEnv, 'an explicit environment is handed to the child')
  assert.equal('HOAI_SUPERVISED' in childEnv!, false)
  assert.equal('HOAI_SUPERVISED_ASSISTANT_ID' in childEnv!, false)
  assert.equal(childEnv!.PATH, '/usr/bin:/bin')
  assert.equal(childEnv!.BGOS_TMUX_SESSION, 'hoai-871', 'what turns remote compact on still reaches the session')
  assert.equal(env.HOAI_SUPERVISED, '1', 'hoai\'s own env is untouched')
})

test('supervised, win32 (the agent task\'s --keep-alive launch path): claude is started without them too', async () => {
  const h = launch('win32', { ...SUPERVISED, Path: 'C:\\nodejs' })
  await h.done
  const claude = h.spawns.find((s) => s.file === 'claude')
  assert.ok(claude, 'claude was spawned directly (no expect on Windows)')
  assert.deepEqual(claude!.opts.env, { Path: 'C:\\nodejs' })
})

test('the finding\'s scenario: `hoai` typed inside agent A\'s session, in agent B\'s folder, launches B and leaves A\'s launch-status alone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hoai-childenv-home-'))
  const folderA = mkdtempSync(join(tmpdir(), 'hoai-childenv-a-'))
  const folderB = mkdtempSync(join(tmpdir(), 'hoai-childenv-b-'))
  const bin = mkdtempSync(join(tmpdir(), 'hoai-childenv-bin-'))
  try {
    writeFileSync(join(bin, 'expect'), '')
    writeFileSync(join(folderA, FOLDER_PIN_FILE), '111\n')
    writeFileSync(join(folderB, FOLDER_PIN_FILE), '222\n')
    mkdirSync(join(home, '.bgos-agent'), { recursive: true })
    const statusA = join(home, '.bgos-agent', '111', LAUNCH_STATUS_FILE_NAME)
    const run = async (cwd: string, env: Record<string, string | undefined>) => {
      const spawns: Spawned[] = []
      const code = await main([], {
        platform: 'linux',
        env,
        home,
        cwd,
        scriptDir: CLONE_SCRIPT_DIR,
        listProcesses: () => [],
        print: () => {},
        registerHooks: () => {},
        preseedTrust: () => {},
        signals: new EventEmitter(),
        stdinIsTTY: false,
        healthyMs: 60_000,
        spawnImpl: ((file: string, args: readonly string[], opts: Spawned['opts']) => {
          spawns.push({ file, args: [...args], opts })
          return exitingChild(0)
        }) as never,
      } as never)
      return { code, spawns }
    }
    // Agent A's supervised launch (what run.sh starts). In production the env main() is handed
    // IS process.env, so a child spawned with no explicit env inherits exactly that object.
    const envA: Record<string, string | undefined> = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '111', PATH: bin }
    const a = await run(folderA, envA)
    assert.equal(a.code, 0)
    const inherited = a.spawns[0]!.opts.env ?? envA
    // A's session ends (the fake exits at once); its last status is whatever A measured.
    writeFileSync(statusA, '2026-10-07 10:00:00 outcome=live\n')
    // A Bash tool inside A's session runs `hoai` in B's folder with the env A's claude got.
    const b = await run(folderB, { ...inherited })
    assert.equal(b.code, 0, 'B launched (it used to stop with 7, identity-mismatch folder=222 service=111)')
    assert.equal(b.spawns.length, 1)
    assert.equal(readFileSync(statusA, 'utf8'), '2026-10-07 10:00:00 outcome=live\n', 'A\'s launch-status is A\'s')
    assert.equal(existsSync(join(home, '.bgos-agent', '222', LAUNCH_STATUS_FILE_NAME)), false, 'a person-facing launch writes none')
  } finally {
    for (const dir of [home, folderA, folderB, bin]) rmSync(dir, { recursive: true, force: true })
  }
})
