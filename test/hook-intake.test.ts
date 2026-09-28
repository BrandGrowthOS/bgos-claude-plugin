/**
 * lib/hook-intake.ts: the spool intake.
 *
 * Three rules decide everything here, and two of them are about posting a row
 * that is not ours, or posting one TWICE:
 *
 *   1. only the pairing lock holder consumes (several daemons can resolve one
 *      pairing on a shared host, and they all watch the same directory);
 *   2. a session is consumed only once it has PROVEN it is the one this daemon
 *      feeds. "Its transcript is under our project dir" is not proof: a human's
 *      own claude in the agent folder writes there, and so does a session that
 *      died last week. The three proofs are a prompt carrying a message we
 *      delivered, the transcript the binding chain already proved, and a
 *      SessionStart naming that transcript. Anything else is BUFFERED for a
 *      minute in case the proof is one line behind, then dropped;
 *   3. the drain cursor is on DISK, so a restart or a lock re-arm resumes
 *      instead of replaying a whole session into the chat.
 *
 * Run: npx tsx --test test/hook-intake.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  CURSOR_FILE_NAME,
  DEDUPE_LIMIT,
  ID_LESS_EVENTS,
  INTAKE_POLL_IDLE_MS,
  INTAKE_POLL_LIVE_MS,
  SESSION_SWEEP_MS,
  SPOOL_FILE_NAME,
  UNBOUND_BUFFER_MS,
  createDedupe,
  decideDrain,
  decideSessionAdmission,
  dedupeKeyOf,
  hookStateRoot,
  hooksRoot,
  isSameTranscript,
  isUnderDir,
  parseCursor,
  parseSpoolLine,
  serializeCursor,
  sessionCursorPath,
  sessionSpoolPath,
  startHookIntake,
  type IntakeFs,
} from '../lib/hook-intake.ts'
import { resolveCursorFilePath } from '../lib/cursor-store.ts'

/** The stage 8 probe: one live turn with two real subagents, copied out of
 *  docs/reports/2026-09-21-subagents-card/probe/hooks.jsonl (plus the four
 *  records that survived only in the raw driver log) with the paths scrubbed. */
const PROBE = readFileSync(new URL('./fixtures/stage8-hooks.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as { hook: string; payload: Record<string, unknown> })

const PROJECT_DIR = '/home/kc/.claude/projects/-work-atlas'
const OURS = `${PROJECT_DIR}/sess-ours.jsonl`
const STRANGER = `${PROJECT_DIR}/sess-stranger.jsonl`
const THEIRS = '/home/kc/.claude/projects/-work-other/sess-theirs.jsonl'

// ── Admission ────────────────────────────────────────────────────────────────

test('being under our project dir is NOT a binding, on its own', () => {
  // The defect this pins: the first payload seen under the project dir bound
  // the daemon. A human's own claude in the agent folder, a worker, or a dead
  // session's leftover spool could each capture the rail, and the real agent's
  // rows were then refused as foreign for the life of the daemon.
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: 'stranger', transcriptPath: STRANGER, event: 'PreToolUse' },
      projectDir: PROJECT_DIR,
    }),
    { admit: false, reason: 'unproven' },
    'same project dir, no proof, no binding',
  )
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: 'stranger', transcriptPath: STRANGER, event: 'SessionStart' },
      projectDir: PROJECT_DIR,
      provenTranscript: OURS,
    }),
    { admit: false, reason: 'unproven' },
    'a SessionStart for a DIFFERENT transcript proves nothing either',
  )
})

test('a prompt carrying a message we delivered is proof (a)', () => {
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: {
        sessionId: 'ours',
        transcriptPath: OURS,
        event: 'UserPromptSubmit',
        deliveredPrompt: true,
      },
      projectDir: PROJECT_DIR,
    }),
    { admit: true, binds: true, proof: 'delivered-prompt' },
  )
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: {
        sessionId: 'ours',
        transcriptPath: OURS,
        event: 'PreToolUse',
        deliveredPrompt: true,
      },
      projectDir: PROJECT_DIR,
    }),
    { admit: false, reason: 'unproven' },
    'only a prompt event can carry a prompt',
  )
})

