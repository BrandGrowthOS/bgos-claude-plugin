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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FOLDER_PIN_FILE,
  EXIT_NOT_FOUND,
  USAGE,
  channelNote,
  classifyRunFlag,
  freshPinnedSessionId,
  relaunchClaudeArgs,
  resolveChannelSpec,
  installHoaiCli,
  main,
  resolveWrapperPluginRoot,
  winPathHelperArgs,
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
  assert.deepEqual(resolveHoaiAction([]), { action: 'run', rest: [], fresh: false })
  assert.deepEqual(resolveHoaiAction(['run']), { action: 'run', rest: [], fresh: false })
  assert.deepEqual(resolveHoaiAction(['doctor', '--verbose']), {
    action: 'doctor',
    rest: ['--verbose'],
    fresh: false,
  })
  assert.deepEqual(resolveHoaiAction(['pair', 'BGOS-7F3A-2K']), {
    action: 'pair',
    rest: ['BGOS-7F3A-2K'],
    fresh: false,
  })
  assert.deepEqual(resolveHoaiAction(['logs']), { action: 'logs', rest: [], fresh: false })
  assert.deepEqual(resolveHoaiAction(['install-cli']), {
    action: 'install-cli',
    rest: [],
    fresh: false,
  })
  assert.deepEqual(resolveHoaiAction(['help']), { action: 'help', rest: [], fresh: false })
  assert.deepEqual(resolveHoaiAction(['-h']), { action: 'help', rest: [], fresh: false })
  assert.deepEqual(resolveHoaiAction(['--help']), { action: 'help', rest: [], fresh: false })
})

test('resolveHoaiAction: -c, --continue and --resume are synonyms of a bare hoai', () => {
  // The gap KC hit: these three PRINTED THE HELP, so a user who typed the
  // spelling they know got a dead end instead of their agent. They route to
  // run, and they are deliberately identical to each other and to bare hoai:
  // the run path already resumes this agent's OWN pinned session.
  const bare = resolveHoaiAction([])
  for (const flag of ['-c', '--continue', '--resume', '-C', '--RESUME']) {
    assert.deepEqual(resolveHoaiAction([flag]), bare, `${flag} routes exactly like a bare hoai`)
  }
  // Also accepted after the explicit `run` verb.
  assert.deepEqual(resolveHoaiAction(['run', '--continue']), bare)
})

test('resolveHoaiAction: --new routes to run and asks for a fresh session', () => {
  assert.deepEqual(resolveHoaiAction(['--new']), { action: 'run', rest: [], fresh: true })
  assert.deepEqual(resolveHoaiAction(['run', '--new']), { action: 'run', rest: [], fresh: true })
  assert.deepEqual(resolveHoaiAction(['--NEW']), { action: 'run', rest: [], fresh: true })
  // The resume synonyms are NOT fresh; that is the whole distinction.
  assert.equal(resolveHoaiAction(['-c']).fresh, false)
})

test('classifyRunFlag: only the documented flags classify', () => {
  assert.equal(classifyRunFlag('-c'), 'resume')
  assert.equal(classifyRunFlag('--continue'), 'resume')
  assert.equal(classifyRunFlag('--resume'), 'resume')
  assert.equal(classifyRunFlag('--new'), 'new')
  for (const other of ['', null, undefined, '-n', '--continue-please', 'continue', 'new', '--fresh']) {
    assert.equal(classifyRunFlag(other), null, `${String(other)} is not a run flag`)
  }
})

test('resolveHoaiAction: a bare pair code routes to pair with itself prepended', () => {
  assert.deepEqual(resolveHoaiAction(['BGOS-7F3A-2K']), {
    action: 'pair',
    rest: ['BGOS-7F3A-2K'],
    fresh: false,
  })
  // Case insensitive prefix, and trailing flags ride along after the code.
  assert.deepEqual(resolveHoaiAction(['oc-abc-12', '--backend', 'http://x']), {
    action: 'pair',
    rest: ['oc-abc-12', '--backend', 'http://x'],
    fresh: false,
  })
})

