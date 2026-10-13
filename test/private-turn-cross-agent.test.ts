/**
 * The private turn hook writes its marker only under a key whose live daemon serves its session (plugin 0.68.4).
 *
 * THE REPORT (Mark, 2026-10-13 01:50Z, Vera's Windows PC). floor\attached\354c5ab3...json names pid 31068, Mark's
 * daemon (agent 888); 9eab32b6...json names Vera's (909). private-turn\354c5ab3...json, written 06:24:56Z and still
 * live, carries VERA's session 4d6691bc: Vera's private turn hook wrote her turn under Mark's key. Mark's daemon never
 * adopts it (another session) and Vera's never reads it (another key), so her turn was lost, and the file Mark's own
 * turns live in was overwritten.
 *
 * HOW. The hook took the first of its session's folders (CLAUDE_PROJECT_DIR, BGOS_LAUNCH_CWD, the payload's cwd and
 * every folder above it) with a live attached entry, whichever daemon wrote it, and with none it fell back to the
 * first of those folders that already held a marker. A cwd the agent moved into another agent's folder, a launch
 * folder inherited from another agent's process, an agent folder above its own, or a restart in which its own daemon
 * had not attached yet each sent the marker to another agent's key.
 *
 * NOW. The daemon's attached entry names the folder its session transcripts live in (projectDir: the folder the hook
 * intake admits sessions by). The hook writes only under a live entry whose projectDir holds the payload's
 * transcript_path, or, for an entry an older daemon wrote without one, only at CLAUDE_PROJECT_DIR's own key.
 * Otherwise it writes nothing and says why: on stderr with exit 1 (the prompt still runs, private tools refuse) and
 * in a note the daemon's refusal line quotes.
 *
 * Run with: npx tsx --test test/private-turn-cross-agent.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative as relativePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invalidatePrivateBoundary, privateToolRefusal, recordPrivateBoundary, recordSubagentTurn } from '../bin/hoai-private-turn-hook.mjs'
import { SessionTranscriptBinder } from '../lib/session-binding.ts'
import { daemonFloorFolders, floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { createPrivateTurnTracker, privateAgentsPath, privateMarkerPath, privateUnservedPath, readPrivateJson, writePrivateJson } from '../lib/private-turn.mjs'

const HOOK = fileURLToPath(new URL('../bin/hoai-private-turn-hook.mjs', import.meta.url))
/** A pid no process has: an attached entry whose daemon is gone. */
const DEAD_PID = 2_147_483_646