test('the transcript the binding chain proved is proof (b), and a SessionStart on it is proof (c)', () => {
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: 'ours', transcriptPath: OURS, event: 'PreToolUse' },
      projectDir: PROJECT_DIR,
      provenTranscript: OURS,
    }),
    { admit: true, binds: true, proof: 'binding-chain' },
  )
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: 'ours', transcriptPath: OURS, event: 'SessionStart' },
      projectDir: PROJECT_DIR,
      provenTranscript: 'sess-ours.jsonl',
    }),
    { admit: true, binds: true, proof: 'session-start' },
    'the chain names a basename as readily as a path',
  )
})

test('a sibling folder\u2019s session is foreign whatever it proves', () => {
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: {
        sessionId: 'theirs',
        transcriptPath: THEIRS,
        event: 'UserPromptSubmit',
        deliveredPrompt: true,
      },
      projectDir: PROJECT_DIR,
    }),
    { admit: false, reason: 'foreign-project' },
  )
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: 'ours', transcriptPath: '', event: 'SessionStart' },
      projectDir: PROJECT_DIR,
      provenTranscript: OURS,
    }),
    { admit: false, reason: 'foreign-project' },
    'no transcript path is no candidate at all',
  )
})

test('once bound, a foreign session is refused and left for its own daemon', () => {
  const bound = { sessionId: 'ours' }
  assert.deepEqual(
    decideSessionAdmission({
      bound,
      incoming: { sessionId: 'ours', transcriptPath: OURS, event: 'PostToolUse' },
      projectDir: PROJECT_DIR,
    }),
    { admit: true, binds: false },
  )
  assert.deepEqual(
    decideSessionAdmission({
      bound,
      incoming: { sessionId: 'stray-shell', transcriptPath: OURS, event: 'PostToolUse' },
      projectDir: PROJECT_DIR,
    }),
    { admit: false, reason: 'foreign-session' },
    'the same project dir is NOT enough once a session is bound',
  )
  assert.deepEqual(
    decideSessionAdmission({
      bound,
      incoming: { sessionId: '', transcriptPath: OURS },
      projectDir: PROJECT_DIR,
    }),
    { admit: false, reason: 'foreign-session' },
  )
})

test('isUnderDir is containment, not a prefix match', () => {
  assert.ok(isUnderDir('/a/b/c.jsonl', '/a/b'))
  assert.ok(isUnderDir('/a/b', '/a/b'))
  assert.ok(isUnderDir('C:\\a\\b\\c.jsonl', 'C:\\a\\b'))
  assert.ok(!isUnderDir('/a/bb/c.jsonl', '/a/b'), 'a sibling starting with the same letters')
  assert.ok(!isUnderDir('/a/b/c.jsonl', ''))
  assert.ok(!isUnderDir('', '/a/b'))
})

test('isSameTranscript compares paths, and basenames when either side is bare', () => {
  assert.ok(isSameTranscript('/p/a.jsonl', '/p/a.jsonl'))
  assert.ok(isSameTranscript('/p/a.jsonl', 'a.jsonl'))
  assert.ok(isSameTranscript('a.jsonl', '/p/a.jsonl'))
  assert.ok(!isSameTranscript('/p/a.jsonl', '/q/a.jsonl'), 'two dirs, two files')
  assert.ok(!isSameTranscript('/p/a.jsonl', 'b.jsonl'))
  assert.ok(!isSameTranscript('', '/p/a.jsonl'))
})

// ── The persisted drain cursor ───────────────────────────────────────────────

test('the cursor survives a restart, and junk on disk means start from the top', () => {
  assert.deepEqual(parseCursor(serializeCursor({ lines: 12, bytes: 3400 })), { lines: 12, bytes: 3400 })
  assert.deepEqual(parseCursor(null), { lines: 0, bytes: 0 })
  assert.deepEqual(parseCursor('half a fi'), { lines: 0, bytes: 0 })
  assert.deepEqual(parseCursor('{"lines":-4,"bytes":"x"}'), { lines: 0, bytes: 0 })
})

