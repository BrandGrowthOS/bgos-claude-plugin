/**
 * hoai-core tests (pure routing + run planning; no real fs, no real spawn).
 *
 * `hoai` is the one command a troubleshooting operator runs from an agent
 * folder, so this suite pins its whole decision surface: the first-token
 * routing table (including a bare BGOS-/OC- pair code routing to pair), the
 * run plan's channel spec per install shape (a wrong flag drops every inbound
 * message silently, 2026-08-21), the folder-pin identity path that needs no
 * env var, the multi-agent refusal that names BOTH remedies, and the log-path
 * mirror of lib/log-path.ts.
 *
 * Run: npm test (node --test) or node --test test/hoai-core.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  FOLDER_PIN_FILE,
  EXIT_NOT_FOUND,
  resolveHoaiAction,
  buildRunPlan,
  readFolderPin,
  configuredAssistantId,
  listPairedAssistantIds,
  hoaiLogPath,
  logsAssistantId,
  lastLines,
  claudeSpawnCandidates,
  exitCodeForChild,
  joinDir,
  isRunAsMain,
  parseSetupArgs,
  runSetup,
  HOAI_MARKETPLACE,
  HOAI_PLUGIN_REF,
} from '../bin/hoai-core.mjs'

const WIN_HOME = 'C:\\Users\\x'
const POSIX_HOME = '/home/kc'
const MARKETPLACE_SCRIPT_DIR =
  'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.37.0\\bin'
const CLONE_SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'

// Both methods use the dev-channels flag (bgos-install-method.mjs
// launchFlagArgs documents why --channels is a trap); only the spec differs.
const MARKETPLACE_FLAGS = ['--dangerously-skip-permissions', '--dangerously-load-development-channels']
const CLONE_FLAGS = ['--dangerously-skip-permissions', '--dangerously-load-development-channels']

/** A readFile stub serving exactly one path. */
function readFileServing(path: string, content: string) {
  return (requested: string) => (requested === path ? content : null)
}

const noFiles = () => null
const noDir = () => [] as string[]

// -- resolveHoaiAction --------------------------------------------------------

test('resolveHoaiAction: the routing table', () => {
  assert.deepEqual(resolveHoaiAction([]), { action: 'run', rest: [] })
  assert.deepEqual(resolveHoaiAction(['run']), { action: 'run', rest: [] })
  assert.deepEqual(resolveHoaiAction(['doctor', '--verbose']), {
    action: 'doctor',
    rest: ['--verbose'],
  })
  assert.deepEqual(resolveHoaiAction(['pair', 'BGOS-7F3A-2K']), {
    action: 'pair',
    rest: ['BGOS-7F3A-2K'],
  })
  assert.deepEqual(resolveHoaiAction(['logs']), { action: 'logs', rest: [] })
  assert.deepEqual(resolveHoaiAction(['help']), { action: 'help', rest: [] })
  assert.deepEqual(resolveHoaiAction(['-h']), { action: 'help', rest: [] })
  assert.deepEqual(resolveHoaiAction(['--help']), { action: 'help', rest: [] })
})

test('resolveHoaiAction: a bare pair code routes to pair with itself prepended', () => {
  assert.deepEqual(resolveHoaiAction(['BGOS-7F3A-2K']), {
    action: 'pair',
    rest: ['BGOS-7F3A-2K'],
  })
  // Case insensitive prefix, and trailing flags ride along after the code.
  assert.deepEqual(resolveHoaiAction(['oc-abc-12', '--backend', 'http://x']), {
    action: 'pair',
    rest: ['oc-abc-12', '--backend', 'http://x'],
  })
})

test('resolveHoaiAction: anything else routes to help, keeping the tokens', () => {
  assert.deepEqual(resolveHoaiAction(['status']), { action: 'help', rest: ['status'] })
  assert.deepEqual(resolveHoaiAction(['--nonsense', 'x']), {
    action: 'help',
    rest: ['--nonsense', 'x'],
  })
  // A dashed token that is NOT a pair code is not mistaken for one.
  assert.deepEqual(resolveHoaiAction(['BOGUS-1234']), { action: 'help', rest: ['BOGUS-1234'] })
})

