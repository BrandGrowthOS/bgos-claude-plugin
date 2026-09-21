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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MCP_CONFIG_FILE_NAME } from '../lib/service-supervision.mjs'
import * as hoaiCore from '../bin/hoai-core.mjs'
import {
  FOLDER_PIN_FILE,
  EXIT_NOT_FOUND,
  EXIT_INCUMBENT_TIMEOUT,
  INCUMBENT_WAIT_TIMEOUT_MS,
  PROCESS_PROBE_TIMEOUT_MS,
  defaultListProcesses,
  selfAndAncestorPids,
  incumbentBlocks,
  USAGE,
  channelNote,
  classifyRunFlag,
  freshPinnedSessionId,
  findIncumbentClaude,
  waitForIncumbent,
  relaunchClaudeArgs,
  resolveChannelSpec,
  installHoaiCli,
  main,
  resolveWrapperPluginRoot,
  winPathHelperArgs,
  resolveHoaiAction,
  buildRunPlan,
  readFolderPin,
  readFolderDeclaredId,
  superviseAssistantId,
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
  launchArgsFor,
  unresolvedChannelMessage,
  LAUNCH_ENV,
  hookRegistrationFor,
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
  assert.deepEqual(resolveHoaiAction([]), { action: 'run', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['run']), { action: 'run', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['doctor', '--verbose']), {
    action: 'doctor',
    rest: ['--verbose'],
    fresh: false,
    force: false,
  })
  assert.deepEqual(resolveHoaiAction(['pair', 'BGOS-7F3A-2K']), {
    action: 'pair',
    rest: ['BGOS-7F3A-2K'],
    fresh: false,
    force: false,
  })
  assert.deepEqual(resolveHoaiAction(['logs']), { action: 'logs', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['install-cli']), {
    action: 'install-cli',
    rest: [],
    fresh: false,
    force: false,
  })
  assert.deepEqual(resolveHoaiAction(['help']), { action: 'help', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['-h']), { action: 'help', rest: [], fresh: false, force: false })
  assert.deepEqual(resolveHoaiAction(['--help']), { action: 'help', rest: [], fresh: false, force: false })
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
  assert.deepEqual(resolveHoaiAction(['--new']), { action: 'run', rest: [], fresh: true, force: false })
  assert.deepEqual(resolveHoaiAction(['run', '--new']), { action: 'run', rest: [], fresh: true, force: false })
  assert.deepEqual(resolveHoaiAction(['--NEW']), { action: 'run', rest: [], fresh: true, force: false })
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
    force: false,
  })
  // Case insensitive prefix, and trailing flags ride along after the code.
  assert.deepEqual(resolveHoaiAction(['oc-abc-12', '--backend', 'http://x']), {
    action: 'pair',
    rest: ['oc-abc-12', '--backend', 'http://x'],
    fresh: false,
    force: false,
  })
})