test('the drain applies each line once and leaves a half written tail alone', () => {
  const text = '{"id":"a-1","payload":{}}\n{"id":"a-2","payload":{}}\n{"id":"a-3","pay'
  const first = decideDrain({ cursor: { lines: 0, bytes: 0 }, text })
  assert.deepEqual(
    first.fresh.map((l) => JSON.parse(l).id),
    ['a-1', 'a-2'],
    'the unfinished third line is not an event yet',
  )
  assert.equal(first.next.lines, 2)
  assert.equal(first.reset, false)

  const again = decideDrain({ cursor: first.next, text })
  assert.deepEqual(again.fresh, [], 'a re-read of the same file applies nothing')

  const finished = decideDrain({ cursor: first.next, text: `${text}load":{}}\n` })
  assert.deepEqual(
    finished.fresh.map((l) => JSON.parse(l).id),
    ['a-3'],
    'the tail arrives on the next drain, exactly once',
  )
})

test('a rotated file is drained from the top rather than skipped', () => {
  const held = { lines: 40, bytes: 4_000 }
  const decision = decideDrain({ cursor: held, text: '{"id":"b-1","payload":{}}\n' })
  assert.equal(decision.reset, true, 'the file shrank under the cursor')
  assert.equal(decision.fresh.length, 1)
  assert.equal(decision.next.lines, 1)
})

test('parseSpoolLine tolerates a half written tail, and an older forwarder\u2019s line', () => {
  assert.equal(parseSpoolLine(''), null)
  assert.equal(parseSpoolLine('{"id":"a-1","payl'), null, 'the tail of a line being appended')
  assert.equal(parseSpoolLine('{"payload":{}}'), null, 'no id is no line')
  assert.equal(parseSpoolLine('{"id":"a-1"}'), null, 'no payload is no line')
  assert.equal(parseSpoolLine('[1,2]'), null)
  assert.deepEqual(parseSpoolLine('{"id":"a-1","receivedAt":9,"event":"Stop","payload":{"a":1}}'), {
    id: 'a-1',
    receivedAt: 9,
    event: 'Stop',
    payload: { a: 1 },
  })
  assert.equal(
    parseSpoolLine('{"seq":120,"receivedAt":9,"event":"Stop","payload":{"a":1}}')!.id,
    'seq-120',
    'a line from the previous forwarder is read, not dropped, during an upgrade',
  )
})

// ── Dedupe ───────────────────────────────────────────────────────────────────

test('a tool event is deduped on its OWN id, so a double registration posts one row', () => {
  const payload = {
    session_id: 's',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'tu-1',
    prompt_id: 'p-1',
    duration_ms: 12,
  }
  const key = dedupeKeyOf(payload, 'line-1')
  assert.equal(
    key,
    dedupeKeyOf({ ...payload, duration_ms: 99 }, 'line-2'),
    'two forwarder invocations of ONE tool call are one occurrence',
  )
  assert.notEqual(key, dedupeKeyOf({ ...payload, hook_event_name: 'PreToolUse' }, 'line-1'))
  assert.notEqual(key, dedupeKeyOf({ ...payload, session_id: 'other' }, 'line-1'))
})

test('an id less event takes the line id, so a second genuine occurrence survives', () => {
  // The defect this pins: Stop, SessionStart, PreCompact and friends carry no
  // id of their own, so two real occurrences inside one prompt collapsed into
  // one key and the second was dropped (no second marker, no second turn end).
  const stop = { session_id: 's', hook_event_name: 'Stop', prompt_id: 'p-1' }
  assert.notEqual(
    dedupeKeyOf(stop, 'line-1'),
    dedupeKeyOf(stop, 'line-2'),
    'two Stops are two Stops',
  )
  assert.equal(
    dedupeKeyOf(stop, 'line-1'),
    dedupeKeyOf(stop, 'line-1'),
    'the SAME line re-read is still one occurrence, which is what the cursor reset needs',
  )
  for (const event of ID_LESS_EVENTS) {
    const payload = { session_id: 's', hook_event_name: event }
    assert.notEqual(
      dedupeKeyOf(payload, 'l-1'),
      dedupeKeyOf(payload, 'l-2'),
      `${event} has no occurrence identity of its own`,
    )
  }
})