// -- buildRunPlan -------------------------------------------------------------

test('buildRunPlan: folder pin + marketplace-shaped scriptDir launches plugin:hoai@hoai and needs no env pin', () => {
  const cwd = 'C:\\agents\\ava'
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: WIN_HOME,
    readFile: readFileServing(`${cwd}\\${FOLDER_PIN_FILE}`, '871\n'),
    listDir: noDir,
    scriptDir: MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.equal(plan.command, 'claude')
  assert.deepEqual(plan.args, [...MARKETPLACE_FLAGS, 'plugin:hoai@hoai'])
  // The note names the pinned assistant and says the env pin is not needed.
  assert.match(plan.note, /assistant 871/)
  assert.match(plan.note, /no BGOS_ASSISTANT_ID env pin is needed/)
  assert.match(plan.note, /self-resolves/)
})

test('buildRunPlan: clone-shaped scriptDir launches server:bgos', () => {
  const cwd = '/home/kc/agents/ava'
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: POSIX_HOME,
    readFile: readFileServing(`${cwd}/${FOLDER_PIN_FILE}`, '42'),
    listDir: noDir,
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.deepEqual(plan.args, [...CLONE_FLAGS, 'server:bgos'])
  assert.match(plan.note, /assistant 42/)
})

test('buildRunPlan: no pin + several credentials files refuses, naming both remedies', () => {
  const plan = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: () => ['credentials-871.json', 'credentials-902.json', 'credentials.json', 'junk.txt'],
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, false)
  if (plan.ok) return
  assert.match(plan.reason, /2 paired agents/)
  assert.match(plan.reason, /871, 902/)
  // Remedy one: run hoai from the agent's own folder.
  assert.match(plan.reason, /agent's own folder/)
  // Remedy two: set the env pin.
  assert.match(plan.reason, /BGOS_ASSISTANT_ID=871/)
})

test('buildRunPlan: no pin + a single credentials file launches (the daemon self-resolves)', () => {
  const plan = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: () => ['credentials-871.json'],
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.deepEqual(plan.args, [...CLONE_FLAGS, 'server:bgos'])
  assert.match(plan.note, /assistant 871/)
})

test('buildRunPlan: no pin + no credentials at all still launches, hinting at pairing', () => {
  const plan = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: noDir,
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.match(plan.note, /hoai pair/)
})

test('buildRunPlan: an explicit BGOS_ASSISTANT_ID env pin suppresses the multi-agent refusal', () => {
  const plan = buildRunPlan({
    cwd: '/home/kc/somewhere',
    env: { BGOS_ASSISTANT_ID: '902' },
    home: POSIX_HOME,
    readFile: noFiles,
    listDir: () => ['credentials-871.json', 'credentials-902.json'],
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.match(plan.note, /assistant 902/)
  assert.match(plan.note, /env pin/)
})

test('buildRunPlan: a junk folder pin is ignored, never obeyed', () => {
  const cwd = '/home/kc/somewhere'
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: POSIX_HOME,
    readFile: readFileServing(`${cwd}/${FOLDER_PIN_FILE}`, 'not-a-number'),
    listDir: () => ['credentials-871.json', 'credentials-902.json'],
    scriptDir: CLONE_SCRIPT_DIR,
  })
  // With the pin unusable and no env pin, the multi-agent refusal applies.
  assert.equal(plan.ok, false)
})

// -- Identity + path helpers --------------------------------------------------

