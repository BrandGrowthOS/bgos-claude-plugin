/**
 * lib/session-pin.ts: the daemon records the LIVE Claude session into the
 * agent's pin (~/.bgos-agent/<id>/session-id), finding 7 and design section 4.
 *
 * Finding 7: a supervised relaunch started a FRESH conversation; Ava had to
 * add `--resume <pinned id>` by hand. The product supervisor runs hoai, which
 * resumes the pin when its transcript exists. But an agent first started with
 * plain `claude` has no pin, or a pin naming an older session, so the moment
 * the supervisor takes over it would resume the wrong conversation or start a
 * new one. The daemon knows the live session from its own hook events, so it
 * writes it into the pin, under guards that keep a stray session out.
 *
 * Run: npx tsx --test test/session-pin.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RELAUNCH_HEALTHY_MS,
  SESSION_ID_FILE_NAME,
  agentDir,
  joinDir,
  sessionTranscriptPath,
} from '../bin/hoai-core.mjs'
import {
  SESSION_PIN_SETTLE_MS,
  SessionPinKeeper,
  decideSessionPin,
  isPrintModeCommand,
  liveTranscriptPath,
  sessionPinPath,
  writeSessionPinAtomic,
} from '../lib/session-pin.ts'

const LIVE = '8c1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'
const OLD = '11111111-2222-4333-8444-555555555555'

type PinInput = Parameters<typeof decideSessionPin>[0]
const ready: PinInput = {
  holdsChannel: true,
  liveSessionId: LIVE,
  liveSessionAgeMs: SESSION_PIN_SETTLE_MS,
  printMode: false,
  liveTranscriptExists: true,
  pinRaw: OLD,
  pinTranscriptExists: true,
}

test('the pin decision table', () => {
  const rows: Array<[string, Partial<PinInput>, string, string]> = [
    // name, overrides, action, reason
    ['a passive daemon (a claude -p, a subagent) never pins', { holdsChannel: false }, 'skip', 'not-holder'],
    ['no live session learned yet', { liveSessionId: null }, 'skip', 'no-live-session'],
    ['a live id that is not a UUID is never written', { liveSessionId: 'abc' }, 'skip', 'live-not-uuid'],
    ['a print-mode claude is a one-shot, never the agent', { printMode: true }, 'skip', 'print-mode'],
    ['unknown print mode does not veto (no ps on Windows)', { printMode: null }, 'write', 'differs'],
    ['a session younger than the settle window waits', { liveSessionAgeMs: SESSION_PIN_SETTLE_MS - 1 }, 'skip', 'settling'],
    ['a live session with no transcript cannot be resumed', { liveTranscriptExists: false }, 'skip', 'no-live-transcript'],
    ['already pinned', { pinRaw: LIVE }, 'skip', 'pinned'],
    ['already pinned, as hoai writes it (whitespace)', { pinRaw: `${LIVE}\n` }, 'skip', 'pinned'],
    ['no pin at all', { pinRaw: null, pinTranscriptExists: false }, 'write', 'missing'],
    ['an empty pin', { pinRaw: '  ', pinTranscriptExists: false }, 'write', 'missing'],
    ['a pin that is not a UUID', { pinRaw: 'junk', pinTranscriptExists: false }, 'write', 'malformed'],
    ['a pin naming a session with no transcript', { pinTranscriptExists: false }, 'write', 'no-transcript'],
    ['a pin naming another, resumable session', {}, 'write', 'differs'],
  ]
  for (const [name, over, action, reason] of rows) {
    const decision = decideSessionPin({ ...ready, ...over })
    assert.equal(decision.action, action, name)
    assert.equal(decision.reason, reason, name)
    if (decision.action === 'write') assert.equal(decision.sessionId, LIVE, name)
  }
})

test('the settle window outlasts hoai\'s fresh-session health window', () => {
  // hoai commits a fresh fallback session to the pin only after it survived
  // RELAUNCH_HEALTHY_MS (zaid, 2026-09-02: a fast-dying fresh session must not
  // burn the pin). The daemon waiting longer keeps that rule intact.
  assert.ok(SESSION_PIN_SETTLE_MS >= RELAUNCH_HEALTHY_MS)
})

test('paths are exactly the ones hoai reads: the pin file and the transcript it resumes', () => {
  assert.equal(sessionPinPath('/Users/a', '910'), joinDir(joinDir(agentDir('/Users/a'), '910'), SESSION_ID_FILE_NAME))
  assert.equal(sessionPinPath('/Users/a', '910'), '/Users/a/.bgos-agent/910/session-id')
  assert.equal(sessionPinPath('/Users/a', 'cwd-abc'), null)
  for (const configDir of ['', '/Users/a/.claude-work']) {
    assert.equal(
      liveTranscriptPath({ home: '/Users/a', cwd: '/Users/a/My Agent.v2', sessionId: LIVE, configDir }),
      sessionTranscriptPath('/Users/a', '/Users/a/My Agent.v2', LIVE, configDir),
    )
  }
  // Every non-alphanumeric character of the cwd becomes '-'.
  assert.equal(
    liveTranscriptPath({ home: '/Users/a', cwd: '/Users/a/My Agent.v2', sessionId: LIVE, configDir: '' }),
    `/Users/a/.claude/projects/-Users-a-My-Agent-v2/${LIVE}.jsonl`,
  )
})

test('the pin is written atomically: a temp file, then a rename', () => {
  const calls: string[] = []
  const ok = writeSessionPinAtomic('/h/.bgos-agent/910/session-id', LIVE, {
    mkdir: (d) => calls.push(`mkdir ${d}`),
    writeFile: (p, body) => calls.push(`write ${p} ${body}`),
    rename: (a, b) => calls.push(`rename ${a} ${b}`),
    unlink: (p) => calls.push(`unlink ${p}`),
  })
  assert.equal(ok, true)
  const tmp = `/h/.bgos-agent/910/session-id.${process.pid}.tmp`
  assert.deepEqual(calls, ['mkdir /h/.bgos-agent/910', `write ${tmp} ${LIVE}`, `rename ${tmp} /h/.bgos-agent/910/session-id`])
})

test('isPrintModeCommand recognises -p and --print only', () => {
  assert.equal(isPrintModeCommand('claude -p "summarise"'), true)
  assert.equal(isPrintModeCommand('/Users/a/.local/bin/claude --print --output-format json'), true)
  assert.equal(isPrintModeCommand('claude --dangerously-skip-permissions --resume 8c1f'), false)
  assert.equal(isPrintModeCommand('claude --permission-mode plan'), false)
  assert.equal(isPrintModeCommand(''), false)
  assert.equal(isPrintModeCommand(null), false)
})

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'session-pin-test-'))
  const cwd = join(home, 'agents', 'ava')
  const transcript = (id: string) =>
    join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  const makeTranscript = (id: string) => {
    mkdirSync(dirname(transcript(id)), { recursive: true })
    writeFileSync(transcript(id), '{}\n')
  }
  const pinPath = join(home, '.bgos-agent', '910', 'session-id')
  const logs: string[] = []
  const keeper = new SessionPinKeeper({
    home,
    cwd,
    configDir: '',
    assistantId: '910',
    exists: existsSync,
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    log: (line) => logs.push(line),
  })
  return { home, cwd, keeper, makeTranscript, pinPath, logs, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const live = (over: Partial<{ holdsChannel: boolean; sessionId: string | null; seenAtMs: number; printMode: boolean | null }> = {}) => ({
  holdsChannel: true,
  sessionId: LIVE,
  seenAtMs: 0,
  printMode: false,
  ...over,
})

test('the keeper writes the live session into a missing pin, atomically, once its transcript exists', () => {
  const s = sandbox()
  try {
    assert.equal(s.keeper.check(live(), SESSION_PIN_SETTLE_MS).reason, 'no-live-transcript')
    assert.ok(!existsSync(s.pinPath))
    s.makeTranscript(LIVE)
    const decision = s.keeper.check(live(), SESSION_PIN_SETTLE_MS + 30_000)
    assert.equal(decision.action, 'write')
    assert.equal(readFileSync(s.pinPath, 'utf8'), LIVE, 'exactly the id, as hoai writes it')
    assert.deepEqual(readdirSync(dirname(s.pinPath)), ['session-id'], 'no temp file left behind')
    assert.ok(s.logs.some((l) => l.includes('session pin') && l.includes(LIVE)))
  } finally {
    s.cleanup()
  }
})

test('the keeper replaces a pin naming another session, then leaves the pin alone for this live session', () => {
  const s = sandbox()
  try {
    mkdirSync(dirname(s.pinPath), { recursive: true })
    writeFileSync(s.pinPath, OLD)
    s.makeTranscript(OLD)
    s.makeTranscript(LIVE)
    assert.equal(s.keeper.check(live(), SESSION_PIN_SETTLE_MS).reason, 'differs')
    assert.equal(readFileSync(s.pinPath, 'utf8'), LIVE)
    // Someone repins on purpose (hoai --new) while this session still lives:
    // the keeper must not fight it.
    writeFileSync(s.pinPath, OLD)
    assert.equal(s.keeper.check(live(), SESSION_PIN_SETTLE_MS * 2).reason, 'done')
    assert.equal(readFileSync(s.pinPath, 'utf8'), OLD)
    // But a pin that VANISHED (an uninstall removed the state dir) is restored.
    rmSync(s.pinPath)
    assert.equal(s.keeper.check(live(), SESSION_PIN_SETTLE_MS * 3).reason, 'missing')
    assert.equal(readFileSync(s.pinPath, 'utf8'), LIVE)
    assert.equal(s.keeper.check(live(), SESSION_PIN_SETTLE_MS * 4).reason, 'done')
    // A NEW live session is a new question.
    const NEXT = '22222222-3333-4444-8555-666666666666'
    s.makeTranscript(NEXT)
    assert.equal(s.keeper.check(live({ sessionId: NEXT, seenAtMs: 1_000_000 }), 1_000_000 + SESSION_PIN_SETTLE_MS).action, 'write')
    assert.equal(readFileSync(s.pinPath, 'utf8'), NEXT)
  } finally {
    s.cleanup()
  }
})

test('the keeper does nothing for a passive daemon, a print-mode session or a fresh one', () => {
  const s = sandbox()
  try {
    s.makeTranscript(LIVE)
    assert.equal(s.keeper.check(live({ holdsChannel: false }), SESSION_PIN_SETTLE_MS).reason, 'not-holder')
    assert.equal(s.keeper.check(live(), SESSION_PIN_SETTLE_MS - 1).reason, 'settling')
    assert.equal(s.keeper.check(live({ printMode: true }), SESSION_PIN_SETTLE_MS).reason, 'print-mode')
    assert.ok(!existsSync(s.pinPath))
  } finally {
    s.cleanup()
  }
})

test('the keeper never throws', () => {
  const keeper = new SessionPinKeeper({
    home: '/nowhere',
    cwd: '/nowhere/a',
    configDir: '',
    assistantId: '910',
    exists: () => {
      throw new Error('EACCES')
    },
    readFile: () => {
      throw new Error('EACCES')
    },
  })
  assert.equal(keeper.check(live(), SESSION_PIN_SETTLE_MS).action, 'skip')
  const noId = new SessionPinKeeper({ home: '/h', cwd: '/h/a', configDir: '', assistantId: null, exists: () => true, readFile: () => null })
  assert.equal(noId.check(live(), SESSION_PIN_SETTLE_MS).action, 'skip')
})

test('server.ts pins from the channel holder, with the session its own hooks named', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const server = readFileSync(join(root, 'server.ts'), 'utf8')
  const at = server.indexOf('const sessionPinKeeper = new SessionPinKeeper(')
  assert.ok(at > 0, 'the keeper is wired')
  const wiring = server.slice(at, server.indexOf('\n}\n', server.indexOf('function checkSessionPin(', at)))
  // The config dir hoai resolves, as ONE absolute path (verifier item b): hoai
  // runs in the agent folder, so a relative CLAUDE_CONFIG_DIR means a folder
  // under it, and this process runs in the plugin cache on a marketplace
  // install, where the raw value named a dir no transcript lives in.
  assert.match(wiring, /\n\s*configDir: CLAUDE_CONFIG_DIR,\n/, 'the same config dir hoai resolves')
  // claude's folder, which hoai keys the transcript by: LAUNCH_CWD. On a
  // marketplace install process.cwd() is the plugin cache (bin/bgos-launch.mjs
  // relocates it), where no transcript of this agent ever lives.
  assert.match(server, /\nconst SESSION_PIN_WORKDIR = LAUNCH_CWD\n/, 'the agent folder, not the plugin cache')
  assert.match(wiring, /cwd: SESSION_PIN_WORKDIR,/)
  assert.doesNotMatch(wiring, /cwd: process\.cwd\(\)/)
  assert.match(wiring, /const holdsChannel = channelArmed && lockHeld\n/)
  assert.match(wiring, /\n\s*holdsChannel,\n/)
  assert.match(wiring, /sessionId: liveSessionId/)
  assert.match(wiring, /seenAtMs: liveSessionSeenAtMs/)
  assert.match(wiring, /printMode: holdsChannel \? claudePrintMode\(\) : null/)
  assert.match(server, /setInterval\(\(\) => checkSessionPin\(\), SESSION_PIN_CHECK_MS\)\.unref\(\)/)
})