test('two children stopping in ONE prompt are two occurrences, not one', () => {
  // The real defect, on the real payloads: the stage 8 probe's two SubagentStop
  // records share their session, their event name and their prompt id, and a
  // SubagentStop carries no tool_use_id and no task_id at all. Before
  // SubagentStop joined ID_LESS_EVENTS their keys were byte identical and the
  // second child's stop was dropped in silence, so the second helper row never
  // closed. The loop above iterates a constant and would not have named this.
  const stops = PROBE.filter((record) => record.hook === 'SubagentStop')
  assert.ok(stops.length >= 2, 'the probe should carry both children stopping')
  const [first, second] = stops
  assert.equal(
    first!.payload.prompt_id,
    second!.payload.prompt_id,
    'the fixture only proves the rule if both stops really are in one prompt',
  )
  assert.notEqual(first!.payload.agent_id, second!.payload.agent_id, 'two different children')
  assert.equal(first!.payload.tool_use_id, undefined, 'a stop carries no id of its own')
  assert.notEqual(
    dedupeKeyOf(first!.payload, 'line-1'),
    dedupeKeyOf(second!.payload, 'line-2'),
    'the second child stop must survive the dedupe',
  )
  assert.equal(
    dedupeKeyOf(first!.payload, 'line-1'),
    dedupeKeyOf(first!.payload, 'line-1'),
    'and the SAME line re-read is still one occurrence',
  )
})

test('the dedupe set is bounded, so a long lived daemon cannot grow forever', () => {
  const dedupe = createDedupe(3)
  dedupe.note('a')
  dedupe.note('b')
  dedupe.note('c')
  dedupe.note('d')
  assert.equal(dedupe.size(), 3)
  assert.equal(dedupe.seen('a'), false, 'the oldest key fell out')
  assert.equal(dedupe.seen('d'), true)
  assert.ok(DEDUPE_LIMIT >= 128, 'the default has to outlive a long turn')
})

// ── Layout drift ─────────────────────────────────────────────────────────────

test('the state root is the one lib/cursor-store.ts already uses', () => {
  const env = { BGOS_PLUGIN_STATE_DIR: '' }
  const home = '/home/kc'
  const cursorPath = resolveCursorFilePath({ assistantId: '901', cwd: '/work', env, home })
  assert.equal(hookStateRoot(env, home), dirname(dirname(cursorPath)))
  assert.equal(
    hookStateRoot({ BGOS_PLUGIN_STATE_DIR: '/custom' }, home),
    '/custom',
    'the env override is honoured on both sides',
  )
  assert.equal(sessionSpoolPath('/state', 'sess-1'), join('/state', 'hooks', 'sess-1', SPOOL_FILE_NAME))
  assert.equal(sessionCursorPath('/state', 'sess-1'), join('/state', 'hooks', 'sess-1', CURSOR_FILE_NAME))
  assert.equal(hooksRoot('/state'), join('/state', 'hooks'))
})

// ── The watcher shell ────────────────────────────────────────────────────────

const ROOT = hooksRoot('/state')

interface Harness {
  fs: IntakeFs
  files: Map<string, string>
  write(sessionKey: string, lines: string[]): void
  touch(sessionKey: string, mtimeMs: number): void
  removed: string[]
  watched: string[]
  closed: number
  timers: Array<{ fn: () => void; ms: number }>
  cleared: number
  events: Array<Record<string, unknown>>
  start(opts?: Record<string, unknown>): ReturnType<typeof startHookIntake>
}