test('readFolderPin: trimmed digits only', () => {
  const cwd = '/home/kc/agents/ava'
  const pinPath = `${cwd}/${FOLDER_PIN_FILE}`
  assert.equal(readFolderPin(cwd, readFileServing(pinPath, ' 871 \n')), '871')
  assert.equal(readFolderPin(cwd, readFileServing(pinPath, 'abc')), '')
  assert.equal(readFolderPin(cwd, noFiles), '')
  assert.equal(readFolderPin('', noFiles), '')
})

test('configuredAssistantId: trims and ignores the unsubstituted placeholder', () => {
  assert.equal(configuredAssistantId({ BGOS_ASSISTANT_ID: ' 871 ' }), '871')
  assert.equal(configuredAssistantId({ BGOS_ASSISTANT_ID: '${user_config.assistant_id}' }), '')
  assert.equal(configuredAssistantId({}), '')
})

test('listPairedAssistantIds: credentials-<id>.json only, ascending', () => {
  const ids = listPairedAssistantIds(POSIX_HOME, () => [
    'credentials-902.json',
    'credentials.json',
    'credentials-871.json',
    'credentials-x.json',
    'logs',
  ])
  assert.deepEqual(ids, ['871', '902'])
  assert.deepEqual(listPairedAssistantIds(POSIX_HOME, noDir), [])
})

test('hoaiLogPath mirrors lib/log-path.ts: BGOS_LOG_FILE wins, else the stable home-rooted default', () => {
  assert.equal(
    hoaiLogPath({ env: { BGOS_LOG_FILE: ' /var/log/custom.log ' }, home: POSIX_HOME, assistantId: '871' }),
    '/var/log/custom.log',
  )
  assert.equal(
    hoaiLogPath({ env: {}, home: POSIX_HOME, assistantId: '871' }),
    '/home/kc/.bgos-agent/logs/bgos-plugin-871.log',
  )
  assert.equal(
    hoaiLogPath({ env: {}, home: WIN_HOME, assistantId: '' }),
    'C:\\Users\\x\\.bgos-agent\\logs\\bgos-plugin-unknown.log',
  )
})

test('logsAssistantId: folder pin beats env pin beats unknown', () => {
  const cwd = '/home/kc/agents/ava'
  const pinPath = `${cwd}/${FOLDER_PIN_FILE}`
  assert.equal(
    logsAssistantId({ cwd, env: { BGOS_ASSISTANT_ID: '902' }, readFile: readFileServing(pinPath, '871') }),
    '871',
  )
  assert.equal(logsAssistantId({ cwd, env: { BGOS_ASSISTANT_ID: '902' }, readFile: noFiles }), '902')
  assert.equal(logsAssistantId({ cwd, env: {}, readFile: noFiles }), 'unknown')
})

test('lastLines: tails at most n lines, dropping the trailing blank', () => {
  assert.deepEqual(lastLines('a\nb\nc\n', 2), ['b', 'c'])
  assert.deepEqual(lastLines('a\r\nb\r\n', 60), ['a', 'b'])
  assert.deepEqual(lastLines('', 60), [])
})

test('joinDir preserves the separator style of the directory', () => {
  assert.equal(joinDir('C:\\Users\\x\\bin', 'a.mjs'), 'C:\\Users\\x\\bin\\a.mjs')
  assert.equal(joinDir('/home/kc/bin/', 'a.mjs'), '/home/kc/bin/a.mjs')
})

// -- Spawn plumbing -----------------------------------------------------------