test('resolveHoaiAction: anything else routes to help, keeping the tokens', () => {
  assert.deepEqual(resolveHoaiAction(['status']), {
    action: 'help',
    rest: ['status'],
    fresh: false,
    force: false,
  })
  assert.deepEqual(resolveHoaiAction(['--nonsense', 'x']), {
    action: 'help',
    rest: ['--nonsense', 'x'],
    fresh: false,
    force: false,
  })
  // A dashed token that is NOT a pair code is not mistaken for one.
  assert.deepEqual(resolveHoaiAction(['BOGUS-1234']), {
    action: 'help',
    rest: ['BOGUS-1234'],
    fresh: false,
    force: false,
  })
  // An unknown flag that merely LOOKS like one of the new run flags still
  // reaches help rather than silently launching the agent.
  assert.deepEqual(resolveHoaiAction(['--continue-later']), {
    action: 'help',
    rest: ['--continue-later'],
    fresh: false,
    force: false,
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

// ── the activity rail travels in the run plan ──────────────────────────
//
// hoai is the launcher an agent folder actually starts with, day after day. It
// carried neither the task tools flag (so the live Steps strip stayed empty for
// ever, while everything else on the rail worked) nor the clone hook entries (so
// a folder scaffolded before the rail existed never gained it). Both are part of
// HOW this folder launches, so both belong in the plan.

test('buildRunPlan: a clone launch carries the task tools flag AND the hook entries', () => {
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
  assert.deepEqual(plan.env, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })
  assert.deepEqual(plan.hooks, {
    settingsPath: `${cwd}/.claude/settings.local.json`,
    forwarderPath: `${CLONE_SCRIPT_DIR}/hoai-hook.mjs`,
  })
})

test('buildRunPlan: a marketplace launch registers nothing, so no hook fires twice', () => {
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
  assert.equal(plan.hooks, null, 'a marketplace install already reads its own hooks/hooks.json')
  assert.deepEqual(plan.env, { ...LAUNCH_ENV }, 'but it still needs the task tools')
})

test('hookRegistrationFor names the workspace settings file and this checkout\u2019s forwarder', () => {
  assert.deepEqual(hookRegistrationFor({ cwd: '/w/a', scriptDir: '/p/bin', method: 'clone' }), {
    settingsPath: '/w/a/.claude/settings.local.json',
    forwarderPath: '/p/bin/hoai-hook.mjs',
  })
  assert.equal(hookRegistrationFor({ cwd: '/w/a', scriptDir: '/p/bin', method: 'marketplace' }), null)
  assert.equal(hookRegistrationFor({ cwd: '/w/a', scriptDir: '', method: 'clone' }), null)
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
    force: false,
  })
  assert.deepEqual(
    resolveHoaiAction(['SETUP', 'BGOS-7F3A-2K', '--assistant-id', '901']),
    { action: 'setup', rest: ['BGOS-7F3A-2K', '--assistant-id', '901'], fresh: false, force: false },
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
  const enrolments: { configDir: string; marketplace: string }[] = []
  let claudeIdx = 0
  return {
    claudeCalls,
    siblingCalls,
    prints,
    errs,
    order,
    enrolments,
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
          // Recorded in `order` as well, so the position of the marketplace add is assertable
          // against the enrolment below. Naming the subcommand keeps the sequence readable.
          order.push(`claude:${args.slice(0, 3).join(' ')}`)
          return claudeCodes[claudeIdx++] ?? 0
        }) as never,
        // Stubbed for two reasons. It makes the ORDER assertable, which is the point: the enrolment
        // must run after the marketplace add, because the add rewrites the entry to just its source
        // and silently undoes an earlier write. And it stops this harness invoking the REAL
        // ensureMarketplaceAutoUpdate against a fake home, which was harmless only because the
        // no-entry guard happened to short-circuit before any write.
        ensureAutoUpdateImpl: ((opts: { configDir: string; marketplace: string }) => {
          order.push('autoupdate')
          enrolments.push(opts)
          return { changed: true, reason: 'set' }
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
  // The full sequence, not just the two sibling steps. The auto-update enrolment sits between the
  // marketplace add and the install on purpose: the add erases the key it writes, so writing it
  // earlier is a silent no-op, and that is the whole reason this feature can fail invisibly.
  assert.deepEqual(h.order, [
    'claude:plugin marketplace add',
    'autoupdate',
    'claude:plugin install hoai@hoai',
    'install-cli',
    'pair',
  ])
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

// -- Ask or announce, never silently replace (KC, 2026-09-21) ----------------

function installHoaiCliWith(kept: unknown[], force = false) {
  const prints: string[] = []
  const seen: { force?: boolean } = {}
  return installHoaiCli({
    platform: 'linux',
    env: {},
    home: POSIX_HOME,
    scriptDir: CLONE_SCRIPT_DIR,
    force,
    resolveRoot: async () => '/home/kc/bgos-claude-plugin',
    installImpl: ((opts: { force?: boolean }) => {
      seen.force = opts.force
      return {
        ok: true,
        binDir: '/home/kc/.local/bin',
        wrote: kept.length > 0 ? [] : ['/home/kc/.local/bin/hoai'],
        notes: [],
        onPath: true,
        profiles: [],
        kept,
      }
    }) as never,
    print: (line: string) => prints.push(line),
  }).then((outcome) => ({ outcome, text: prints.join('\n'), seen }))
}

test('installHoaiCli: a shim left alone is ANNOUNCED, never passed over in silence', async () => {
  // The whole failure mode this guards. installWrapper declines to re-point a
  // shim another install owns, and the only write-side print is guarded on
  // wrote.length, so without this block the command would report success,
  // write nothing, say nothing, and leave the owner with no idea which install
  // their `hoai` actually runs. Silence is the one unacceptable outcome here.
  const { outcome, text } = await installHoaiCliWith([
    {
      path: '/home/kc/.local/bin/hoai',
      pointsAt: '/home/kc/other-checkout/bin/hoai',
      wanted: '/home/kc/bgos-claude-plugin/bin/hoai',
      reason: 'foreign-link',
    },
  ])
  assert.equal(outcome.ok, true, 'declining is not a failure')
  assert.match(text, /already points at \/home\/kc\/other-checkout\/bin\/hoai/)
  // It must say WHICH ONE WINS when the owner types the word.
  assert.match(text, /typing hoai will NOT run it/)
  assert.match(text, /\/home\/kc\/bgos-claude-plugin\/bin\/hoai/)
  // And hand back the deliberate command rather than leaving them stuck.
  assert.match(text, /hoai install-cli --force/)
  assert.equal(outcome.kept.length, 1, 'the caller can see it too, not only the reader')
})

test("installHoaiCli: a file the owner wrote gets its own wording, not a link's", async () => {
  const { text } = await installHoaiCliWith([
    {
      path: '/home/kc/.local/bin/hoai',
      pointsAt: '/home/kc/.local/bin/hoai',
      wanted: '/home/kc/bgos-claude-plugin/bin/hoai',
      reason: 'foreign-file',
    },
  ])
  assert.match(text, /is not a link this install made/)
  assert.doesNotMatch(text, /already points at/)
  assert.match(text, /hoai install-cli --force/)
})

test('installHoaiCli: nothing in the way means nothing is announced', async () => {
  // The control: a gate that always announced would look identical above.
  const { text, outcome } = await installHoaiCliWith([])
  assert.doesNotMatch(text, /left alone/)
  assert.doesNotMatch(text, /--force/)
  assert.deepEqual(outcome.kept, [])
})

test('installHoaiCli: force is carried through to the installer, not swallowed', async () => {
  assert.equal((await installHoaiCliWith([], true)).seen.force, true)
  assert.equal((await installHoaiCliWith([], false)).seen.force, false)
})

test('main(): install-cli --force is the deliberate ask, and a bare install-cli is not', async () => {
  const runs: boolean[] = []
  const run = (argv: string[]) =>
    main(argv, {
      platform: 'linux',
      env: {},
      home: POSIX_HOME,
      scriptDir: CLONE_SCRIPT_DIR,
      installCliImpl: (async (o: { force?: boolean }) => {
        runs.push(o.force === true)
        return { ok: true, binDir: '/home/kc/.local/bin', kept: [] }
      }) as never,
    } as never)

  assert.equal(await run(['install-cli']), 0)
  assert.equal(await run(['install-cli', '--force']), 0)
  assert.equal(await run(['install-cli', '--FORCE']), 0, 'the flag is not case sensitive')
  // A bare install-cli must NEVER arrive as force: that is the whole rule.
  assert.deepEqual(runs, [false, true, true])
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

// -- the launcher-side identity seam: .mcp.json is a source, not just the pin --

/**
 * The layout EVERY agent folder on the BGOS dev Mac actually has, and the one
 * `bgos-agent install --key --user` and `bgos-claim` produce: the id lives in
 * `.mcp.json` beside the API key, there is NO `.bgos-agent-id`, and there is
 * no `credentials-<id>.json` for it either.
 *
 * The trap this pins: Claude Code injects an MCP entry's `env` block into the
 * DAEMON's process environment, so the daemon finds BGOS_ASSISTANT_ID there.
 * `hoai` runs OUTSIDE claude, so its own env never has it. A launcher-side
 * reader that consults only the pin and the env therefore comes back empty for
 * a whole supported class of agent.
 */
function mcpOnlyFolder(cwd: string, assistantId: string, sep = '/') {
  return JSON.stringify({
    mcpServers: {
      bgos: {
        command: 'bun',
        args: [`${cwd}${sep}server.ts`],
        env: {
          BGOS_BACKEND_URL: 'https://api.brandgrowthos.ai/api/v1',
          BGOS_API_KEY: 'sk-live-do-not-leak-me',
          BGOS_ASSISTANT_ID: assistantId,
        },
      },
    },
  })
}

/** A host with MANY paired agents, so the sole-credentials fallback cannot fire. */
const CROWDED_HOME_DIR = (home: string) => ({
  [`${home}/.bgos-agent`]: [
    'credentials-901.json',
    'credentials-910.json',
    'credentials-918.json',
    'credentials-929.json',
  ],
})

function crowdedListDir(home: string) {
  const map = CROWDED_HOME_DIR(home)
  return (p: string) => (p in map ? map[p]! : [])
}

function serveMcpOnly(cwd: string, assistantId: string) {
  const mcpPath = `${cwd}/${MCP_CONFIG_FILE_NAME}`
  const body = mcpOnlyFolder(cwd, assistantId)
  return (p: string) => (p === mcpPath ? body : null)
}

test('superviseAssistantId: an agent declared only in .mcp.json IS supervised', () => {
  const cwd = '/home/kc/BGOS'
  // Before this, all three launcher readers came back empty here, so the agent
  // ran with no supervisor.json and therefore no launcher restart authority.
  assert.equal(
    superviseAssistantId({
      cwd,
      env: {},
      home: POSIX_HOME,
      readFile: serveMcpOnly(cwd, '900'),
      listDir: crowdedListDir(POSIX_HOME),
    }),
    '900',
  )
  // The pin still wins when both are present and agree, and an env pin still
  // answers for a folder that declares nothing.
  const pinPath = `${cwd}/${FOLDER_PIN_FILE}`
  assert.equal(
    superviseAssistantId({
      cwd,
      env: {},
      home: POSIX_HOME,
      readFile: (p: string) => (p === pinPath ? '900\n' : serveMcpOnly(cwd, '900')(p)),
      listDir: crowdedListDir(POSIX_HOME),
    }),
    '900',
  )
  assert.equal(
    superviseAssistantId({
      cwd,
      env: { BGOS_ASSISTANT_ID: '777' },
      home: POSIX_HOME,
      readFile: () => null,
      listDir: crowdedListDir(POSIX_HOME),
    }),
    '777',
  )
  // A folder declaring nothing on a crowded host still supervises nothing.
  assert.equal(
    superviseAssistantId({
      cwd,
      env: {},
      home: POSIX_HOME,
      readFile: () => null,
      listDir: crowdedListDir(POSIX_HOME),
    }),
    '',
  )
})

test('superviseAssistantId: a folder declaring TWO different ids supervises neither', () => {
  const cwd = '/home/kc/BGOS'
  const pinPath = `${cwd}/${FOLDER_PIN_FILE}`
  assert.equal(
    superviseAssistantId({
      cwd,
      env: {},
      home: POSIX_HOME,
      readFile: (p: string) => (p === pinPath ? '777\n' : serveMcpOnly(cwd, '900')(p)),
      listDir: crowdedListDir(POSIX_HOME),
    }),
    '',
  )
})

test('buildRunPlan: launches an agent declared only in .mcp.json, and names that source', () => {
  const cwd = '/home/kc/BGOS'
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: POSIX_HOME,
    readFile: serveMcpOnly(cwd, '900'),
    listDir: crowdedListDir(POSIX_HOME),
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, true)
  if (!plan.ok) return
  assert.match(plan.note, /assistant 900/)
  // Telling the user the folder "has no .bgos-agent-id pin" would send them
  // looking for a file that was never supposed to exist here.
  assert.match(plan.note, /\.mcp\.json/)
  assert.equal(plan.note.includes('folder pin'), false)
  // The secret sitting beside the id must never reach an operator-facing line.
  assert.equal(plan.note.includes('sk-live-do-not-leak-me'), false)
})

test('buildRunPlan: a folder declaring two different ids is refused as a CONFLICT, not a missing pin', () => {
  const cwd = '/home/kc/BGOS'
  const pinPath = `${cwd}/${FOLDER_PIN_FILE}`
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: POSIX_HOME,
    readFile: (p: string) => (p === pinPath ? '777\n' : serveMcpOnly(cwd, '900')(p)),
    listDir: crowdedListDir(POSIX_HOME),
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, false)
  if (plan.ok) return
  assert.match(plan.reason, /TWO different assistant ids/)
  assert.match(plan.reason, /will not guess/)
})

test('buildRunPlan: the multi-agent refusal names BOTH folder sources, not only the pin', () => {
  const cwd = '/home/kc/nowhere'
  const plan = buildRunPlan({
    cwd,
    env: {},
    home: POSIX_HOME,
    readFile: () => null,
    listDir: crowdedListDir(POSIX_HOME),
    scriptDir: CLONE_SCRIPT_DIR,
  })
  assert.equal(plan.ok, false)
  if (plan.ok) return
  assert.match(plan.reason, /4 paired agents/)
  // The DIAGNOSIS has to name both sources, not just the pin file. Matching
  // /\.mcp\.json/ alone cannot discriminate: the remedy sentence mentions it
  // too, so a refusal that blamed only the missing pin would still pass.
  assert.match(plan.reason, /declares no assistant \(no \.bgos-agent-id pin and no BGOS_ASSISTANT_ID in \.mcp\.json\)/)
})

test('logsAssistantId: keyed by what the folder declares, from either source', () => {
  const cwd = '/home/kc/BGOS'
  assert.equal(logsAssistantId({ cwd, env: {}, readFile: serveMcpOnly(cwd, '900') }), '900')
  assert.equal(logsAssistantId({ cwd, env: {}, readFile: () => null }), 'unknown')
})

// ── Reached through npx: no channel, no launch (2026-08-24) ──────────────────
//
// The app's connect screen hands every new user
//   npx -y --package github:BrandGrowthOS/bgos-claude-plugin hoai setup <CODE>
// and the manual restart advice is "run hoai". When `hoai` is reached through
// npx, scriptDir is npm's throwaway unpack dir
//   /Users/alex/.npm/_npx/<hash>/node_modules/claude-channel-bgos/bin
// which is not under the plugins dir. Detection used to read that as a local
// checkout and launch `server:bgos`; on a marketplace install that connects
// nothing and drops every inbound message with no error anywhere. The folder
// in that flow publishes no .mcp.json either (a marketplace bootstrap writes
// none), so PR #90's workspace preference has nothing to prefer.

/** npm's real npx unpack shape, off a user's own doctor output. */
const NPX_SCRIPT_DIR = '/Users/alex/.npm/_npx/c00bcfc5e22688dd/node_modules/claude-channel-bgos/bin'
const NPX_HOME = '/Users/alex'
const NPX_CWD = '/Users/alex/my-agent'

test('channel: hoai reached through npx with no install on disk resolves NO spec', () => {
  const resolution = resolveChannelSpec({
    cwd: NPX_CWD,
    env: {},
    home: NPX_HOME,
    readFile: noFiles,
    scriptDir: NPX_SCRIPT_DIR,
  })
  assert.equal(resolution.method, 'unknown')
  assert.equal(resolution.spec, '', 'an npx run must not resolve a plausible spec')
  assert.notEqual(resolution.spec, 'server:bgos')
  assert.match(resolution.reason, /temporary package-runner directory/)
  assert.match(channelNote(resolution), /UNDETERMINED/)
})

test('channel: a workspace .mcp.json still decides even under npx (nothing regresses for a claimed folder)', () => {
  const resolution = resolveChannelSpec({
    cwd: NPX_CWD,
    env: {},
    home: NPX_HOME,
    readFile: mcpServing(NPX_CWD, hoaiWorkspace('bgos')),
    scriptDir: NPX_SCRIPT_DIR,
  })
  assert.equal(resolution.spec, 'server:bgos')
  assert.equal(resolution.source, 'workspace')
})

test('launchArgsFor THROWS on an unresolved channel rather than spelling an empty flag', () => {
  assert.throws(() => launchArgsFor({ spec: '' } as never), /no channel spec/)
  assert.deepEqual(launchArgsFor({ spec: 'server:bgos' } as never), [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:bgos',
  ])
})

test('buildRunPlan: REFUSES to launch when the channel is undetermined, and says why', () => {
  const plan = buildRunPlan({
    cwd: NPX_CWD,
    env: {},
    home: NPX_HOME,
    readFile: noFiles,
    listDir: noDir,
    scriptDir: NPX_SCRIPT_DIR,
  })
  assert.equal(plan.ok, false, 'a guessed channel must never be launched')
  if (plan.ok) return
  assert.match(plan.reason, /temporary package-runner directory/)
  assert.match(plan.reason, /will not launch on a guessed channel/)
  // And the refusal never leaks a spec the user might copy.
  assert.doesNotMatch(plan.reason, /server:bgos/)
  assert.doesNotMatch(plan.reason, /plugin:hoai@/)
})

test('relaunchClaudeArgs: returns null on an unresolved channel, never a bare flag pair', () => {
  assert.equal(
    relaunchClaudeArgs({
      cwd: NPX_CWD,
      env: {},
      home: NPX_HOME,
      readFile: noFiles,
      scriptDir: NPX_SCRIPT_DIR,
      sessionArgs: ['--resume', 'abc'],
    }),
    null,
  )
  // A resolvable folder relaunches exactly as before.
  assert.deepEqual(
    relaunchClaudeArgs({
      cwd: AGENT_CWD,
      env: {},
      home: POSIX_HOME,
      readFile: mcpServing(AGENT_CWD, hoaiWorkspace('bgos')),
      scriptDir: POSIX_MARKETPLACE_SCRIPT_DIR,
      sessionArgs: ['--resume', 'abc'],
    }),
    ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos', '--resume', 'abc'],
  )
})

test('unresolvedChannelMessage: names the reason and says nothing was launched', () => {
  const message = unresolvedChannelMessage({ reason: 'no install recorded.' })
  assert.match(message, /STOPPING rather than relaunching/)
  assert.match(message, /no install recorded\./)
  assert.doesNotMatch(message, /[\u2013\u2014]/)
})

test('resolveWrapperPluginRoot: never points the hoai shim at an npx dir that is about to be deleted', async () => {
  const root = await resolveWrapperPluginRoot({
    env: {},
    home: NPX_HOME,
    scriptDir: NPX_SCRIPT_DIR,
    exists: () => false,
    observe: async () => ({ installed: { installPath: null } }) as never,
  })
  assert.equal(root, '', 'a dead-on-arrival shim target is worse than no shim')
  // A real clone checkout still yields its own root.
  const cloneRoot = await resolveWrapperPluginRoot({
    env: {},
    home: POSIX_HOME,
    scriptDir: CLONE_SCRIPT_DIR,
    exists: () => false,
    observe: async () => ({ installed: { installPath: null } }) as never,
  })
  assert.equal(cloneRoot, '/home/kc/bgos-claude-plugin')
})


test('setup enrols auto-update AFTER the marketplace add, never before', () => {
  // The ordering the whole self-update feature turns on, and the last thing about it that was
  // unpinned. `claude plugin marketplace add` rewrites the marketplace entry down to just its
  // source, on the fresh branch and the already-registered branch alike, so a key written before the
  // add is silently erased and the machine never updates itself while every step reports success.
  //
  // The code has always had the right order and a comment saying why. Nothing failed if someone
  // moved it.
  const h = setupHarness([0, 0])
  return h.run([]).then(() => {
    const addAt = h.order.findIndex((step) => step.startsWith('claude:plugin marketplace add'))
    const enrolAt = h.order.indexOf('autoupdate')
    assert.notEqual(addAt, -1, 'setup must add the marketplace')
    assert.notEqual(enrolAt, -1, 'setup must enrol this machine in auto-update')
    assert.ok(
      addAt < enrolAt,
      `the add erases the key, so enrolling first is a no-op; order was ${h.order.join(' -> ')}`,
    )
    // And it enrols the marketplace by NAME, not by the repo slug: a machine that registered under
    // another name would otherwise get a key nothing reads.
    assert.deepEqual(h.enrolments.map((e) => e.marketplace), ['hoai'])
  })
})

// A fast fault on the fresh retry must not cost the agent its session.
// Windows fleet migration, zaid, 2026-09-02: a redirected console put claude
// in print mode; the resume died fast, hoai minted a fresh id, wrote it to the
// pin at once, and that session died fast too. The agent was left pinned to a
// dead fresh identity and its real context had to be restored by hand. The pin
// is now committed only once the fresh session has outlived the health window.

async function runSupervisedFastFaults(home: string, cwd: string, exitDelaysMs: number[], healthyMs: number) {
  const spawns: { file: string; args: string[] }[] = []
  const lines: string[] = []
  const t0 = Date.now()
  let n = 0
  const code = await main([], {
    print: (line: string) => {
      lines.push(`${Date.now() - t0}ms ${line}`)
    },
    platform: 'linux',
    env: {},
    home,
    cwd,
    scriptDir: CLONE_SCRIPT_DIR,
    healthyMs,
    spawnImpl: ((file: string, args: readonly string[]) => {
      spawns.push({ file, args: [...args] })
      const delay = exitDelaysMs[n] ?? 0
      n += 1
      lines.push(`${Date.now() - t0}ms SPAWN#${n} ${file} (exits in ${delay}ms)`)
      const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void; stdin: null; stdout: null; stderr: null }
      child.pid = 4242 + n
      child.kill = () => child.emit('exit', 1, null)
      child.stdin = null
      child.stdout = null
      child.stderr = null
      setTimeout(() => child.emit('exit', 1, null), delay)
      return child
    }) as never,
  })
  return { code, spawns, lines }
}

test('a fresh retry that dies inside the health window leaves the pin on the previous session', async () => {
  const { home, cwd } = tempAgentFolder()
  const sessionIdPath = join(home, '.bgos-agent', '871', 'session-id')
  try {
    // Seed a pinned session with a transcript, so the first launch is a --resume.
    const original = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    mkdirSync(join(home, '.bgos-agent', '871'), { recursive: true })
    writeFileSync(sessionIdPath, original)
    const projects = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${original}.jsonl`), '{}\n')

    // Resume dies fast, the fresh retry dies fast too (an environment fault).
    const { spawns } = await runSupervisedFastFaults(home, cwd, [5, 5], 200)
    assert.equal(spawns.length, 2, 'resume, then exactly one fresh retry')
    assert.deepEqual(claudeArgsFrom(spawns[0]!).slice(-2), ['--resume', original])
    assert.equal(claudeArgsFrom(spawns[1]!).includes('--session-id'), true, 'the retry is a fresh create')
    assert.equal(readFileSync(sessionIdPath, 'utf8').trim(), original, 'the pin still names the real session')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a fresh retry that stays up past the health window becomes the pinned session', async () => {
  const { home, cwd } = tempAgentFolder()
  const sessionIdPath = join(home, '.bgos-agent', '871', 'session-id')
  try {
    const original = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    mkdirSync(join(home, '.bgos-agent', '871'), { recursive: true })
    writeFileSync(sessionIdPath, original)
    const projects = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, `${original}.jsonl`), '{}\n')

    // Resume dies fast; the fresh retry lives well past the 50 ms window.
    const { spawns, lines } = await runSupervisedFastFaults(home, cwd, [5, 300], 50)
    assert.equal(spawns.length, 2, lines.join('\n'))
    const fresh = claudeArgsFrom(spawns[1]!)
    const freshId = fresh[fresh.indexOf('--session-id') + 1]
    assert.ok(freshId && freshId !== original, 'a new id was created')
    assert.equal(readFileSync(sessionIdPath, 'utf8').trim(), freshId, `the pin moved to the session that stayed up\n${lines.join('\n')}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Incumbent wait (board row 01a06223, Poseidon 2026-09-02). hoai's singleton
// guard keyed only on supervisor.json, i.e. a live LAUNCHER; a hand-started
// claude in the same folder was invisible to it, so a KeepAlive around hoai
// spawned a second session on the same pinned id. The launcher now waits for
// an incumbent claude in its cwd, by the four rules learned the hard way:
// never pgrep (macOS omits the caller's ancestors), own uid only (only that uid
// can resume the pin), an unreadable cwd within the uid is reported but does
// NOT block (reversed 2026-09-21, see incumbentBlocks), and the caller's own
// claude ancestry is never an incumbent (2026-09-21, see selfAndAncestorPids).

test('findIncumbentClaude: same cwd, same uid, not our own pid', () => {
  const procs = [
    { pid: 10, uid: 501, comm: 'claude', cwd: '/agents/a' },
    { pid: 11, uid: 501, comm: 'node', cwd: '/agents/a' },
    { pid: 12, uid: 502, comm: 'claude', cwd: '/agents/a' },
    { pid: 13, uid: 501, comm: 'claude', cwd: '/agents/b' },
  ]
  assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid: 99 }), { pid: 10, reason: 'same-cwd' })
  assert.equal(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid: 10 }), null)
  assert.equal(findIncumbentClaude({ processes: procs, cwd: '/agents/c', uid: 501, ownPid: 99 }), null)
})

// The title and the comment here used to say an unreadable cwd "counts as
// occupied". That rule was REVERSED on 2026-09-21 and the wording was left
// behind, so the suite still taught the retired rule to whoever read it next
// while every assertion below quietly passed. Nothing about the assertions
// changed: findIncumbentClaude still REPORTS an unreadable hit (as the
// fallback, once no same-cwd process has been found) and the uid scoping is
// unchanged. What moved is only who decides: incumbentBlocks, tested just
// below, is what says an unreadable hit does not hold a launch back.
test('findIncumbentClaude: an unreadable cwd within our uid is still REPORTED; another uid never is', () => {
  const procs = [
    { pid: 20, uid: 502, comm: 'claude', cwd: null },
    { pid: 21, uid: 501, comm: 'claude', cwd: null },
  ]
  assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid: 99 }), { pid: 21, reason: 'unreadable-cwd' })
  assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 502, ownPid: 99 }), { pid: 20, reason: 'unreadable-cwd' })
  assert.equal(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 503, ownPid: 99 }), null, 'another uid is never in scope')
})