function harness(nowFn: () => number = () => 1_000_000): Harness {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const removed: string[] = []
  const watched: string[] = []
  const events: Array<Record<string, unknown>> = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let closed = 0
  let cleared = 0
  const childrenOf = (dir: string): string[] => {
    const prefix = `${dir}/`.replace(/\\/g, '/')
    const seen = new Set<string>()
    for (const path of [...files.keys(), ...mtimes.keys()]) {
      const normal = path.replace(/\\/g, '/')
      if (!normal.startsWith(prefix)) continue
      const rest = normal.slice(prefix.length)
      if (!rest) continue
      seen.add(rest.split('/')[0]!)
    }
    return [...seen]
  }
  const fs: IntakeFs = {
    readdir: (dir) => childrenOf(dir),
    readFile: (path) => files.get(path) ?? null,
    statSize: (path) => (files.has(path) ? Buffer.byteLength(files.get(path)!, 'utf8') : null),
    statMtime: (path) => mtimes.get(path) ?? null,
    writeFile: (path, text) => {
      files.set(path, text)
      mtimes.set(path, nowFn())
    },
    removeDir: (path) => {
      removed.push(path)
      for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key)
      for (const key of [...mtimes.keys()]) if (key.startsWith(path)) mtimes.delete(key)
    },
  }
  return {
    fs,
    files,
    removed,
    watched,
    get closed() {
      return closed
    },
    timers,
    get cleared() {
      return cleared
    },
    events,
    write(sessionKey, lines) {
      const dir = join(ROOT, sessionKey)
      const path = join(dir, SPOOL_FILE_NAME)
      files.set(path, (files.get(path) ?? '') + lines.map((l) => `${l}\n`).join(''))
      mtimes.set(dir, nowFn())
      mtimes.set(path, nowFn())
    },
    touch(sessionKey, mtimeMs) {
      const dir = join(ROOT, sessionKey)
      mtimes.set(dir, mtimeMs)
      for (const name of childrenOf(dir)) mtimes.set(join(dir, name), mtimeMs)
    },
    start(opts: Record<string, unknown> = {}) {
      return startHookIntake({
        stateRoot: '/state',
        projectDir: PROJECT_DIR,
        onEvent: (payload) => events.push(payload),
        isArmed: () => true,
        provenTranscript: () => OURS,
        now: nowFn,
        fs,
        watch: (dir) => {
          watched.push(dir)
          return {
            close: () => {
              closed += 1
            },
          }
        },
        setIntervalFn: (fn, ms) => {
          timers.push({ fn, ms })
          return { unref: () => {} }
        },
        clearIntervalFn: () => {
          cleared += 1
        },
        ...opts,
      })
    },
  }
}

let lineCounter = 0
const spooled = (payload: Record<string, unknown>, id?: string): string => {
  lineCounter += 1
  return JSON.stringify({
    id: id ?? `l-${lineCounter}`,
    receivedAt: 1_000_000,
    event: String(payload.hook_event_name ?? ''),
    payload,
  })
}

const ourPayload = (over: Record<string, unknown> = {}) => ({
  session_id: 'sess-ours',
  transcript_path: OURS,
  cwd: '/work/atlas',
  hook_event_name: 'PreToolUse',
  prompt_id: 'p-1',
  tool_use_id: 'tu-1',
  ...over,
})

const strangerPayload = (over: Record<string, unknown> = {}) => ({
  session_id: 'sess-stranger',
  transcript_path: STRANGER,
  cwd: '/work/atlas',
  hook_event_name: 'PreToolUse',
  tool_use_id: 'sx-1',
  ...over,
})

test('the intake drains the session that proved itself, and nobody else', () => {
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload())])
  h.write('sess-stranger', [spooled(strangerPayload())])
  h.write('sess-theirs', [
    spooled({
      session_id: 'sess-theirs',
      transcript_path: THEIRS,
      hook_event_name: 'PreToolUse',
      tool_use_id: 'x',
    }),
  ])
  const intake = h.start()
  assert.equal(h.events.length, 1, 'exactly one session was consumed')
  assert.equal(h.events[0]!.session_id, 'sess-ours')
  assert.equal(intake.bound(), 'sess-ours')
  intake.stop()
})