test('claudeSpawnCandidates: posix is a single bare claude; win32 chains claude, ComSpec /c claude.cmd, claude.exe', () => {
  const args = [...CLONE_FLAGS, 'server:bgos']
  assert.deepEqual(claudeSpawnCandidates(args, 'linux'), [
    { file: 'claude', args, notFoundExitCodes: [] },
  ])
  const win = claudeSpawnCandidates(args, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
  assert.deepEqual(win, [
    { file: 'claude', args, notFoundExitCodes: [] },
    {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', 'claude.cmd', ...args],
      notFoundExitCodes: [9009],
    },
    { file: 'claude.exe', args, notFoundExitCodes: [] },
  ])
  // No ComSpec in env: the bare cmd.exe name still works via the PATH search.
  assert.equal(claudeSpawnCandidates(args, 'win32', {})[1].file, 'cmd.exe')
})

test('exitCodeForChild: plain codes pass through, signals map to 128 + n', () => {
  assert.equal(exitCodeForChild(0, null), 0)
  assert.equal(exitCodeForChild(3, null), 3)
  assert.equal(exitCodeForChild(null, 'SIGINT'), 130)
  assert.equal(exitCodeForChild(null, 'SIGTERM'), 143)
  assert.equal(exitCodeForChild(null, 'SIGKILL'), 1)
  assert.equal(exitCodeForChild(null, null), 1)
})

test('EXIT_NOT_FOUND is the POSIX 127', () => {
  assert.equal(EXIT_NOT_FOUND, 127)
})

test('isRunAsMain is false when imported by the test runner', () => {
  assert.equal(isRunAsMain(), false)
})

// -- hoai setup ---------------------------------------------------------------
//
// `hoai setup <CODE>` exists so the app can hand out ONE line that works in
// every shell. What it replaced was `claude plugin marketplace add ... &&
// claude plugin install ... && npx ... hoai-pair <CODE>`, and `&&` is a parse
// error in Windows PowerShell 5.1, so on the shell most Windows owners have
// open that paste failed before the first step ever ran. Sequencing the steps
// here (each a shell:false spawn) is what removes shell syntax from the line.

test('resolveHoaiAction: setup routes with its argv intact', () => {
  assert.deepEqual(resolveHoaiAction(['setup', 'BGOS-7F3A-2K']), {
    action: 'setup',
    rest: ['BGOS-7F3A-2K'],
  })
  assert.deepEqual(
    resolveHoaiAction(['SETUP', 'BGOS-7F3A-2K', '--assistant-id', '901']),
    { action: 'setup', rest: ['BGOS-7F3A-2K', '--assistant-id', '901'] },
  )
})

test('parseSetupArgs: the code leads, everything after it passes through in order', () => {
  assert.deepEqual(parseSetupArgs(['BGOS-7F3A-2K']), {
    ok: true,
    code: 'BGOS-7F3A-2K',
    pairArgs: ['BGOS-7F3A-2K'],
  })
  // The pinned-identity form the create-first flow emits. Both the code and
  // the id must reach bgos-pair byte for byte: pairing 404s on a mangled code
  // and binds the WRONG agent on a mangled id.
  assert.deepEqual(
    parseSetupArgs(['BGOS-7F3A-2K', '--assistant-id', '901']),
    {
      ok: true,
      code: 'BGOS-7F3A-2K',
      pairArgs: ['BGOS-7F3A-2K', '--assistant-id', '901'],
    },
  )
  // Unknown pair flags ride along rather than being dropped.
  const withBackend = parseSetupArgs([
    'BGOS-7F3A-2K',
    '--backend',
    'http://localhost:8080/api/v1',
  ])
  assert.equal(withBackend.ok, true)
  assert.deepEqual(withBackend.ok ? withBackend.pairArgs : [], [
    'BGOS-7F3A-2K',
    '--backend',
    'http://localhost:8080/api/v1',
  ])
})

test('parseSetupArgs: a value with a space or a shell metacharacter stays ONE argv entry', () => {
  // The whole point of sequencing in node: these are argv entries of a
  // shell:false spawn, so nothing re-splits or re-interprets them on any
  // platform. A shell would have split the first and eaten the second.
  const parsed = parseSetupArgs(['CODE WITH SPACE', '--assistant-id', 'a b&c;d`e'])
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok && parsed.pairArgs, [
    'CODE WITH SPACE',
    '--assistant-id',
    'a b&c;d`e',
  ])
})

test('parseSetupArgs: refuses a missing code and a flag standing where the code goes', () => {
  for (const argv of [[], [''], ['--assistant-id', '901']]) {
    const parsed = parseSetupArgs(argv)
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.reason, /pair code/)
  }
})