test('findIncumbentClaude: claude.exe and a full-path comm both count; a windows-style cwd matches case-insensitively', () => {
  const procs = [
    { pid: 30, uid: 1, comm: 'C:\\Users\\k\\claude.exe', cwd: 'C:\\Users\\k\\agents\\zaid' },
  ]
  assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: 'c:\\users\\k\\agents\\zaid', uid: 1, ownPid: 99 }), { pid: 30, reason: 'same-cwd' })
})

test('waitForIncumbent: returns at once when the folder is clear, otherwise polls until it is and says so', async () => {
  const lines: string[] = []
  let polls = 0
  const lists = [
    [{ pid: 10, uid: 501, comm: 'claude', cwd: '/agents/a' }],
    [{ pid: 10, uid: 501, comm: 'claude', cwd: '/agents/a' }],
    [],
  ]
  const sleeps: number[] = []
  const waited = await waitForIncumbent({
    cwd: '/agents/a',
    uid: 501,
    ownPid: 99,
    listProcesses: () => lists[Math.min(polls++, lists.length - 1)]!,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    print: (l: string) => lines.push(l),
    pollMs: 250,
  })
  assert.deepEqual(waited, { waited: true, polls: 3, lastPid: 10, timedOut: false })
  assert.deepEqual(sleeps, [250, 250])
  assert.ok(lines.some((l) => /waiting for an incumbent claude \(pid 10\)/.test(l)), lines.join('\n'))
  const clear = await waitForIncumbent({ cwd: '/agents/a', uid: 501, ownPid: 99, listProcesses: () => [], sleep: async () => {}, print: () => {}, pollMs: 250 })
  assert.deepEqual(clear, { waited: false, polls: 1, lastPid: null, timedOut: false })
})