test('resolveHoaiAction: anything else routes to help, keeping the tokens', () => {
  assert.deepEqual(resolveHoaiAction(['status']), {
    action: 'help',
    rest: ['status'],
    fresh: false,
  })
  assert.deepEqual(resolveHoaiAction(['--nonsense', 'x']), {
    action: 'help',
    rest: ['--nonsense', 'x'],
    fresh: false,
  })
  // A dashed token that is NOT a pair code is not mistaken for one.
  assert.deepEqual(resolveHoaiAction(['BOGUS-1234']), {
    action: 'help',
    rest: ['BOGUS-1234'],
    fresh: false,
  })
  // An unknown flag that merely LOOKS like one of the new run flags still
  // reaches help rather than silently launching the agent.
  assert.deepEqual(resolveHoaiAction(['--continue-later']), {
    action: 'help',
    rest: ['--continue-later'],
    fresh: false,
  })
})

test('USAGE: says the run flags are the same thing, and gives the short restart line', () => {
  // Task 3: the manual restart instruction is /exit then hoai, not a claude
  // command line with flags a user can get wrong.
  assert.match(USAGE, /type \/exit, then run hoai from the same folder/)
  assert.ok(!/--dangerously-load-development-channels/.test(USAGE), 'no raw channel flag in the help')
  // The synonyms are named as synonyms, and --new is offered as the way out.
  assert.match(USAGE, /--continue and\s*\n?\s*--resume/)
  assert.match(USAGE, /hoai --new/)
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
    fresh: false,
  })
  assert.deepEqual(
    resolveHoaiAction(['SETUP', 'BGOS-7F3A-2K', '--assistant-id', '901']),
    { action: 'setup', rest: ['BGOS-7F3A-2K', '--assistant-id', '901'], fresh: false },
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

/** Harness: records the claude arg vectors and the sibling-script spawns.
 *  The PATH step is stubbed: it is covered on its own in
 *  test/hoai-wrapper-install.test.ts, and it must never touch a real home. */
function setupHarness(claudeCodes: number[]) {
  const claudeCalls: string[][] = []
  const siblingCalls: { file: string; args: string[] }[] = []
  const prints: string[] = []
  const errs: string[] = []
  const order: string[] = []
  let claudeIdx = 0
  return {
    claudeCalls,
    siblingCalls,
    prints,
    errs,
    order,
    run: (pairArgs: string[]) =>
      runSetup(pairArgs, {
        platform: 'linux',
        env: {},
        home: POSIX_HOME,
        scriptDir: CLONE_SCRIPT_DIR,
        spawnImpl: ((file: string, args: readonly string[]) => {
          order.push('pair')
          siblingCalls.push({ file, args: [...args] })
          return scriptedChild(0)
        }) as never,
        spawnClaudeImpl: (async (args: readonly string[]) => {
          claudeCalls.push([...args])
          return claudeCodes[claudeIdx++] ?? 0
        }) as never,
        installCliImpl: (async () => {
          order.push('install-cli')
          return { ok: true, binDir: `${POSIX_HOME}/.local/bin` }
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

test('runSetup: marketplace, install, PATH, pair, in that order and with no shell', async () => {
  const h = setupHarness([0, 0])
  const code = await h.run(['BGOS-7F3A-2K', '--assistant-id', '901'])
  assert.equal(code, 0)
  assert.deepEqual(h.claudeCalls, [
    ['plugin', 'marketplace', 'add', HOAI_MARKETPLACE],
    ['plugin', 'install', HOAI_PLUGIN_REF],
  ])
  // The PATH step runs BEFORE pairing, so that pairing's own closing line
  // ("run hoai from this folder") is true by the time the user reads it.
  assert.deepEqual(h.order, ['install-cli', 'pair'])
  // The last step runs bgos-pair under THIS node, with the pair argv untouched.
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

// -- Putting `hoai` itself on PATH --------------------------------------------
//
// KC, 2026-08-25: aliases created automatically at install, so people can type
// one word. The one-click bootstrap already installed the shim; the CLI
// onboarding path (`hoai setup <CODE>`, the line the app hands out) did not.

test('resolveWrapperPluginRoot: the MARKETPLACE install path wins over this script own root', async () => {
  // The npx trap: `npx --package github:... hoai setup <CODE>` runs from a temp
  // directory that is deleted the moment setup returns, so a shim pointed at
  // this script's own root would be dead on arrival. The recorded marketplace
  // install path outlives the process, and is the very path a later one-click
  // update re-points the shim to (update-executor refreshAlias).
  const installPath = '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3'
  const root = await resolveWrapperPluginRoot({
    env: {},
    home: POSIX_HOME,
    scriptDir: '/tmp/npx-cache-3f9a/node_modules/claude-channel-bgos/bin',
    exists: ((path: string) => path === installPath) as never,
    observe: (async () => ({ installed: { installPath } })) as never,
  })
  assert.equal(root, installPath)
})

test('resolveWrapperPluginRoot: falls back to this script own root when nothing is recorded', async () => {
  const root = await resolveWrapperPluginRoot({
    env: {},
    home: POSIX_HOME,
    scriptDir: CLONE_SCRIPT_DIR,
    exists: (() => false) as never,
    observe: (async () => ({ installed: { installPath: null } })) as never,
  })
  assert.equal(root, '/home/kc/bgos-claude-plugin')
})

test('resolveWrapperPluginRoot: an install path recorded but no longer on disk is not used', async () => {
  const root = await resolveWrapperPluginRoot({
    env: {},
    home: POSIX_HOME,
    scriptDir: CLONE_SCRIPT_DIR,
    exists: (() => false) as never,
    observe: (async () => ({ installed: { installPath: '/gone/hoai/0.1.0' } })) as never,
  })
  assert.equal(root, '/home/kc/bgos-claude-plugin')
})

test('resolveWrapperPluginRoot: an unreadable config dir never throws', async () => {
  const root = await resolveWrapperPluginRoot({
    env: {},
    home: POSIX_HOME,
    scriptDir: CLONE_SCRIPT_DIR,
    exists: (() => false) as never,
    observe: (async () => {
      throw new Error('EACCES')
    }) as never,
  })
  assert.equal(root, '/home/kc/bgos-claude-plugin')
})

test('installHoaiCli: hands the resolved root to the installer and reports the bin dir', async () => {
  const prints: string[] = []
  const seen: { pluginRoot?: string } = {}
  const outcome = await installHoaiCli({
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    scriptDir: CLONE_SCRIPT_DIR,
    resolveRoot: async () => '/home/kc/bgos-claude-plugin',
    installImpl: ((opts: { pluginRoot: string }) => {
      seen.pluginRoot = opts.pluginRoot
      return {
        ok: true,
        binDir: '/home/kc/.local/bin',
        wrote: ['/home/kc/.local/bin/hoai'],
        notes: [],
        onPath: false,
        profiles: ['/home/kc/.zshrc'],
      }
    }) as never,
    print: (line: string) => prints.push(line),
  })
  assert.equal(outcome.ok, true)
  assert.equal(seen.pluginRoot, '/home/kc/bgos-claude-plugin')
  assert.ok(prints.some((line) => line.includes('/home/kc/.local/bin')))
  assert.ok(prints.some((line) => line.includes('.zshrc')))
})

test('installHoaiCli: no resolvable plugin root says so instead of writing a broken shim', async () => {
  const prints: string[] = []
  const outcome = await installHoaiCli({
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    resolveRoot: async () => '',
    installImpl: (() => {
      throw new Error('must not be called')
    }) as never,
    print: (line: string) => prints.push(line),
  })
  assert.equal(outcome.ok, false)
  assert.ok(prints.some((line) => /could not work out where the plugin lives/.test(line)))
})

// -- The run path, end to end -------------------------------------------------
//
// The safety property the new flags must not break: `claude --continue` resumes
// whatever conversation is NEWEST in the folder, which in a shared fleet folder
// brought several agents up as the same assistant, fought over one pairing and
// drained the account (2026-08-23). `hoai -c` therefore means "bring THIS agent
// back as itself" and is implemented through the pinned-session path, so no
// spelling of it may ever put a bare --continue on claude's command line.

/** The claude argv from one recorded spawn, whichever route the launch took:
 *  directly, or under `expect -c <script>` when this machine has expect (the
 *  dev-channels gate auto-accept). The expect script brace-quotes each arg. */
function claudeArgsFrom(record: { file: string; args: string[] }): string[] {
  if (record.file !== 'expect') return record.args
  const line = /^spawn claude (.*)$/m.exec(record.args[1] ?? '')?.[1] ?? ''
  return [...line.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]!)
}

/** A throwaway home + agent folder with a baked folder pin, so main() runs the
 *  full supervised path (state dir, session pin) without touching a real home. */
function tempAgentFolder(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'hoai-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-agent-'))
  writeFileSync(join(cwd, FOLDER_PIN_FILE), '871\n')
  return { home, cwd }
}

async function runMainCapturingSpawns(argv: string[], home: string, cwd: string) {
  const spawns: { file: string; args: string[] }[] = []
  const code = await main(argv, {
    platform: 'linux',
    env: {},
    home,
    cwd,
    scriptDir: CLONE_SCRIPT_DIR,
    spawnImpl: ((file: string, args: readonly string[]) => {
      spawns.push({ file, args: [...args] })
      return scriptedChild(0)
    }) as never,
  })
  return { code, spawns }
}

test('the run path never passes a bare --continue to claude, for ANY of the new forms', async () => {
  for (const argv of [[], ['-c'], ['--continue'], ['--resume'], ['--new'], ['run', '--continue']]) {
    const { home, cwd } = tempAgentFolder()
    const { code, spawns } = await runMainCapturingSpawns(argv, home, cwd)
    const label = argv.length ? `hoai ${argv.join(' ')}` : 'hoai'
    assert.equal(code, 0, `${label} exits with the child's code`)
    assert.equal(spawns.length, 1, `${label} launches exactly once`)
    const args = claudeArgsFrom(spawns[0]!)
    assert.equal(args.includes('--continue'), false, `${label} must not forward --continue`)
    assert.equal(args.includes('-c'), false, `${label} must not forward -c`)
    // It resumes by PINNED ID instead: that is what makes it identity safe.
    assert.equal(args.includes('--session-id'), true, `${label} pins its own session id`)
    assert.ok(args.includes('server:bgos'), `${label} still carries the detected channel spec`)
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('hoai -c resumes THIS agent own pinned session, and --new leaves it for a brand new one', async () => {
  const { home, cwd } = tempAgentFolder()
  const sessionIdPath = join(home, '.bgos-agent', '871', 'session-id')
  try {
    // First launch: no pin yet, so one is minted and the session is created by id.
    const first = await runMainCapturingSpawns([], home, cwd)
    const pinned = readFileSync(sessionIdPath, 'utf8').trim()
    assert.deepEqual(claudeArgsFrom(first.spawns[0]!).slice(-2), ['--session-id', pinned])

    // Pretend that session wrote its transcript, so it can be resumed.
    const projects = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${pinned}.jsonl`), '{}\n')

    // `hoai -c` brings the agent back AS ITSELF: same pin, resumed by id.
    const again = await runMainCapturingSpawns(['-c'], home, cwd)
    assert.deepEqual(claudeArgsFrom(again.spawns[0]!).slice(-2), ['--resume', pinned])
    assert.equal(readFileSync(sessionIdPath, 'utf8').trim(), pinned, 'the pin is unchanged')

    // `hoai --new` repins to a DIFFERENT id and creates that one, so the stuck
    // conversation is left behind instead of being resumed forever.
    const fresh = await runMainCapturingSpawns(['--new'], home, cwd)
    const repinned = readFileSync(sessionIdPath, 'utf8').trim()
    assert.notEqual(repinned, pinned, '--new mints a new pinned session id')
    assert.deepEqual(claudeArgsFrom(fresh.spawns[0]!).slice(-2), ['--session-id', repinned])
    assert.equal(claudeArgsFrom(fresh.spawns[0]!).includes('--resume'), false)

    // And the new pin sticks: a later bare hoai carries on the NEW conversation.
    writeFileSync(join(projects, `${repinned}.jsonl`), '{}\n')
    const after = await runMainCapturingSpawns([], home, cwd)
    assert.deepEqual(claudeArgsFrom(after.spawns[0]!).slice(-2), ['--resume', repinned])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('freshPinnedSessionId: repins to a NEW id and never falls back to the old one', () => {
  const writes: { path: string; content: string }[] = []
  const id = freshPinnedSessionId({
    path: '/state/session-id',
    writeFile: (path: string, content: string) => {
      writes.push({ path, content })
      return true
    },
    generateId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  })
  assert.equal(id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.deepEqual(writes, [
    { path: '/state/session-id', content: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  ])
  // A failed repin returns '' so the caller launches a plain FRESH session.
  // The one thing --new must never do is resume the session the user just left,
  // so it never reads the old pin as a fallback.
  assert.equal(
    freshPinnedSessionId({
      path: '/state/session-id',
      writeFile: () => false,
      generateId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
    '',
  )
})

test('winPathHelperArgs: runs the repo helper non-interactively for one directory', () => {
  const args = winPathHelperArgs({
    scriptDir: 'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.38.3\\bin',
    binDir: 'C:\\Users\\x\\AppData\\Local\\hoai\\bin',
  })
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\Users\\x\\.claude\\plugins\\cache\\hoai\\hoai\\0.38.3\\bin\\hoai-add-to-path.ps1',
    '-Dir',
    'C:\\Users\\x\\AppData\\Local\\hoai\\bin',
  ])
})

// -- The channel spec: what the FOLDER publishes beats where the FILES live ---
//
// resolveChannelSpec is the fix for a restart instruction that was silently
// wrong for a whole population of agents. `hoai` used to derive the channel
// only from install-method detection, which answers "where do the plugin FILES
// live". That is a PROXY for "how will the channel be loaded", and the proxy
// breaks on the agents that carry their identity and their channel in their
// folder's .mcp.json: on a machine that ALSO has the marketplace plugin
// installed, detection says `marketplace`, hoai launched `plugin:hoai@hoai`,
// and the workspace publishes `bgos`. The session comes up, `claude mcp list`
// says Connected, and not one inbound message is ever delivered.
//
// That population is real, not hypothetical: agent 900 on the BGOS dev Mac has
// its credential ONLY in its folder's .mcp.json, with no credentials-900.json.

/** A readFile stub serving a workspace .mcp.json (and nothing else). */
function mcpServing(cwd: string, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return (requested: string) => (requested === `${cwd}/.mcp.json` ? text : null)
}

/** One .mcp.json declaring a single HOAI server under `name`. */
function hoaiWorkspace(name: string, extraServers: Record<string, unknown> = {}) {
  return {
    mcpServers: {
      [name]: {
        command: 'bun',
        args: ['/home/kc/.bgos-agent/runtime/bgos-daemon-wrapper.mjs'],
        env: { BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1', BGOS_ASSISTANT_ID: '900' },
      },
      ...extraServers,
    },
  }
}

/** A marketplace install on a POSIX home, which is the shape the agent-900
 *  scenario actually has (a Mac). The file-level MARKETPLACE_SCRIPT_DIR is a
 *  win32 path and only reads as marketplace against WIN_HOME. */
const POSIX_MARKETPLACE_SCRIPT_DIR = '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3/bin'

const AGENT_CWD = '/home/kc/.bgos-agent/900-workspace'

test('channel: a workspace .mcp.json WINS over marketplace file detection (the deaf-agent bug)', () => {
  const resolution = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(AGENT_CWD, hoaiWorkspace('bgos')),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  // Detection still SAYS marketplace, and is still reported honestly...
  assert.equal(resolution.method, 'marketplace')
  // ...but the spec comes from what this folder actually publishes.
  assert.equal(resolution.spec, 'server:bgos')
  assert.equal(resolution.source, 'workspace')
  assert.equal(resolution.conflict, false)
})

test('channel: with no .mcp.json the install method still decides, exactly as before', () => {
  // The bootstrap marketplace branch writes NO .mcp.json, so there is nothing
  // to read and the plugin's own location is the only evidence there is.
  const marketplace = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(marketplace.spec, 'plugin:hoai@hoai')
  assert.equal(marketplace.source, 'install-method')

  const clone = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(clone.spec, 'server:bgos')
  assert.equal(clone.source, 'install-method')
})

test('channel: the spec is the entry NAME, so a renamed server still works', () => {
  // Reading beats guessing: keying on the name being `bgos` would defeat the
  // point, since the name is exactly what a user may legitimately have changed.
  const resolution = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(AGENT_CWD, hoaiWorkspace('atlas')),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(resolution.spec, 'server:atlas')
  assert.equal(resolution.serverName, 'atlas')
})

test('channel: somebody else MCP servers are not mistaken for ours', () => {
  // A workspace with only foreign servers declares nothing about our channel.
  const foreign = {
    mcpServers: {
      linear: { command: 'npx', args: ['linear-mcp'], env: { LINEAR_API_KEY: 'x' } },
      github: { command: 'npx', args: ['gh-mcp'] },
    },
  }
  const resolution = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(AGENT_CWD, foreign),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(resolution.spec, 'plugin:hoai@hoai')
  assert.equal(resolution.source, 'install-method')
})

test('channel: ours alongside foreign servers is still found', () => {
  const resolution = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(
      AGENT_CWD,
      hoaiWorkspace('bgos', { linear: { command: 'npx', env: { LINEAR_API_KEY: 'x' } } }),
    ),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(resolution.spec, 'server:bgos')
})

test('channel: TWO of our servers is a conflict that falls back and SAYS so', () => {
  // No single right answer, so do not pick one. Falling back is at least the
  // behavior that shipped before, and the note tells the operator to name one.
  const resolution = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(
      AGENT_CWD,
      hoaiWorkspace('bgos', {
        bgos2: { command: 'bun', env: { BGOS_BACKEND_URL: 'https://other' } },
      }),
    ),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(resolution.spec, 'plugin:hoai@hoai')
  assert.equal(resolution.conflict, true)
  assert.match(channelNote(resolution), /declares MORE than one HOAI server/)
})

test('channel: unreadable or junk .mcp.json never throws, it falls back', () => {
  for (const body of ['', 'not json at all', '{"mcpServers":"nope"}', '[]', 'null']) {
    const resolution = resolveChannelSpec({
      cwd: AGENT_CWD,
      env: {},
      home: POSIX_HOME,
      readFile: mcpServing(AGENT_CWD, body),
      scriptDir: CLONE_SCRIPT_DIR,
    })
    assert.equal(resolution.spec, 'server:bgos', `junk body ${JSON.stringify(body)} falls back`)
    assert.equal(resolution.source, 'install-method')
  }
})

test('channel: a server name that could not be spelled on a command line is refused', () => {
  const resolution = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(AGENT_CWD, hoaiWorkspace('a name with spaces')),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(resolution.source, 'install-method')
})

test('channel: the note names the source, so an operator can see WHY', () => {
  const workspace = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(AGENT_CWD, hoaiWorkspace('bgos')),
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.match(channelNote(workspace), /channel server:bgos \(declared by this folder's \.mcp\.json/)
  const detected = resolveChannelSpec({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: noFiles,
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.match(channelNote(detected), /install method: marketplace; channel plugin:hoai@hoai/)
})

test('buildRunPlan: an .mcp.json workspace on a marketplace host launches the WORKSPACE channel', () => {
  // The end-to-end shape of the bug, through the function that actually builds
  // the argv. Before this change these args ended `plugin:hoai@hoai`.
  const plan = buildRunPlan({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile: mcpServing(AGENT_CWD, hoaiWorkspace('bgos')),
    listDir: noDir,
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.ok && plan.args, [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:bgos',
  ])
  assert.equal(plan.ok && plan.args.includes('plugin:hoai@hoai'), false)
})

test('relaunchClaudeArgs: a restart resolves the channel the SAME way as the launch', () => {
  // The marker relaunch is unattended. If it resolved the channel differently
  // from the first launch, the agent would come back deaf on a spec it was
  // never listening on and nobody would be watching when it happened.
  const readFile = mcpServing(AGENT_CWD, hoaiWorkspace('bgos'))
  const launch = buildRunPlan({
    cwd: AGENT_CWD,
    env: {},
    home: POSIX_HOME,
    readFile,
    listDir: noDir,
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
  })
  const relaunch = relaunchClaudeArgs({
    scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
    env: {},
    home: POSIX_HOME,
    cwd: AGENT_CWD,
    readFile,
    sessionArgs: ['--resume', 'abc-123'],
  })
  assert.deepEqual(relaunch, [...(launch.ok ? launch.args : []), '--resume', 'abc-123'])
  assert.ok(relaunch.includes('server:bgos'))
  assert.equal(relaunch.includes('plugin:hoai@hoai'), false)
})