test('a session with no proof yet is BUFFERED, then released the moment it proves itself', () => {
  const h = harness()
  // The chain has not proven anything yet (no reply marker), and the first
  // lines of the turn arrive before the prompt does.
  h.write('sess-ours', [
    spooled(ourPayload({ hook_event_name: 'SessionStart', tool_use_id: undefined })),
    spooled(ourPayload({ tool_use_id: 'tu-early' })),
  ])
  const intake = h.start({ provenTranscript: () => null, provesDelivery: (p: string) => p.includes('audit the deploy') })
  assert.equal(h.events.length, 0, 'nothing is posted on a guess')
  assert.equal(intake.bound(), null)

  h.write('sess-ours', [
    spooled(
      ourPayload({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'please audit the deploy script',
        tool_use_id: undefined,
      }),
    ),
  ])
  intake.pump()
  assert.equal(intake.bound(), 'sess-ours')
  assert.deepEqual(
    h.events.map((e) => e.hook_event_name),
    ['SessionStart', 'PreToolUse', 'UserPromptSubmit'],
    'the buffered opening of the turn is released in order, ahead of the proof',
  )
  intake.stop()
})

test('an unproven session is dropped once its buffer window has passed', () => {
  let now = 1_000_000
  const h = harness(() => now)
  h.write('sess-stranger', [spooled(strangerPayload())])
  const intake = h.start({ provenTranscript: () => null })
  assert.equal(h.events.length, 0)
  now += UNBOUND_BUFFER_MS + 1
  // It proves itself LATER; the window is over and the old lines are gone.
  h.write('sess-stranger', [
    spooled(
      strangerPayload({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'the delivered text',
        tool_use_id: undefined,
      }),
    ),
  ])
  intake.pump()
  assert.deepEqual(
    h.events.map((e) => e.hook_event_name),
    [],
    'a session that never proved itself inside the window posts nothing at all',
  )
  intake.stop()
})

test('a daemon that is not armed consumes nothing at all', () => {
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload())])
  // The lock holder rule lives in server.ts; this is its other half, checked on
  // every pump so a daemon that stands down between two pumps stops at once.
  const intake = h.start({ isArmed: () => false })
  assert.equal(h.events.length, 0)
  assert.equal(intake.bound(), null, 'a passive daemon does not even bind')
  intake.stop()
})

test('a re-read of the same file posts nothing a second time', () => {
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload())])
  const intake = h.start()
  assert.equal(h.events.length, 1)
  intake.pump()
  intake.pump()
  assert.equal(h.events.length, 1, 'the cursor holds')
  h.write('sess-ours', [spooled(ourPayload({ hook_event_name: 'PostToolUse' }))])
  intake.pump()
  assert.equal(h.events.length, 2, 'a genuinely new line still arrives')
  intake.stop()
})

test('the cursor is on DISK, so a restart does not replay the session', () => {
  // The defect this pins: the cursor lived only in memory. Every daemon start,
  // and every lock re-arm, re-drained the whole spool from byte zero and posted
  // every card, marker and step of that session again.
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload()), spooled(ourPayload({ tool_use_id: 'tu-2' }))])
  const first = h.start()
  assert.equal(h.events.length, 2)
  const cursorPath = join(ROOT, 'sess-ours', CURSOR_FILE_NAME)
  assert.deepEqual(parseCursor(h.files.get(cursorPath) ?? null), { lines: 2, bytes: expectedBytes(h) })
  first.stop()

  // A brand new intake over the same directory: a restart, or the other daemon
  // taking the lock. It must not re-post one row.
  const second = h.start()
  assert.equal(h.events.length, 2, 'the persisted cursor is read on start')
  h.write('sess-ours', [spooled(ourPayload({ tool_use_id: 'tu-3' }))])
  second.pump()
  assert.equal(h.events.length, 3, 'and the next real line still lands')
  second.stop()
})

function expectedBytes(h: Harness): number {
  const text = h.files.get(join(ROOT, 'sess-ours', SPOOL_FILE_NAME)) ?? ''
  return Buffer.byteLength(text, 'utf8')
}

test('a half written trailing line waits for its newline', () => {
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload())])
  const intake = h.start()
  assert.equal(h.events.length, 1)
  // A forwarder caught mid append: the daemon must not parse half a record,
  // and must not skip it either.
  const path = join(ROOT, 'sess-ours', SPOOL_FILE_NAME)
  const whole = h.files.get(path)!
  const partial = spooled(ourPayload({ tool_use_id: 'tu-2' }))
  h.files.set(path, `${whole}${partial.slice(0, 30)}`)
  intake.pump()
  assert.equal(h.events.length, 1, 'half a line is not an event')
  h.files.set(path, `${whole}${partial}\n`)
  intake.pump()
  assert.equal(h.events.length, 2, 'it arrives whole on the next drain')
  intake.stop()
})