test('superviseClaude does not spawn while a hand-started claude owns the folder, and spawns once it exits', async () => {
  const { home, cwd } = tempAgentFolder()
  try {
    let polls = 0
    const spawns: { file: string; args: string[] }[] = []
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      pollMs: 5,
      listProcesses: () => {
        polls += 1
        return polls <= 2 ? [{ pid: 4242, uid: process.getuid?.() ?? 0, comm: 'claude', cwd }] : []
      },
      sleep: async () => {},
      spawnImpl: ((file: string, args: readonly string[]) => {
        spawns.push({ file, args: [...args] })
        return scriptedChild(0)
      }) as never,
    })
    assert.equal(code, 0)
    assert.equal(spawns.length, 1, 'exactly one launch, after the incumbent left')
    assert.ok(polls >= 3, `the incumbent was polled until it left (polls=${polls})`)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The incumbent wait grows an end, a verdict and an escape hatch (2026-09-21).
// As shipped, the wait was `while (true)` with no deadline, and an UNREADABLE
// cwd counted as occupied. Together that stranded a first install: one claude
// under the same uid whose cwd lsof would not show made every hoai launch wait
// forever, reprinting the same notice every thirty seconds, on a machine with
// no second session at all. Three things changed, one test group each: the
// wait ends at INCUMBENT_WAIT_TIMEOUT_MS and says so, an unreadable cwd only
// WARNS, and `hoai --force` skips the check outright. Every clock and every
// sleep here is injected: none of these tests may cost a real second.

test('incumbentBlocks: only a same-cwd hit holds a launch back', () => {
  assert.equal(incumbentBlocks({ pid: 10, reason: 'same-cwd' }), true)
  assert.equal(
    incumbentBlocks({ pid: 11, reason: 'unreadable-cwd' }),
    false,
    'an unreadable cwd is an absence of evidence, not evidence of a conflict',
  )
  assert.equal(incumbentBlocks(null), false)
})

test('findIncumbentClaude: a real same-cwd process wins over an earlier unreadable one', () => {
  // ps order is not ours to choose. If the unreadable process short-circuited
  // the scan it would hide the genuine incumbent behind it, and the downgrade
  // to a warning would hand back the double launch this check exists to stop.
  const procs = [
    { pid: 40, uid: 501, comm: 'claude', cwd: null },
    { pid: 41, uid: 501, comm: 'claude', cwd: '/agents/a' },
  ]
  assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid: 99 }), {
    pid: 41,
    reason: 'same-cwd',
  })
})