/** One computer's home shared by two agents, each with its own folder, transcripts and floor key. */
function twoAgents(t: any, layout: { markFolder?: (base: string) => string, veraFolder?: (base: string) => string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-cross-agent-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'home', '.bgos-plugin-state')
  const claudeHome = join(base, 'home', '.claude')

  function agent(name: string, folder: string) {
    mkdirSync(folder, { recursive: true })
    const projectDir = new SessionTranscriptBinder(folder, { claudeHome }).projectDirectory
    mkdirSync(projectDir, { recursive: true })
    const session = randomUUID()
    const transcript = join(projectDir, `${session}.jsonl`)
    writeFileSync(transcript, '')
    const key = floorKey(folder)
    return {
      name, folder, projectDir, session, transcript, key, markerPath: privateMarkerPath(root, key),
      /** The daemon takes its pairing lock and attaches (server.ts markFloorAttachedIfHolder); `legacy`: before 0.68.4. */
      attach({ pid = process.pid, legacy = false }: { pid?: number, legacy?: boolean } = {}) {
        const folders = daemonFloorFolders({ launchCwd: folder, cwd: folder, env: {} })
        markFloorAttached({ root, folders, pid, ...(legacy ? {} : { projectDir, baseDir: folder }) })
      },
      /** The daemon stands down or exits: its entries go (server.ts clearFloorAttachedMarker). */
      detach() {
        for (const f of daemonFloorFolders({ launchCwd: folder, cwd: folder, env: {} })) rmSync(join(root, 'floor', 'attached', `${floorKey(f)}.json`), { force: true })
      },
      payload(event = 'UserPromptSubmit', over: Record<string, unknown> = {}) {
        return {
          session_id: session, transcript_path: transcript, cwd: folder, hook_event_name: event,
          ...(event === 'UserPromptSubmit' ? { prompt: `${name}, list the boards\n<hoai-private-turn id="${randomUUID()}"/>`, prompt_id: randomUUID() } : {}),
          ...over,
        }
      },
      env(over: Record<string, string | undefined> = {}) {
        const env: Record<string, string> = { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: folder }
        for (const [k, v] of Object.entries(over)) {
          if (v === undefined) delete env[k]
          else env[k] = v
        }
        return env
      },
    }
  }
  const mark = agent('mark', (layout.markFolder ?? ((b) => join(b, 'agents', 'mark')))(base))
  const vera = agent('vera', (layout.veraFolder ?? ((b) => join(b, 'agents', 'vera')))(base))
  // Mark is mid turn: his daemon attached, his live marker under his key.
  mark.attach()
  writePrivateJson(mark.markerPath, { schemaVersion: 1, turnId: 'mark-turn-0001', sessionId: mark.session, promptHash: 'a'.repeat(64), live: true })
  const markBytes = readFileSync(mark.markerPath, 'utf8')

  /** Mark's marker is untouched and no file anywhere carries Vera's session except under her own key. */
  function assertNothingOfMarksTouched(label: string) {
    assert.equal(readFileSync(mark.markerPath, 'utf8'), markBytes, `${label}: Mark's marker is byte for byte his own`)
    for (const name of readdirSync(join(root, 'private-turn'))) {
      if (!name.endsWith('.json') || name === `${vera.key}.json`) continue
      const marker = readPrivateJson(join(root, 'private-turn', name), 2048)
      assert.notEqual(marker?.sessionId, vera.session, `${label}: ${name} does not carry Vera's session`)
    }
  }
  /** The real hook, as the CLI runs it: stdin payload, its own environment. */
  function runHook(payload: Record<string, unknown>, env: Record<string, string>) {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BGOS_|CLAUDE_PROJECT_DIR$)/.test(k)))
    return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: { ...clean, ...env }, encoding: 'utf8', timeout: 20_000 })
  }
  return { base, root, mark, vera, assertNothingOfMarksTouched, runHook }
}

// ── Red: every way the old hook reached Mark's key ──────────────────────────

test('Vera\'s cwd moved into Mark\'s folder before her daemon attached: no marker under Mark\'s key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { cwd: mark.folder }), vera.env())
  assert.equal(wrote, false, 'nothing is written: no attached daemon serves Vera\'s session')
  assertNothingOfMarksTouched('cwd in Mark\'s folder')
})

test('a launch folder inherited from Mark\'s process, Vera\'s daemon gone: no marker under Mark\'s key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  vera.attach({ pid: DEAD_PID })
  const wrote = recordPrivateBoundary(vera.payload(), vera.env({ BGOS_LAUNCH_CWD: mark.folder }))
  assert.equal(wrote, false)
  assertNothingOfMarksTouched('inherited BGOS_LAUNCH_CWD')
})

test('Mark\'s folder above Vera\'s, Vera\'s daemon not attached yet: no marker under Mark\'s key', (t) => {
  const { vera, assertNothingOfMarksTouched } = twoAgents(t, {
    markFolder: (b) => join(b, 'agents'),
    veraFolder: (b) => join(b, 'agents', 'vera'),
  })
  const wrote = recordPrivateBoundary(vera.payload(), vera.env())
  assert.equal(wrote, false)
  assertNothingOfMarksTouched('Mark\'s folder is an ancestor')
})