test('the same occurrence spooled twice is delivered once', () => {
  const h = harness()
  const payload = ourPayload()
  h.write('sess-ours', [spooled(payload, 'from-plugin-hooks'), spooled(payload, 'from-settings-entry')])
  const intake = h.start()
  assert.equal(h.events.length, 1, 'a marketplace install that ALSO has the settings entry fires both')
  intake.stop()
})

test('a rotation is drained from the start rather than skipped', () => {
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload()), spooled(ourPayload({ tool_use_id: 'tu-2' }))])
  const intake = h.start()
  assert.equal(h.events.length, 2)
  // The forwarder rotated: a brand new, much shorter file under the cursor.
  h.files.set(join(ROOT, 'sess-ours', SPOOL_FILE_NAME), `${spooled(ourPayload({ tool_use_id: 'tu-3' }))}\n`)
  intake.pump()
  assert.equal(h.events.length, 3, 'the post rotation line is not lost behind a stale cursor')
  intake.stop()
})

test('a session directory is swept once its SessionEnd has been consumed', () => {
  const h = harness()
  h.write('sess-ours', [
    spooled(ourPayload()),
    spooled(ourPayload({ hook_event_name: 'SessionEnd', tool_use_id: undefined })),
  ])
  const intake = h.start()
  assert.equal(h.events.length, 2)
  assert.deepEqual(h.removed, [join(ROOT, 'sess-ours')], 'the session said goodbye; nothing will append again')
  assert.equal(intake.bound(), null, 'and the daemon is free to bind the next session')
  intake.stop()
})

test('a session directory nobody has touched for half an hour is swept', () => {
  const now = 4_000_000
  const h = harness(() => now)
  // Two drained directories, one stale and one fresh. Only the stale one may
  // go, or a session simply between turns loses its spool under a live
  // forwarder.
  h.write('sess-abandoned', [spooled(strangerPayload())])
  h.write('sess-between-turns', [spooled(ourPayload())])
  const intake = h.start()
  // Both have been drained (the stranger's lines are held, unproven). Now age
  // one of them: a directory is swept on how long ago anything in it was
  // touched, never on whether we happened to consume it.
  h.touch('sess-abandoned', now - SESSION_SWEEP_MS - 1)
  h.touch('sess-between-turns', now - 1_000)
  intake.pump()
  assert.deepEqual(
    h.removed,
    [join(ROOT, 'sess-abandoned')],
    'exactly the abandoned directory, and only after the sweep window',
  )
  intake.stop()
})

test('a throwing handler never stops the drain', () => {
  const h = harness()
  h.write('sess-ours', [spooled(ourPayload()), spooled(ourPayload({ tool_use_id: 'tu-2' }))])
  let seen = 0
  const intake = h.start({
    onEvent: () => {
      seen += 1
      if (seen === 1) throw new Error('the poster blew up')
    },
  })
  assert.equal(seen, 2, 'the second line still got its chance')
  intake.stop()
})

test('the poll tightens while a turn is live and stop() closes everything', () => {
  const h = harness()
  let live = false
  const intake = h.start({ isTurnLive: () => live })
  assert.equal(h.timers.at(-1)!.ms, INTAKE_POLL_IDLE_MS)
  assert.deepEqual(h.watched, [ROOT], 'one watch, on the spool root')
  live = true
  h.timers.at(-1)!.fn()
  assert.equal(h.timers.at(-1)!.ms, INTAKE_POLL_LIVE_MS, 'a live turn wants the card while the tool runs')
  intake.stop()
  assert.equal(h.closed, 1, 'the watcher is closed')
  assert.ok(h.cleared >= 1, 'the poll timer is cleared')
  const before = h.events.length
  intake.pump()
  assert.equal(h.events.length, before, 'a stopped intake consumes nothing')
  intake.stop()
  assert.equal(h.closed, 1, 'stop is idempotent')
})