test('waitForIncumbent: an unreadable cwd warns once, waits for nothing and lets the launch through', async () => {
  const lines: string[] = []
  const out = await waitForIncumbent({
    cwd: '/agents/a',
    uid: 501,
    ownPid: 99,
    listProcesses: () => [{ pid: 777, uid: 501, comm: 'claude', cwd: null }],
    sleep: async () => assert.fail('a non-blocking hit must never sleep'),
    print: (l: string) => lines.push(l),
    pollMs: 250,
    now: () => 0,
  })
  assert.deepEqual(out, { waited: false, polls: 1, lastPid: null, timedOut: false })
  const warning = lines.find((l) => /WARNING/.test(l))
  assert.ok(warning, `a launch that proceeds on an unknown must say so\n${lines.join('\n')}`)
  assert.match(warning!, /pid 777/)
  assert.equal(
    lines.some((l) => /waiting for an incumbent claude/.test(l)),
    false,
    'nothing was waited for, so nothing may announce a wait',
  )
})

test('waitForIncumbent: a same-cwd incumbent still holds the launch until it leaves', async () => {
  const lines: string[] = []
  const sleeps: number[] = []
  let clock = 1_000
  let polls = 0
  const lists = [
    [{ pid: 55, uid: 501, comm: 'claude', cwd: '/agents/a' }],
    [{ pid: 55, uid: 501, comm: 'claude', cwd: '/agents/a' }],
    [{ pid: 56, uid: 501, comm: 'claude', cwd: '/agents/b' }],
  ]
  const out = await waitForIncumbent({
    cwd: '/agents/a',
    uid: 501,
    ownPid: 99,
    listProcesses: () => lists[Math.min(polls++, lists.length - 1)]!,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
    },
    print: (l: string) => lines.push(l),
    pollMs: 250,
    now: () => clock,
    timeoutMs: 90_000,
  })
  // The deadline is nowhere near: this is the ordinary "/exit, then hoai" case.
  assert.deepEqual(out, { waited: true, polls: 3, lastPid: 55, timedOut: false })
  assert.deepEqual(sleeps, [250, 250])
  assert.ok(lines.some((l) => /waiting for an incumbent claude \(pid 55\)/.test(l)), lines.join('\n'))
})

test('waitForIncumbent: an incumbent that never leaves ends the wait at the deadline', async () => {
  assert.ok(
    INCUMBENT_WAIT_TIMEOUT_MS >= 60_000 && INCUMBENT_WAIT_TIMEOUT_MS <= 120_000,
    `the wait must be bounded in minutes, not hours (got ${INCUMBENT_WAIT_TIMEOUT_MS})`,
  )
  const lines: string[] = []
  let clock = 1_000
  let calls = 0
  const out = await waitForIncumbent({
    cwd: '/agents/a',
    uid: 501,
    ownPid: 99,
    listProcesses: () => {
      calls += 1
      // A wait with no end would spin here forever; turn that into a failure
      // rather than a hung test run.
      if (calls > 500) throw new Error('waitForIncumbent never gave up')
      return [{ pid: 4242, uid: 501, comm: 'claude', cwd: '/agents/a' }]
    },
    sleep: async (ms: number) => {
      clock += ms
    },
    print: (l: string) => lines.push(l),
    pollMs: 1_000,
    now: () => clock,
    timeoutMs: INCUMBENT_WAIT_TIMEOUT_MS,
  })
  assert.equal(out.timedOut, true, 'the wait must report that it gave up')
  assert.equal(out.lastPid, 4242, 'the caller needs the pid to name')
  assert.equal(out.polls, INCUMBENT_WAIT_TIMEOUT_MS / 1_000 + 1)
  assert.ok(lines.some((l) => /waiting for an incumbent claude \(pid 4242\)/.test(l)), lines.join('\n'))
})