test('the old fallback: no live entry anywhere and Mark\'s marker in Vera\'s folder list: no marker under Mark\'s key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  mark.attach({ pid: DEAD_PID }) // Mark's daemon is restarting: his entry names a pid that is gone
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { cwd: mark.folder }), vera.env())
  assert.equal(wrote, false)
  assertNothingOfMarksTouched('fallback to an existing marker')
})

test('Vera\'s own daemon attached but CLAUDE_PROJECT_DIR lost and her cwd in Mark\'s folder: no marker under Mark\'s key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  vera.attach()
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { cwd: mark.folder }), vera.env({ CLAUDE_PROJECT_DIR: undefined }))
  assert.equal(wrote, false)
  assertNothingOfMarksTouched('only Mark\'s folder in the list')
})

test('an older Mark daemon (no projectDir) is trusted only at Vera\'s own project folder: no marker under Mark\'s key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  mark.attach({ legacy: true })
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { cwd: mark.folder }), vera.env())
  assert.equal(wrote, false)
  assertNothingOfMarksTouched('legacy entry at the cwd')
})

test('Mark\'s live entry first in the folder order, Vera\'s after it: Vera\'s marker lands under her own key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  vera.attach()
  const wrote = recordPrivateBoundary(vera.payload(), vera.env({ CLAUDE_PROJECT_DIR: undefined, BGOS_LAUNCH_CWD: mark.folder }))
  assert.ok(wrote, 'Vera\'s own daemon serves her session')
  assert.equal(wrote.path, vera.markerPath)
  assertNothingOfMarksTouched('Mark listed first')
})

test('a Stop and a failed Stop with no daemon of Vera\'s close nothing of Mark\'s', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  // Mark's folder is in Vera's list (her cwd) and her daemon has not attached.
  assert.equal(recordPrivateBoundary(vera.payload('Stop', { cwd: mark.folder }), vera.env()), false)
  invalidatePrivateBoundary(vera.payload('Stop', { cwd: mark.folder }), vera.env())
  assertNothingOfMarksTouched('Stop')
})

test('a helper started in Vera\'s session records nothing beside Mark\'s marker', (t) => {
  const { mark, vera } = twoAgents(t)
  assert.equal(recordSubagentTurn(vera.payload('SubagentStart', { cwd: mark.folder, agent_id: 'helper-1' }), vera.env()), false)
  assert.equal(existsSync(privateAgentsPath(mark.markerPath)), false)
})

test('the hook says why it wrote nothing, on stderr, without blocking the prompt', (t) => {
  const { mark, vera, runHook, assertNothingOfMarksTouched } = twoAgents(t)
  const run = runHook(vera.payload('UserPromptSubmit', { cwd: mark.folder }), vera.env())
  assert.equal(run.status, 1, `exit 1: a non blocking error the CLI records (stderr: ${run.stderr})`)
  assert.equal(run.stdout, '', 'nothing on stdout: a UserPromptSubmit hook\'s stdout would reach the model')
  const lines = run.stderr.trim().split('\n')
  assert.equal(lines.length, 1, run.stderr)
  assert.ok(lines[0]!.startsWith(`HOAI wrote no private turn marker: no live daemon attached to this session's folders serves its transcript ${vera.transcript} (`), lines[0])
  assert.ok(lines[0]!.includes(`${mark.key}: pid ${process.pid} serves the transcripts in ${mark.projectDir}`), lines[0])
  assert.match(lines[0]!, /Private tools refuse this turn\.$/)
  assertNothingOfMarksTouched('the real hook')
})