/** A child whose exit code is decided up front (spawn returns synchronously,
 *  the exit lands on the next tick, like the real thing). */
function scriptedChild(code: number) {
  const child = new EventEmitter() as EventEmitter & { exitCode: number }
  child.exitCode = code
  setImmediate(() => child.emit('exit', code, null))
  return child
}

/** Harness: records the claude arg vectors and the sibling-script spawns. */
function setupHarness(claudeCodes: number[]) {
  const claudeCalls: string[][] = []
  const siblingCalls: { file: string; args: string[] }[] = []
  const prints: string[] = []
  const errs: string[] = []
  let claudeIdx = 0
  return {
    claudeCalls,
    siblingCalls,
    prints,
    errs,
    run: (pairArgs: string[]) =>
      runSetup(pairArgs, {
        platform: 'linux',
        env: {},
        scriptDir: CLONE_SCRIPT_DIR,
        spawnImpl: ((file: string, args: readonly string[]) => {
          siblingCalls.push({ file, args: [...args] })
          return scriptedChild(0)
        }) as never,
        spawnClaudeImpl: (async (args: readonly string[]) => {
          claudeCalls.push([...args])
          return claudeCodes[claudeIdx++] ?? 0
        }) as never,
        print: (line: string) => prints.push(line),
        writeErr: (line: string) => {
          errs.push(line)
          // Mirrors the real writeErr (process.stderr.write returns boolean).
          return true
        },
      }),
  }
}

test('runSetup: marketplace, install, pair, in that order and with no shell', async () => {
  const h = setupHarness([0, 0])
  const code = await h.run(['BGOS-7F3A-2K', '--assistant-id', '901'])
  assert.equal(code, 0)
  assert.deepEqual(h.claudeCalls, [
    ['plugin', 'marketplace', 'add', HOAI_MARKETPLACE],
    ['plugin', 'install', HOAI_PLUGIN_REF],
  ])
  // Step 3 runs bgos-pair under THIS node, with the pair argv untouched.
  assert.equal(h.siblingCalls.length, 1)
  assert.equal(h.siblingCalls[0]!.file, process.execPath)
  assert.deepEqual(h.siblingCalls[0]!.args, [
    joinDir(CLONE_SCRIPT_DIR, 'bgos-pair.mjs'),
    'BGOS-7F3A-2K',
    '--assistant-id',
    '901',
  ])
})

test('runSetup: a marketplace already added does NOT abort the run (the && chain did)', async () => {
  // The regression this subcommand also fixes: `add` fails on a machine that
  // already has the marketplace, which is every machine connecting a SECOND
  // agent, and the old `&&` chain then never reached install or pair.
  const h = setupHarness([1, 0])
  const code = await h.run(['BGOS-7F3A-2K'])
  assert.equal(code, 0)
  assert.equal(h.claudeCalls.length, 2)
  assert.equal(h.siblingCalls.length, 1)
  assert.ok(h.prints.some((line) => /already there/.test(line)))
})

test('runSetup: a failed install stops before pairing and says so', async () => {
  const h = setupHarness([0, 24])
  const code = await h.run(['BGOS-7F3A-2K'])
  assert.equal(code, 24)
  assert.equal(h.siblingCalls.length, 0)
  assert.ok(h.errs.some((line) => line.includes(HOAI_PLUGIN_REF)))
})

test('runSetup: no claude on this machine stops at step one with 127', async () => {
  // spawnClaude has already printed the install hint; repeating it through
  // two more failing steps would only bury it.
  const h = setupHarness([EXIT_NOT_FOUND])
  const code = await h.run(['BGOS-7F3A-2K'])
  assert.equal(code, EXIT_NOT_FOUND)
  assert.equal(h.claudeCalls.length, 1)
  assert.equal(h.siblingCalls.length, 0)
})