test('main(): an incumbent hit at the deadline stops the launch with EXIT_INCUMBENT_TIMEOUT, naming the pid', async () => {
  const { home, cwd } = tempAgentFolder()
  try {
    const prints: string[] = []
    const spawns: string[] = []
    let clock = 5_000
    let calls = 0
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      pollMs: 1_000,
      incumbentTimeoutMs: 90_000,
      now: () => clock,
      listProcesses: () => {
        calls += 1
        if (calls > 500) throw new Error('the launch never gave up waiting')
        return [{ pid: 4242, uid: process.getuid?.() ?? 0, comm: 'claude', cwd }]
      },
      sleep: async (ms: number) => {
        clock += ms
      },
      print: (l: string) => prints.push(l),
      spawnImpl: ((file: string) => {
        spawns.push(file)
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, EXIT_INCUMBENT_TIMEOUT, `expected the give-up code\n${prints.join('\n')}`)
    assert.equal(spawns.length, 0, 'nothing may be launched after declining to wait longer')
    const stop = prints.find((l) => /STOPPING rather than launching/.test(l))
    assert.ok(stop, prints.join('\n'))
    // The message has to be actionable and honest about what it does not know.
    assert.match(stop!, /pid 4242/)
    assert.match(stop!, /ps -p 4242/)
    assert.match(stop!, /kill 4242/)
    assert.match(stop!, /reused pid could be an unrelated process/)
    assert.match(stop!, /hoai --force/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('main(): an incumbent whose cwd cannot be read no longer blocks the launch, it warns', async () => {
  const { home, cwd } = tempAgentFolder()
  try {
    const prints: string[] = []
    const spawns: { file: string; args: string[] }[] = []
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      pollMs: 1_000,
      listProcesses: () => [{ pid: 777, uid: process.getuid?.() ?? 0, comm: 'claude', cwd: null }],
      sleep: async () => assert.fail('an unreadable cwd must not cost the user a single poll'),
      print: (l: string) => prints.push(l),
      spawnImpl: ((file: string, args: readonly string[]) => {
        spawns.push({ file, args: [...args] })
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, 0)
    assert.equal(spawns.length, 1, 'the launch the user asked for happens')
    const warning = prints.find((l) => /WARNING/.test(l))
    assert.ok(warning, prints.join('\n'))
    assert.match(warning!, /pid 777/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The caller's own claude ANCESTOR is not an incumbent (2026-09-21).
// findIncumbentClaude excluded only ownPid, the node process. But hoai and
// `hoai doctor` are typed INTO a claude session, so the screening process has
// a claude PARENT sitting in exactly the folder being screened. Measured live:
// probeIncumbent({cwd: process.cwd()}) answered
// {hit:{pid:77299,reason:'same-cwd'},blocks:true} where 77299 was the claude
// running the probe, so the doctor printed a fix line telling the operator to
// `kill` the pid they were typing into, and waitForIncumbent with the exact
// arguments superviseClaude passes spent all ninety seconds on that parent and
// returned {polls:91, lastPid:77299, timedOut:true}, i.e. an EXIT_INCUMBENT_TIMEOUT
// naming the user's own window. The pid numbers used below are that measurement.

test('selfAndAncestorPids: the walk collects self and every ancestor, and stops at the root', () => {
  // The real chain behind a `hoai` typed into a claude session on this Mac.
  const procs = [
    { pid: 1, ppid: 0, comm: 'launchd' },
    { pid: 945, ppid: 1, comm: 'tmux' },
    { pid: 77299, ppid: 945, comm: '/Users/k/.local/bin/claude' },
    { pid: 71597, ppid: 77299, comm: '-zsh' },
    { pid: 71601, ppid: 71597, comm: 'node' },
    { pid: 5555, ppid: 1, comm: 'claude' },
  ]
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: procs, pid: 71601 })), [1, 945, 71597, 71601, 77299])
  assert.equal(
    selfAndAncestorPids({ processes: procs, pid: 71601 }).has(0),
    false,
    'pid 0 is the kernel placeholder for "no parent", never a process to exclude',
  )
  assert.equal(selfAndAncestorPids({ processes: procs, pid: 71601 }).has(5555), false, 'a sibling branch is not ours')
  // A pid nobody lists is still itself: ps raced us, and the caller is at
  // least allowed to not be its own incumbent.
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: procs, pid: 90001 })), [90001])
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: [], pid: 7 })), [7])
})

test('selfAndAncestorPids: a ppid cycle and a missing parent end the walk instead of spinning', () => {
  // This walk sits inside the probe whose whole job is to NOT hang, so a table
  // that loops (a reparent caught mid-flight, a wrapped pid) has to brake. If
  // the brake were missing these two lines would spin forever rather than fail,
  // which is the same shape of bug as the unbounded wait F8 had to end.
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: [{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }], pid: 5 })), [5, 6])
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: [{ pid: 9, ppid: 9 }], pid: 9 })), [9])
  // The parent exited between ps and us, so the chain simply ends there.
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: [{ pid: 30, ppid: 31 }], pid: 30 })), [30, 31])
  // A row with no ppid at all (an injected list that predates the field) is a
  // dead end, not a crash.
  assert.deepEqual(sorted(selfAndAncestorPids({ processes: [{ pid: 40 }] as never, pid: 40 })), [40])
})

test('findIncumbentClaude: the claude we are running inside is not an incumbent; an unrelated one still is', () => {
  const procs = [
    { pid: 1, ppid: 0, uid: 501, comm: 'launchd', cwd: '/' },
    { pid: 945, ppid: 1, uid: 501, comm: 'tmux', cwd: '/agents/a' },
    { pid: 77299, ppid: 945, uid: 501, comm: 'claude', cwd: '/agents/a' },
    { pid: 71597, ppid: 77299, uid: 501, comm: '-zsh', cwd: '/agents/a' },
    { pid: 71601, ppid: 71597, uid: 501, comm: 'node', cwd: '/agents/a' },
  ]
  const ownPid = 71601
  const ignorePids = selfAndAncestorPids({ processes: procs, pid: ownPid })
  // This is the measured defect, kept as the control: excluding only ownPid
  // hands back the operator's own session. `ownPid` on its own is unchanged.
  assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid }), {
    pid: 77299,
    reason: 'same-cwd',
  })
  assert.equal(
    findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid, ignorePids }),
    null,
    'the session running the probe is the caller, not a rival for the pin',
  )
  assert.equal(
    findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid, ignorePids: [77299] }),
    null,
    'a plain array is accepted as well as a Set',
  )
  // A missing or malformed list means "ignore nothing", never a throw inside
  // the launch path: every caller injects this, including the doctor's own
  // ignorePidsFor seam.
  for (const bad of [undefined, null, 0, {}] as never[]) {
    assert.deepEqual(findIncumbentClaude({ processes: procs, cwd: '/agents/a', uid: 501, ownPid, ignorePids: bad }), {
      pid: 77299,
      reason: 'same-cwd',
    })
  }
  // Excluding our chain must not disarm the guard: a claude nobody in our
  // ancestry spawned is still a hard block, and it is the one named.
  const withRival = [...procs, { pid: 5555, ppid: 1, uid: 501, comm: 'claude', cwd: '/agents/a' }]
  assert.deepEqual(findIncumbentClaude({ processes: withRival, cwd: '/agents/a', uid: 501, ownPid, ignorePids }), {
    pid: 5555,
    reason: 'same-cwd',
  })
  // An ancestor whose cwd could not be read is ours too, so it is not even
  // reported as the unreadable fallback.
  const blindAncestor = procs.map((p) => (p.pid === 77299 ? { ...p, cwd: null } : p))
  assert.equal(findIncumbentClaude({ processes: blindAncestor, cwd: '/agents/a', uid: 501, ownPid, ignorePids }), null)
})