test('the daemon\'s refusal line quotes why the hook wrote no marker, and a later marker clears it', (t) => {
  const { root, mark, vera, runHook } = twoAgents(t)
  const tracker = createPrivateTurnTracker()
  const prompt = tracker.deliver({ content: 'Owner: list the boards', actingUserId: 'user_owner909', chatId: '1132' })
  const payload = vera.payload('UserPromptSubmit', { cwd: mark.folder, prompt })
  assert.equal(runHook(payload, vera.env()).status, 1)
  assert.equal(tracker.begin({ prompt, sessionId: vera.session, promptId: payload.prompt_id }), 'opened')
  const why = tracker.explain({ markerPaths: [vera.markerPath] })
  assert.match(why, /waiting for its marker/)
  assert.match(why, new RegExp(`; the private turn hook of session ${vera.session} wrote no marker at \\d\\d:\\d\\d:\\d\\dZ: no live daemon attached`))
  assert.ok(!why.includes('\n'))
  assert.equal(readPrivateJson(privateUnservedPath(root, vera.session), 2048)?.promptId, payload.prompt_id, 'the note names its own submission')
  // A note of another submission of the session is not this prompt's.
  const other = tracker.deliver({ content: 'Owner: once more', actingUserId: 'user_owner909', chatId: '1132' })
  assert.equal(tracker.begin({ prompt: other, sessionId: vera.session, promptId: randomUUID() }), 'opened')
  assert.doesNotMatch(tracker.explain({ markerPaths: [vera.markerPath] }), /wrote no marker/)
  // Vera's daemon attaches; the next prompt's marker lands under her key and the note goes.
  vera.attach()
  const next = tracker.deliver({ content: 'Owner: again', actingUserId: 'user_owner909', chatId: '1132' })
  const second = vera.payload('UserPromptSubmit', { prompt: next })
  assert.equal(runHook(second, vera.env()).status, 0)
  assert.equal(tracker.begin({ prompt: next, sessionId: vera.session, promptId: second.prompt_id }), 'opened')
  assert.equal(tracker.current({ markerPaths: [vera.markerPath] })?.actingUserId, 'user_owner909')
  assert.equal(existsSync(privateUnservedPath(root, vera.session)), false, 'a marker written removes the note')
})

test('Vera\'s daemon stands down mid turn: the next prompt and Stop close her own live marker, and nothing of Mark\'s', (t) => {
  const { mark, vera } = twoAgents(t)
  vera.attach()
  const first = recordPrivateBoundary(vera.payload(), vera.env())
  assert.ok(first)
  assert.equal(readPrivateJson(vera.markerPath, 2048)?.live, true)
  // A live marker of Vera's session sits under Mark's live key (the 06:24 file): his key, so it is never written.
  writePrivateJson(mark.markerPath, { schemaVersion: 1, turnId: 't', sessionId: vera.session, promptHash: 'b'.repeat(64), live: true })
  const marksFile = readFileSync(mark.markerPath, 'utf8')
  vera.detach()
  // Her signed browser context lives up to 60 s: the next boundary must close the marker it names.
  const inMarks = { cwd: join(mark.folder, 'x') }
  assert.equal(recordPrivateBoundary(vera.payload('UserPromptSubmit', inMarks), vera.env()), false)
  assert.equal(readPrivateJson(vera.markerPath, 2048)?.live, false, 'her own marker is closed')
  // The same through a Stop, and through the failure path.
  writePrivateJson(vera.markerPath, { ...first.marker, live: true })
  assert.equal(recordPrivateBoundary(vera.payload('Stop', inMarks), vera.env()), false)
  assert.equal(readPrivateJson(vera.markerPath, 2048)?.live, false)
  writePrivateJson(vera.markerPath, { ...first.marker, live: true })
  invalidatePrivateBoundary(vera.payload('Stop', inMarks), vera.env())
  assert.equal(readPrivateJson(vera.markerPath, 2048)?.live, false)
  assert.equal(readFileSync(mark.markerPath, 'utf8'), marksFile, 'the file under Mark\'s key is never written')
})

test('a helper\'s private call in a session whose own daemon is not attached is refused; a standalone session\'s is not', (t) => {
  const { base, root, mark, vera } = twoAgents(t)
  const call = (payload: Record<string, unknown>, env: Record<string, string>) =>
    privateToolRefusal({ ...payload, hook_event_name: 'PreToolUse', tool_name: 'mcp__bgos__boards_query', agent_id: 'helper-1' }, env)
  assert.match(String(call(vera.payload('PreToolUse', { cwd: mark.folder }), vera.env())), /no HOAI daemon of this agent is attached/)
  const own = join(base, 'elsewhere')
  mkdirSync(own, { recursive: true })
  assert.equal(call({ session_id: randomUUID(), transcript_path: join(base, 'x.jsonl'), cwd: own }, { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: own }), null)
})

