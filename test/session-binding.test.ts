/**
 * Positive self-session transcript binding: the contextPct gauge must track
 * THIS daemon's session, not whichever transcript in the shared project dir
 * was touched last (the frozen/wrong-gauge bug).
 *
 * Pure-function tests for the resolution chain plus fs-backed tests for the
 * binder, using fixture transcripts whose entry shapes mirror real ones
 * (tool_result marker entries, assistant usage entries).
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  tailContainsMarker,
  findMarkerFile,
  resolveBinding,
  AMBIGUITY_WINDOW_MS,
  POSITIVE_BINDING_SOURCES,
  SessionTranscriptBinder,
} from '../lib/session-binding.ts'
import { mungeCwd, UsageTracker } from '../lib/usage-report.ts'
import { decideSessionAdmission } from '../lib/hook-intake.ts'
import { claudeConfigDir } from '../bin/bgos-install-method.mjs'

// Real-shape fixture lines.
const markerLine = (messageId: number): string =>
  JSON.stringify({
    parentUuid: '92043e68-88c6-4bd7-8860-6bc2079a944c',
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: 'toolu_01Kd23Mgcx8mkHKzoUBaqWrB',
          type: 'tool_result',
          content: [{ type: 'text', text: `Sent (message_id: ${messageId})` }],
        },
      ],
    },
  })

// Model pinned to a 200k family: these tests assert WHICH transcript the
// binder reads, so the percentages below are just a legible way to tell the
// fixtures apart. A 1M-context model id here would make every expected value
// a function of the window table instead.
const assistantLine = (usedTokens: number): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5',
      id: 'msg_fixture',
      role: 'assistant',
      usage: {
        input_tokens: usedTokens,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })

// ── tailContainsMarker ───────────────────────────────────────────────────────

test('marker matches a real tool_result user entry', () => {
  const chunk = `${assistantLine(1000)}\n${markerLine(20287)}\n`
  assert.ok(tailContainsMarker(chunk, 'Sent (message_id: 20287'))
  assert.ok(!tailContainsMarker(chunk, 'Sent (message_id: 99999'))
})

test('marker inside a non-user line does not match', () => {
  const prose = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: 'discussing Sent (message_id: 777) in prose' },
  })
  assert.ok(!tailContainsMarker(`${prose}\n`, 'Sent (message_id: 777'))
})

// ── findMarkerFile ───────────────────────────────────────────────────────────

test('newest marker wins across files', () => {
  const tails = [
    { name: 'old.jsonl', chunk: `${markerLine(100)}\n` },
    { name: 'ours.jsonl', chunk: `${markerLine(200)}\n` },
  ]
  // markers are newest-first
  assert.equal(
    findMarkerFile(tails, ['Sent (message_id: 200', 'Sent (message_id: 100']),
    'ours.jsonl',
  )
  // fall back to an older marker when the newest is not on disk yet
  assert.equal(
    findMarkerFile(tails, ['Sent (message_id: 999', 'Sent (message_id: 100']),
    'old.jsonl',
  )
  assert.equal(findMarkerFile(tails, []), null)
})

// ── resolveBinding priority chain ────────────────────────────────────────────

// Every resolveBinding call passes an explicit `now`; the ambiguity rule
// (rule 5) measures candidate mtimes against it. RECENT_* sit inside the
// AMBIGUITY_WINDOW_MS window, STALE sits just outside it.
const NOW = 100 * 60_000
const RECENT_A = NOW - 2000
const RECENT_B = NOW - 1000
const STALE = NOW - AMBIGUITY_WINDOW_MS - 1

// Two recent candidates plus a stale env-id file: rule 5 alone would refuse
// this set as ambiguous, so every positive-signal test below also proves its
// signal (marker / sticky marker / env / sticky previous) beats ambiguity.
const cands = [
  { name: 'a.jsonl', mtimeMs: RECENT_A },
  { name: 'b.jsonl', mtimeMs: RECENT_B },
  { name: 'env-id.jsonl', mtimeMs: STALE },
]

test('marker evidence beats everything, two-recent ambiguity included', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: 'env-id',
    markerFile: 'a.jsonl',
    previous: { name: 'b.jsonl', source: 'newest-mtime' },
    now: NOW,
  })
  assert.deepEqual(b, { name: 'a.jsonl', source: 'marker' })
})

test('a marker-proven binding is sticky across scan misses', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: 'env-id',
    markerFile: null,
    previous: { name: 'a.jsonl', source: 'marker' },
    now: NOW,
  })
  assert.deepEqual(b, { name: 'a.jsonl', source: 'marker' })
})

test('env session id binds when its file exists, ambiguity and staleness aside', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: 'env-id',
    markerFile: null,
    previous: null,
    now: NOW,
  })
  // env-id.jsonl is stale and a/b are both recent; the env id still wins
  // because it is a positive signal, not an mtime guess.
  assert.deepEqual(b, { name: 'env-id.jsonl', source: 'env' })
})

test('env session id is ignored when its file is absent (--continue launch)', () => {
  // Rewritten for the ambiguity rule: the old expectation bound b.jsonl by
  // newest mtime among several live candidates, which is exactly the guess
  // rule 5 now refuses. One recent + one stale keeps the fallthrough
  // unambiguous, so the test still pins the env-file-absent behavior.
  const b = resolveBinding({
    candidates: [
      { name: 'a.jsonl', mtimeMs: STALE },
      { name: 'b.jsonl', mtimeMs: RECENT_B },
    ],
    envSessionId: 'env-id',
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.deepEqual(b, { name: 'b.jsonl', source: 'newest-mtime' })
})

test('sticky previous binding: a foreign session cannot steal it via mtime', () => {
  const b = resolveBinding({
    candidates: cands,
    envSessionId: null,
    markerFile: null,
    previous: { name: 'a.jsonl', source: 'newest-mtime' },
    now: NOW,
  })
  // b.jsonl is newer and both are recent (ambiguous for rule 5), but the
  // held binding survives without falling through to a guess.
  assert.deepEqual(b, { name: 'a.jsonl', source: 'newest-mtime' })
})

test('newest-mtime fires only when unambiguous; empty dir yields null', () => {
  // Rewritten for the ambiguity rule: the old test bound the newest of
  // three live candidates with no signal at all, the always-guess behavior
  // rule 5 no longer has. A sole recent candidate among stale ones is the
  // unambiguous case that still binds.
  assert.deepEqual(
    resolveBinding({
      candidates: [
        { name: 'a.jsonl', mtimeMs: STALE },
        { name: 'b.jsonl', mtimeMs: RECENT_B },
        { name: 'c.jsonl', mtimeMs: STALE - 5000 },
      ],
      envSessionId: null,
      markerFile: null,
      previous: null,
      now: NOW,
    }),
    { name: 'b.jsonl', source: 'newest-mtime' },
  )
  assert.equal(
    resolveBinding({
      candidates: [],
      envSessionId: 'env-id',
      markerFile: 'x.jsonl',
      previous: { name: 'y.jsonl', source: 'marker' },
      now: NOW,
    }),
    null,
  )
})

// ── resolveBinding ambiguity refusal (rule 5) ────────────────────────────────

test('two recent candidates and no positive signal refuse to bind', () => {
  const b = resolveBinding({
    candidates: [
      { name: 'a.jsonl', mtimeMs: RECENT_A },
      { name: 'b.jsonl', mtimeMs: RECENT_B },
    ],
    envSessionId: null,
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.equal(b, null)
})

test('one recent + one stale binds the recent one', () => {
  const b = resolveBinding({
    candidates: [
      { name: 'stale.jsonl', mtimeMs: STALE },
      { name: 'live.jsonl', mtimeMs: RECENT_B },
    ],
    envSessionId: null,
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.deepEqual(b, { name: 'live.jsonl', source: 'newest-mtime' })
})

test('a sole candidate binds even when stale', () => {
  // Nothing else exists to confuse it with, so staleness is no objection.
  const b = resolveBinding({
    candidates: [{ name: 'only.jsonl', mtimeMs: STALE }],
    envSessionId: null,
    markerFile: null,
    previous: null,
    now: NOW,
  })
  assert.deepEqual(b, { name: 'only.jsonl', source: 'newest-mtime' })
})

// ── SessionTranscriptBinder (fs-backed) ──────────────────────────────────────

function makeProjectDir(cwd: string): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'binder-test-'))
  const dir = join(home, 'projects', mungeCwd(cwd))
  mkdirSync(dir, { recursive: true })
  return { home, dir }
}

test('binder: marker scan rebinds away from a newer foreign transcript', () => {
  const cwd = '/work/space'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  // Ours: contains our reply marker, older mtime.
  writeFileSync(join(dir, 'ours.jsonl'), `${assistantLine(40_000)}\n${markerLine(20287)}\n`)
  utimesSync(join(dir, 'ours.jsonl'), new Date(now - 60_000), new Date(now - 60_000))
  // Foreign: newer mtime, would win under the old newest-mtime heuristic.
  writeFileSync(join(dir, 'foreign.jsonl'), `${assistantLine(190_000)}\n`)

  const binder = new SessionTranscriptBinder(cwd, { claudeHome: home })
  binder.recordReplyMessageId(20287)
  const resolved = binder.resolve(now)
  assert.ok(resolved)
  assert.equal(resolved.binding.name, 'ours.jsonl')
  assert.equal(resolved.binding.source, 'marker')
  // And the pct comes from OUR transcript (40k/200k = 20), not the foreign 95.
  assert.equal(binder.readContextPct(), 20)
})

test('binder: falls back to newest-mtime with a log line when no signal exists', () => {
  const cwd = '/work/other'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  writeFileSync(join(dir, 'only.jsonl'), `${assistantLine(100_000)}\n`)
  const logs: string[] = []
  const binder = new SessionTranscriptBinder(cwd, {
    claudeHome: home,
    log: (m) => logs.push(m),
  })
  const resolved = binder.resolve(now)
  assert.ok(resolved)
  assert.equal(resolved.binding.source, 'newest-mtime')
  assert.ok(
    logs.some((l) => l.includes('newest-mtime') && l.includes('unambiguous')),
  )
  assert.equal(binder.readContextPct(), 50)
})

test('binder: refuses to guess between two recent transcripts, logs once', () => {
  const cwd = '/work/ambiguous'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  writeFileSync(join(dir, 'one.jsonl'), `${assistantLine(50_000)}\n`)
  writeFileSync(join(dir, 'two.jsonl'), `${assistantLine(60_000)}\n`)
  const logs: string[] = []
  const binder = new SessionTranscriptBinder(cwd, {
    claudeHome: home,
    log: (m) => logs.push(m),
  })
  // Both transcripts are recent and nothing positive distinguishes them:
  // stay unbound rather than track a possible neighbour, and say so once.
  assert.equal(binder.resolve(now), null)
  assert.equal(binder.readContextPct(), null)
  assert.equal(binder.resolve(now), null)
  assert.equal(
    logs.filter((l) => l.includes('refusing to guess')).length,
    1,
  )
  // The first reply marker resolves the ambiguity with positive proof.
  writeFileSync(
    join(dir, 'one.jsonl'),
    `${assistantLine(50_000)}\n${markerLine(31337)}\n`,
  )
  binder.recordReplyMessageId(31337)
  const resolved = binder.resolve(now)
  assert.ok(resolved)
  assert.equal(resolved.binding.name, 'one.jsonl')
  assert.equal(resolved.binding.source, 'marker')
  assert.equal(binder.readContextPct(), 25)
})

test('binder: env session id binds a fresh launch', () => {
  const cwd = '/work/fresh'
  const { home, dir } = makeProjectDir(cwd)
  writeFileSync(join(dir, 'sess-123.jsonl'), `${assistantLine(20_000)}\n`)
  writeFileSync(join(dir, 'other.jsonl'), `${assistantLine(180_000)}\n`)
  const binder = new SessionTranscriptBinder(cwd, {
    claudeHome: home,
    envSessionId: 'sess-123',
  })
  const resolved = binder.resolve()
  assert.ok(resolved)
  assert.deepEqual(resolved.binding, { name: 'sess-123.jsonl', source: 'env' })
  assert.equal(binder.readContextPct(), 10)
})

test('binder: missing project dir degrades to null, never throws', () => {
  const binder = new SessionTranscriptBinder('/nope', {
    claudeHome: join(tmpdir(), 'binder-test-does-not-exist'),
  })
  assert.equal(binder.resolve(), null)
  assert.equal(binder.readContextPct(), null)
  assert.equal(binder.readBoundTail(), null)
})

// ── The hook payload is the strongest evidence there is (stage 4) ────────────
//
// Every Claude Code hook payload carries transcript_path for the session that
// fired it. That is the CLI naming our own file, which beats inferring it from
// a tool result the CLI echoed. Once hooks are live, the refusal branch above
// ("several recent transcripts and no positive signal yet") stops firing.

test('a hook binding outranks a marker hit and stays sticky', () => {
  const candidates = [
    { name: 'hook.jsonl', mtimeMs: 1 },
    { name: 'marker.jsonl', mtimeMs: 9_999 },
  ]
  const bound = resolveBinding({
    candidates,
    envSessionId: 'marker',
    markerFile: 'marker.jsonl',
    hookFile: 'hook.jsonl',
    previous: null,
    now: 10_000,
  })
  assert.deepEqual(bound, { name: 'hook.jsonl', source: 'hook' })

  // Sticky, for the same reason a marker binding is: the hook already proved
  // the file, and a later scan that misses proves nothing.
  assert.deepEqual(
    resolveBinding({
      candidates,
      envSessionId: 'marker',
      markerFile: 'marker.jsonl',
      hookFile: null,
      previous: bound,
      now: 10_000,
    }),
    { name: 'hook.jsonl', source: 'hook' },
  )
})

test('a hook naming a transcript that does not exist is ignored, not trusted', () => {
  assert.deepEqual(
    resolveBinding({
      candidates: [{ name: 'real.jsonl', mtimeMs: 5 }],
      envSessionId: null,
      markerFile: null,
      hookFile: 'ghost.jsonl',
      previous: null,
      now: 10,
    }),
    { name: 'real.jsonl', source: 'newest-mtime' },
  )
})

test('noteHookSession takes the transcript path, and falls back to the session id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoai-hook-binding-'))
  const projectDir = join(dir, '.claude', 'projects', '-work')
  mkdirSync(projectDir, { recursive: true })
  // Two plausible transcripts and no positive signal: the old chain refuses.
  writeFileSync(join(projectDir, 'ours.jsonl'), '{"type":"user"}\n')
  writeFileSync(join(projectDir, 'stranger.jsonl'), '{"type":"user"}\n')

  const binder = new SessionTranscriptBinder('/work', { claudeHome: join(dir, '.claude') })
  assert.equal(binder.resolve(Date.now()), null, 'ambiguous, so it refuses to guess')

  // The PATH decides, not the id. A --continue launch carries a freshly minted
  // session id while the CLI keeps appending to the transcript of the session
  // it resumed, so deriving the file name from the id would bind the wrong one
  // (or nothing at all). The header of lib/session-binding.ts records that
  // exact observation from the live fleet.
  binder.noteHookSession('a-fresh-id-nobody-wrote', join(projectDir, 'ours.jsonl'))
  const resolved = binder.resolve(Date.now())
  assert.equal(resolved?.binding.source, 'hook')
  assert.equal(resolved?.binding.name, 'ours.jsonl')

  // A payload with no transcript_path still names the session, and the CLI's
  // transcript file is always <session id>.jsonl.
  const second = new SessionTranscriptBinder('/work', { claudeHome: join(dir, '.claude') })
  second.noteHookSession('stranger', '')
  assert.equal(second.resolve(Date.now())?.binding.name, 'stranger.jsonl')

  // And the project dir it exposes for the hook intake is the real one.
  assert.equal(binder.projectDirectory, projectDir)
})

// ── the proof half of the chain (what the hook intake is allowed to bind on) ─

test('provenTranscriptPath answers only for POSITIVE proof, never for a guess', () => {
  // lib/hook-intake.ts binds a whole activity rail on this answer: a newest
  // mtime guess would bind the rail to a neighbour's session, which is the
  // defect the intake's admission rule exists to prevent.
  const cwd = '/work/proof'
  const { home, dir } = makeProjectDir(cwd)
  const now = Date.now()
  writeFileSync(join(dir, 'only.jsonl'), `${assistantLine(100_000)}\n`)
  const binder = new SessionTranscriptBinder(cwd, { claudeHome: home })
  assert.equal(binder.resolve(now)!.binding.source, 'newest-mtime', 'the guess still resolves')
  assert.equal(binder.provenTranscriptPath(now), null, 'but it is not PROOF, so it does not answer here')

  // A reply marker is proof: we minted that message id.
  writeFileSync(join(dir, 'only.jsonl'), `${assistantLine(100_000)}\n${markerLine(31337)}\n`)
  binder.recordReplyMessageId(31337)
  assert.equal(binder.provenTranscriptPath(now), join(dir, 'only.jsonl'))
})

test('POSITIVE_BINDING_SOURCES is the proof set, and excludes the last resort', () => {
  assert.deepEqual([...POSITIVE_BINDING_SOURCES].sort(), ['env', 'hook', 'marker'])
  assert.ok(!POSITIVE_BINDING_SOURCES.includes('newest-mtime'))
})

// ── where the binder looks (mission 104 fix round, C2) ──────────────────────
//
// The hook intake refuses, as foreign-project, every payload whose
// transcript_path is not under sessionBinder.projectDirectory, and that dir was
// built from the relocated process cwd under a hard-coded ~/.claude. On a
// marketplace install (cwd is the plugin cache) or with CLAUDE_CONFIG_DIR set,
// the agent's OWN hook events were refused, so hookTurnLive never set:
// agent-state.json turnInFlight stayed false (the watcher's safe moment,
// finding 9) and the session pin was never written (finding 7).

test('binder: a custom claudeHome (CLAUDE_CONFIG_DIR) and the agent folder find the agent transcript, and its hooks are not foreign', () => {
  const root = mkdtempSync(join(tmpdir(), 'binder-config-dir-'))
  const home = join(root, 'home')
  const configDir = join(root, 'claude-config')
  const agentFolder = '/home/kc/agents/vexa'
  const pluginCache = '/home/kc/.claude/plugins/cache/hoai-marketplace/hoai/0.62.0'
  const projectDir = join(configDir, 'projects', mungeCwd(agentFolder))
  mkdirSync(projectDir, { recursive: true })
  const sid = '8c1f2d3e-4a5b-4c6d-8e7f-901234567890'
  const transcript = join(projectDir, `${sid}.jsonl`)
  writeFileSync(transcript, `${assistantLine(50_000)}\n`)
  // hoai launches with --session-id / --resume <pinned id>, so the CLI hands
  // its MCP child that id: the env proof of the binding chain.
  const opts = { envSessionId: sid }

  // What server.ts builds: LAUNCH_CWD under claudeConfigDir (trimmed env, else
  // <home>/.claude), the same rule hoai-core's sessionTranscriptPath uses.
  const claudeHome = claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: `  ${configDir}  ` }, home })
  assert.equal(claudeHome, configDir, 'CLAUDE_CONFIG_DIR is trimmed')
  const binder = new SessionTranscriptBinder(agentFolder, { claudeHome, ...opts })
  assert.equal(binder.projectDirectory, projectDir)
  assert.equal(binder.provenTranscriptPath(), transcript)
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: sid, transcriptPath: transcript, event: 'SessionStart' },
      projectDir: binder.projectDirectory,
      provenTranscript: binder.provenTranscriptPath(),
    }),
    { admit: true, binds: true, proof: 'session-start' },
  )

  // What it used to build: the plugin cache under ~/.claude. The agent's own
  // SessionStart is foreign, and nothing can ever prove it.
  const before = new SessionTranscriptBinder(pluginCache, { claudeHome: join(home, '.claude'), ...opts })
  assert.equal(before.provenTranscriptPath(), null)
  assert.deepEqual(
    decideSessionAdmission({
      bound: null,
      incoming: { sessionId: sid, transcriptPath: transcript, event: 'SessionStart' },
      projectDir: before.projectDirectory,
      provenTranscript: before.provenTranscriptPath(),
    }),
    { admit: false, reason: 'foreign-project' },
  )
  // With no CLAUDE_CONFIG_DIR the default is <home>/.claude.
  assert.equal(claudeConfigDir({ env: {}, home }), join(home, '.claude'))
})

test('server.ts builds the binder from the agent folder and the CLI config dir, never the relocated cwd', () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8')
  const at = server.indexOf('const sessionBinder = new SessionTranscriptBinder(')
  assert.ok(at > 0, 'the binder is built at module scope')
  const call = server.slice(at, server.indexOf('\n})\n', at))
  assert.match(call, /^const sessionBinder = new SessionTranscriptBinder\(LAUNCH_CWD, \{/)
  assert.match(call, /\n\s*claudeHome: CLAUDE_CONFIG_DIR,\n/)
  assert.doesNotMatch(call, /process\.cwd\(\)/)
  // A const read before its declaration throws at module load (the temporal
  // dead zone), which would take the whole daemon down at boot.
  const decl = server.indexOf(
    '\nconst CLAUDE_CONFIG_DIR = pathResolve(LAUNCH_CWD, claudeConfigDir({ env: process.env, home: homedir() }))\n',
  )
  assert.ok(decl > 0, 'one config dir rule, the installer helper')
  assert.ok(decl < at, 'declared before the binder reads it')
  assert.equal(server.split('\nconst CLAUDE_CONFIG_DIR = ').length, 2, 'declared once')
  // Every consumer of the binder's project dir reads the binder itself, so
  // the hook intake gate and the Sessions sheet follow the fix.
  assert.match(server, /startHookIntake\(\{\s*stateRoot: root,\s*projectDir: sessionBinder\.projectDirectory,/)
  assert.match(server, /new AgentSessionLibrary\(\{\s*projectDir: sessionBinder\.projectDirectory,/)
  // The third reader is agent-state.json's transcript activity (code review
  // F1), which reads the same dir for an agent whose hook rail is silent.
  assert.match(server, /readSessionTranscript\(\{\s*resolve: \(\) => sessionBinder\.resolve\(\),\s*projectDir: sessionBinder\.projectDirectory,/)
  assert.equal((server.match(/sessionBinder\.projectDirectory/g) ?? []).length, 3)
})

// The two other transcript readers (mission 104 fix round, verifier item a).
// The usage self-report and the resting watcher read the same transcripts the
// binder does, from the same <config dir>/projects/<munged agent folder>. Built
// from process.cwd() under a fixed ~/.claude, a marketplace install (cwd is the
// plugin cache) or a custom CLAUDE_CONFIG_DIR pointed both at a project dir no
// transcript of this agent lives in: no token counts on any reply, and a usage
// cap the agent hit was never reported as resting.
test('server.ts builds the usage tracker and the resting watcher from the agent folder and the CLI config dir', () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8')
  const usage = /\nconst usageTracker = new UsageTracker\(([^\n]*)\)\n/.exec(server)
  assert.ok(usage, 'the usage tracker is built at module scope')
  assert.equal(usage[1], 'LAUNCH_CWD, CLAUDE_CONFIG_DIR')
  const resting = /\nconst restingWatcher = new RestingWatcher\(([^\n]*)\)\n/.exec(server)
  assert.ok(resting, 'the resting watcher is built at module scope')
  assert.equal(resting[1], 'LAUNCH_CWD, CLAUDE_CONFIG_DIR')
  // Both read the config dir at module load, so it must be declared first.
  const decl = server.indexOf('\nconst CLAUDE_CONFIG_DIR = ')
  assert.ok(decl > 0 && decl < usage.index && decl < resting.index, 'declared before both readers')
})

test('the usage tracker finds the agent transcript under a custom config dir, and not from the plugin cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'readers-config-dir-'))
  const configDir = join(root, 'claude-config')
  const agentFolder = '/home/kc/agents/vexa'
  const projectDir = join(configDir, 'projects', mungeCwd(agentFolder))
  mkdirSync(projectDir, { recursive: true })
  const transcript = join(projectDir, '8c1f2d3e-4a5b-4c6d-8e7f-901234567890.jsonl')
  writeFileSync(transcript, '')
  const tracker = new UsageTracker(agentFolder, configDir)
  writeFileSync(transcript, `${assistantLine(50_000)}\n`)
  const report = tracker.collect({})
  assert.ok(report, 'the tracker reads the agent transcript')
  assert.equal(report.inputTokens, 50_000)
  // The plugin cache under ~/.claude names a dir with nothing in it.
  const before = new UsageTracker('/home/kc/.claude/plugins/cache/hoai/0.62.0', join(root, 'home', '.claude'))
  assert.equal(before.collect({}), null)
})

// Verifier item b: the config dir is resolved ONCE, against the folder claude
// runs in. The CLI resolves a relative CLAUDE_CONFIG_DIR from its own cwd, the
// agent folder; this process runs in the plugin cache on a marketplace install,
// so the raw value named a different directory, and a non-normalised one
// (~/./.claude-work/) never string-matched the transcript_path the CLI hands
// its hooks: the agent's own events were refused as foreign-project.
test('server.ts resolves the config dir once against the agent folder, and the intake resolves against it too', () => {
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8')
  assert.match(
    server,
    /\nconst CLAUDE_CONFIG_DIR = pathResolve\(LAUNCH_CWD, claudeConfigDir\(\{ env: process\.env, home: homedir\(\) \}\)\)\n/,
  )
  assert.equal(server.indexOf('\nconst LAUNCH_CWD = ') < server.indexOf('\nconst CLAUDE_CONFIG_DIR = '), true, 'the base is declared first')
  // A transcript_path the CLI spelled relative resolves against the same folder.
  assert.match(
    server,
    /startHookIntake\(\{\s*stateRoot: root,\s*projectDir: sessionBinder\.projectDirectory,(\s*\/\/[^\n]*)*\s*baseDir: LAUNCH_CWD,/,
  )
  // The watcher bundle gets the same resolved dir, and still none when unset
  // (an explicit ~/.claude is not the same thing to the CLI as an unset one).
  assert.match(server, /claudeConfigDir: process\.env\.CLAUDE_CONFIG_DIR\?\.trim\(\) \? CLAUDE_CONFIG_DIR : null,/)
  // What the binder then builds is absolute and normalised whatever the spelling.
  const agent = '/Users/a/agent'
  for (const raw of ['.claude-work', './.claude-work/', '/Users/a/agent/../agent/.claude-work']) {
    const home = resolvePath(agent, claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: raw }, home: '/Users/a' }))
    // resolvePath(agent) is the agent folder as the host spells it (D:\Users\a\agent on Windows).
    assert.equal(new SessionTranscriptBinder(agent, { claudeHome: home }).projectDirectory, join(resolvePath(agent), '.claude-work', 'projects', '-Users-a-agent'))
  }
})