test('main(): hoai typed inside a claude session in this folder launches at once instead of waiting it out', async () => {
  const { home, cwd } = tempAgentFolder()
  try {
    const prints: string[] = []
    const spawns: string[] = []
    const uid = process.getuid?.() ?? 0
    // superviseClaude reads its ancestry with the REAL process.pid, so the
    // injected table has to put this very process under a claude in this cwd,
    // which is the shape measured live on 2026-09-21.
    const table = [
      { pid: 4242, ppid: 1, uid, comm: 'claude', cwd },
      { pid: 4243, ppid: 4242, uid, comm: '-zsh', cwd },
      { pid: process.pid, ppid: 4243, uid, comm: 'node', cwd },
    ]
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      pollMs: 1_000,
      incumbentTimeoutMs: 90_000,
      now: () => 0,
      listProcesses: () => table,
      // Before the fix this fired on the first poll. It is an assertion rather
      // than a counter so the regression fails in milliseconds instead of
      // hanging the suite for ninety simulated seconds.
      sleep: async () => assert.fail('the claude session running hoai must not cost it a single poll'),
      print: (l: string) => prints.push(l),
      spawnImpl: ((file: string) => {
        spawns.push(file)
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, 0, `expected a launch, not the give-up code\n${prints.join('\n')}`)
    assert.equal(spawns.length, 1, 'the launch the operator asked for happens')
    assert.equal(
      prints.some((l) => /waiting for an incumbent claude/.test(l)),
      false,
      `nothing was waited for, so nothing may announce a wait\n${prints.join('\n')}`,
    )
    assert.equal(
      prints.some((l) => /STOPPING rather than launching/.test(l)),
      false,
      `the operator must never be told to kill the window they are typing into\n${prints.join('\n')}`,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('main(): an unrelated claude in the folder still stops the launch, and names it and not our own ancestor', async () => {
  const { home, cwd } = tempAgentFolder()
  try {
    const prints: string[] = []
    const spawns: string[] = []
    const uid = process.getuid?.() ?? 0
    let clock = 5_000
    let calls = 0
    const table = [
      { pid: 4242, ppid: 1, uid, comm: 'claude', cwd },
      { pid: 4243, ppid: 4242, uid, comm: '-zsh', cwd },
      { pid: process.pid, ppid: 4243, uid, comm: 'node', cwd },
      { pid: 5555, ppid: 1, uid, comm: 'claude', cwd },
    ]
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      pollMs: 1_000,
      incumbentTimeoutMs: 90_000,
      now: () => clock,
      listProcesses: () => {
        calls += 1
        if (calls > 500) throw new Error('the launch never gave up waiting')
        return table
      },
      sleep: async (ms: number) => {
        clock += ms
      },
      print: (l: string) => prints.push(l),
      spawnImpl: ((file: string) => {
        spawns.push(file)
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, EXIT_INCUMBENT_TIMEOUT, `expected the give-up code\n${prints.join('\n')}`)
    assert.equal(spawns.length, 0, 'nothing may be launched beside a real incumbent')
    const stop = prints.find((l) => /STOPPING rather than launching/.test(l))
    assert.ok(stop, prints.join('\n'))
    assert.match(stop!, /pid 5555/)
    assert.equal(/4242/.test(stop!), false, `our own claude parent must never be the pid named\n${stop}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('defaultListProcesses: ps is asked for ppid, a comm with spaces stays whole, and our ancestry is kept', () => {
  // ps output is column-aligned and comm is LAST because it is the only field
  // that may contain spaces. Adding ppid made the parse a four-field one, and
  // the trailing catch-all is what keeps "Terminal Helper (Plugin)" from
  // shifting a pid into the comm.
  const psOut = [
    '    1     0   501 launchd',
    '  945     1   501 tmux',
    '77299   945   501 /Users/k/.local/bin/claude',
    '71597 77299   501 Terminal Helper (Plugin)',
    '71601 71597   501 node',
    '88000     1   501 /Applications/My Tools/claude',
    ' 3001     1   502 Google Chrome Helper (Renderer)',
    'a line ps would never print',
    '',
  ].join('\n')
  const calls: { file: string; args: string[] }[] = []
  const rows = defaultListProcesses('darwin', {
    selfPid: 71601,
    spawn: ((file: string, args: readonly string[]) => {
      calls.push({ file, args: [...args] })
      if (file === 'ps') return { status: 0, stdout: psOut }
      const pid = args[args.indexOf('-p') + 1]
      return { status: 0, stdout: `p${pid}\nn/agents/${pid}\n` }
    }) as never,
  })
  assert.deepEqual(calls[0]!.args, ['-Axo', 'pid=,ppid=,uid=,comm='], 'ppid has to be asked for to be walked')
  // Every claude, plus our own ancestry whatever its comm: a claude-only list
  // cannot bridge the shell between node and the claude that started it, which
  // is why the ancestry walk found nothing when only claude rows were kept.
  assert.deepEqual(
    rows.map((r) => r.pid).sort((a, b) => a - b),
    [1, 945, 71597, 71601, 77299, 88000],
  )
  assert.equal(rows.some((r) => r.pid === 3001), false, 'an unrelated non-claude process is still noise')
  const helper = rows.find((r) => r.pid === 71597)!
  assert.equal(helper.comm, 'Terminal Helper (Plugin)', 'the spaces belong to comm, not to a field boundary')
  assert.equal(helper.ppid, 77299, 'a comm with spaces must not shift ppid')
  assert.equal(helper.uid, 501)
  const ours = rows.find((r) => r.pid === 77299)!
  assert.deepEqual(ours, { pid: 77299, ppid: 945, uid: 501, comm: '/Users/k/.local/bin/claude', cwd: '/agents/77299' })
  assert.equal(rows.find((r) => r.pid === 88000)!.cwd, '/agents/88000', 'a claude path with spaces is still a claude')
  // The ancestry the caller now hands to findIncumbentClaude reaches the claude.
  assert.equal(selfAndAncestorPids({ processes: rows, pid: 71601 }).has(77299), true)
  // lsof is asked only about claude: every probe skipped is a probe that
  // cannot wedge.
  const probed = calls.filter((c) => c.file === 'lsof').map((c) => c.args[c.args.indexOf('-p') + 1])
  assert.deepEqual(probed.sort(), ['77299', '88000'])
})

test('defaultListProcesses: ps and every lsof carry a deadline, and a timed-out lsof reads as an unreadable cwd', () => {
  // `lsof -p <pid> -d cwd` blocks INDEFINITELY when any mount on the host is
  // wedged (a dead NFS or FUSE server). Unbounded, that made `hoai doctor`
  // inherit the very hang it exists to diagnose: not one row printed, and the
  // bootstrap preflight stalled with no output at all (2026-09-21). A killed
  // lsof leaves the cwd unreadable, which since the same day warns instead of
  // blocking, so the timeout errs in the safe direction.
  const seen: { file: string; timeout: unknown }[] = []
  const rows = defaultListProcesses('darwin', {
    selfPid: 1,
    spawn: ((file: string, _args: readonly string[], opts: { timeout?: number }) => {
      seen.push({ file, timeout: opts?.timeout })
      if (file === 'ps') return { status: 0, stdout: '4242     1   501 claude\n' }
      // What spawnSync hands back when it kills a child on timeout.
      return { status: null, stdout: '', error: new Error('ETIMEDOUT') }
    }) as never,
  })
  assert.ok(
    PROCESS_PROBE_TIMEOUT_MS > 0 && PROCESS_PROBE_TIMEOUT_MS <= 10_000,
    `the probe deadline must be seconds, not minutes or nothing (got ${PROCESS_PROBE_TIMEOUT_MS})`,
  )
  assert.deepEqual(
    seen,
    [
      { file: 'ps', timeout: PROCESS_PROBE_TIMEOUT_MS },
      { file: 'lsof', timeout: PROCESS_PROBE_TIMEOUT_MS },
    ],
    'both external commands must be bounded, not just one of them',
  )
  assert.deepEqual(rows, [{ pid: 4242, ppid: 1, uid: 501, comm: 'claude', cwd: null }])
  assert.equal(
    incumbentBlocks(findIncumbentClaude({ processes: rows, cwd: '/agents/a', uid: 501, ownPid: 9 })),
    false,
    'a probe that ran out of time must not become a blocking incumbent',
  )
  // A ps that times out reports status null too, and an empty list is the
  // honest answer: no evidence of an incumbent.
  assert.deepEqual(
    defaultListProcesses('darwin', { spawn: (() => ({ status: null, stdout: '' })) as never }),
    [],
  )
  assert.deepEqual(defaultListProcesses('win32', { spawn: (() => assert.fail('win32 must not shell out')) as never }), [])
})

test('the exit codes are pinned to their literal values, and no two of them collide', () => {
  // The only assertion EXIT_INCUMBENT_TIMEOUT had was `assert.equal(code,
  // EXIT_INCUMBENT_TIMEOUT)`, the constant compared with itself, so changing
  // `= 5` to `= 3` left the whole file green while the thing the constant
  // exists for quietly broke: its own JSDoc says a wrapper must be able to
  // tell "waited, then declined" apart from EXIT_ALREADY_SUPERVISED and
  // EXIT_CHANNEL_UNRESOLVED. These numbers are a contract with
  // hoai-bootstrap.sh and the KeepAlive, so they are pinned as literals.
  assert.equal(EXIT_INCUMBENT_TIMEOUT, 5)
  assert.equal(hoaiCore.EXIT_ALREADY_SUPERVISED, 3)
  assert.equal(hoaiCore.EXIT_CHANNEL_UNRESOLVED, 4)
  assert.equal(EXIT_NOT_FOUND, 127)
  // Collected from the module instead of hand-listed: an exit code added next
  // year is checked for collisions without anyone remembering this test.
  const exitCodes = Object.entries({ ...hoaiCore }).filter(([name]) => name.startsWith('EXIT_'))
  assert.ok(exitCodes.length >= 4, `exit codes must be exported to be pinned (found ${exitCodes.length})`)
  const byValue = new Map<number, string>()
  for (const [name, value] of exitCodes) {
    assert.equal(typeof value, 'number', `${name} must be a number to be an exit code`)
    const code = value as number
    assert.ok(Number.isInteger(code) && code >= 0 && code <= 255, `${name} = ${code} is not a process exit code`)
    const clash = byValue.get(code)
    assert.equal(clash, undefined, `${name} and ${clash} both exit ${code}; no wrapper can tell them apart`)
    byValue.set(code, name)
  }
})

test('resolveHoaiAction: --force routes to run, combines with --new, and lookalikes still reach help', () => {
  const forced = { action: 'run', rest: [], fresh: false, force: true }
  assert.deepEqual(resolveHoaiAction(['--force']), forced)
  assert.deepEqual(resolveHoaiAction(['run', '--force']), forced)
  assert.deepEqual(resolveHoaiAction(['--FORCE']), forced)
  const both = { action: 'run', rest: [], fresh: true, force: true }
  assert.deepEqual(resolveHoaiAction(['--new', '--force']), both)
  assert.deepEqual(resolveHoaiAction(['--force', '--new']), both)
  assert.deepEqual(resolveHoaiAction(['run', '--force', '--new']), both)
  assert.equal(classifyRunFlag('--force'), 'force')
  // The unknown-flag path must not swallow the new flag, and must still catch
  // everything that merely looks like it.
  assert.deepEqual(resolveHoaiAction(['--force-me']), {
    action: 'help',
    rest: ['--force-me'],
    fresh: false,
    force: false,
  })
  assert.match(USAGE, /hoai --force/, 'a flag nobody is told about is not an escape hatch')
})

test('main(): --force launches at once and never even asks what is running', async () => {
  const { home, cwd } = tempAgentFolder()
  try {
    const prints: string[] = []
    const spawns: { file: string; args: string[] }[] = []
    let consulted = 0
    const code = await main(['--force'], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      pollMs: 1_000,
      listProcesses: () => {
        consulted += 1
        // A same-cwd incumbent: without --force this is a hard block.
        return [{ pid: 4242, uid: process.getuid?.() ?? 0, comm: 'claude', cwd }]
      },
      sleep: async () => assert.fail('--force must not wait for anything'),
      print: (l: string) => prints.push(l),
      spawnImpl: ((file: string, args: readonly string[]) => {
        spawns.push({ file, args: [...args] })
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, 0)
    assert.equal(spawns.length, 1, 'the user asked to launch now, so it launches now')
    assert.equal(consulted, 0, 'the wait is skipped entirely, not merely shortened to zero')
    assert.equal(
      prints.some((l) => /waiting for an incumbent claude/.test(l)),
      false,
      'no wait happened, so no wait notice',
    )
    assert.ok(prints.some((l) => /--force/.test(l)), prints.join('\n'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('main(): the launch environment gains the task tools flag, and the hooks are registered', async () => {
  const { home, cwd } = tempAgentFolder()
  const env: Record<string, string | undefined> = {}
  const registered: Array<{ settingsPath: string; forwarderPath: string }> = []
  try {
    const code = await main([], {
      platform: 'linux',
      env,
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      registerHooks: (args: { settingsPath: string; forwarderPath: string }) => {
        registered.push(args)
        return { changed: true, reason: 'set' }
      },
      spawnImpl: (() => scriptedChild(0)) as never,
    } as never)
    assert.equal(code, 0)
    assert.equal(
      env.CLAUDE_CODE_ENABLE_TODO_TOOLS,
      '1',
      'the child inherits this environment; without the flag there are no task tools at all',
    )
    assert.equal(registered.length, 1, 'a clone launch registers the forwarder every time')
    assert.equal(registered[0]!.forwarderPath, `${CLONE_SCRIPT_DIR}/hoai-hook.mjs`)
    assert.ok(
      registered[0]!.settingsPath.replace(/\\/g, '/').endsWith('/.claude/settings.local.json'),
      registered[0]!.settingsPath,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

// --- the one-time-prompt preseed reaches a HAND-TYPED launch (2026-09-21) ----
// preseedClaudeTrust had exactly ONE production caller, the watcher's
// create-agent job. bin/hoai-core.mjs imported only ensureHookEntries and
// ensureMarketplaceAutoUpdate from that module, so `hoai`, the command
// bgos-pair prints for the user to run, seeded nothing at all and the first
// launch stopped on the folder-trust dialog. These drive the REAL function
// against a real (throwaway) home, so the seam being exercised is the one a
// user gets, not an injected stand-in.

test('main(): EVERY launch form pre-seeds the one-time prompts for the launch folder', async () => {
  // Every spelling, not just the bare one: they all funnel into the same run
  // path, and a seed that reached only some of them would leave the dialog
  // standing for whichever one a given user happens to type.
  for (const argv of [[], ['-c'], ['--continue'], ['--resume'], ['--new'], ['run', '--continue']]) {
    const { home, cwd } = tempAgentFolder()
    try {
      const code = await main(argv, {
        platform: 'linux',
        env: {},
        home,
        cwd,
        scriptDir: CLONE_SCRIPT_DIR,
        spawnImpl: (() => scriptedChild(0)) as never,
      } as never)
      assert.equal(code, 0, argv.join(' '))
      // The trust entry, in the file Claude Code reads when CLAUDE_CONFIG_DIR is
      // unset: $HOME/.claude.json, NOT $HOME/.claude/.claude.json.
      const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
      assert.equal(cfg.projects[cwd].hasTrustDialogAccepted, true, argv.join(' '))
      assert.equal(cfg.hasCompletedOnboarding, true)
      assert.equal(existsSync(join(home, '.claude', '.claude.json')), false, argv.join(' '))
      // And the bypass warning, whose default answer is exit, suppressed in the
      // settings file, which DOES live inside the config dir.
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
      assert.equal(settings.skipDangerousModePermissionPrompt, true, argv.join(' '))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  }
})

test('main(): the preseed runs BEFORE claude is spawned, and a preseed that throws never stops the launch', async () => {
  const { home, cwd } = tempAgentFolder()
  const order: string[] = []
  try {
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      preseedTrust: () => {
        order.push('preseed')
        // A read-only config dir is the realistic failure, and it must cost the
        // user a prompt, never their agent.
        throw new Error('EACCES: read-only file system')
      },
      spawnImpl: (() => {
        order.push('spawn')
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, 0, 'a seeding convenience may never cost the user their launch')
    assert.deepEqual(order, ['preseed', 'spawn'], 'seeding after the spawn would seed nothing in time')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('main(): the preseed is handed the LAUNCH folder and this host\'s config dir', async () => {
  const { home, cwd } = tempAgentFolder()
  const calls: Array<{ configDir: string; cwd: string; home: string }> = []
  try {
    await main([], {
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: '/opt/agents/cfg' },
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      preseedTrust: (args: { configDir: string; cwd: string; home: string }) => {
        calls.push(args)
        return { configPath: '', settingsPath: '', seededKeys: [] }
      },
      spawnImpl: (() => scriptedChild(0)) as never,
    } as never)
    assert.equal(calls.length, 1, 'a launch that seeds nothing is the defect this closes')
    // The cwd is the identity here: seeding any other folder leaves the trust
    // dialog exactly where it was.
    assert.equal(calls[0]!.cwd, cwd)
    assert.equal(calls[0]!.configDir, '/opt/agents/cfg')
    assert.equal(calls[0]!.home, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('main(): a registration that throws never stops the launch', async () => {
  const { home, cwd } = tempAgentFolder()
  const spawns: Array<{ file: string }> = []
  try {
    const code = await main([], {
      platform: 'linux',
      env: {},
      home,
      cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      registerHooks: () => {
        throw new Error('EACCES: a read only workspace')
      },
      spawnImpl: ((file: string) => {
        spawns.push({ file })
        return scriptedChild(0)
      }) as never,
    } as never)
    assert.equal(code, 0, 'telemetry plumbing may never cost the user their agent')
    assert.equal(spawns.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