test('a relative transcript path is read against the daemon\'s launch folder, as its intake reads it', (t) => {
  const { vera } = twoAgents(t)
  vera.attach()
  const relative = relativePath(vera.folder, vera.transcript)
  assert.ok(!isAbsolute(relative), relative)
  // No CLAUDE_PROJECT_DIR and the cwd one folder down: read against the cwd it misses; the entry's baseDir finds it.
  const sub = join(vera.folder, 'sub')
  mkdirSync(sub, { recursive: true })
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { transcript_path: relative, cwd: sub }), vera.env({ CLAUDE_PROJECT_DIR: undefined }))
  assert.ok(wrote)
  assert.equal(wrote.path, vera.markerPath)
})

// ── Controls: what kept working keeps working ───────────────────────────────

test('control: Vera\'s own daemon attached, Mark\'s folder also in her list: her marker lands under her key', (t) => {
  const { mark, vera, assertNothingOfMarksTouched } = twoAgents(t)
  vera.attach()
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { cwd: mark.folder }), vera.env())
  assert.ok(wrote)
  assert.equal(wrote.path, vera.markerPath)
  assert.equal(readPrivateJson(vera.markerPath, 2048)?.sessionId, vera.session)
  assertNothingOfMarksTouched('own daemon')
})

test('control: CLAUDE_PROJECT_DIR lost (the WSL hop) and the cwd below Vera\'s folder: her entry above the cwd is found', (t) => {
  const { vera } = twoAgents(t)
  vera.attach()
  const below = join(vera.folder, 'work', 'notes')
  mkdirSync(below, { recursive: true })
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { cwd: below }), vera.env({ CLAUDE_PROJECT_DIR: undefined }))
  assert.ok(wrote)
  assert.equal(wrote.path, vera.markerPath)
})

test('control: an older Vera daemon (no projectDir) at her own project folder is still written to', (t) => {
  const { vera } = twoAgents(t)
  vera.attach({ legacy: true })
  const wrote = recordPrivateBoundary(vera.payload(), vera.env())
  assert.ok(wrote)
  assert.equal(wrote.path, vera.markerPath)
})

test('control: a transcript spelled with dot segments, doubled and other slashes still matches its daemon', (t) => {
  const { vera } = twoAgents(t)
  vera.attach()
  const spelled = vera.transcript.replace(/[\\/]\.claude[\\/]/, '/./.claude//').replace(/\//g, process.platform === 'win32' ? '\\' : '/')
  const wrote = recordPrivateBoundary(vera.payload('UserPromptSubmit', { transcript_path: spelled }), vera.env())
  assert.ok(wrote)
  assert.equal(wrote.path, vera.markerPath)
})

test('control: a standalone session (nothing attached, no marker) writes nothing and says nothing', (t) => {
  const { base, root, runHook } = twoAgents(t)
  const own = join(base, 'elsewhere', 'project')
  mkdirSync(own, { recursive: true })
  const run = runHook({ session_id: randomUUID(), transcript_path: join(base, 'x.jsonl'), cwd: own, hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
    { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: own })
  assert.equal(run.status, 0)
  assert.equal(run.stderr, '')
  assert.equal(existsSync(privateMarkerPath(root, floorKey(own))), false)
})

test('control: Mark\'s own hook still writes under his key', (t) => {
  const { mark } = twoAgents(t)
  const wrote = recordPrivateBoundary(mark.payload(), mark.env())
  assert.ok(wrote)
  assert.equal(wrote.path, mark.markerPath)
  assert.equal(readPrivateJson(mark.markerPath, 2048)?.sessionId, mark.session)
})
