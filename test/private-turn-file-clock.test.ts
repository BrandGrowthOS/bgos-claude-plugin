/**
 * A file clock ahead of the real clock cannot let a private turn through (board row 495d73c1, raised by Ares 11-03).
 *
 * The tracker orders the private turn marker against moments the daemon takes on the real clock (a Stop forwarder's
 * process start, a delivery). It used to take the marker's file modification time for when the marker was written. On
 * a machine whose file clock runs ahead (a network share, a clock jump, a restored file) a marker written BEFORE the
 * Stop then reads as written after it, and a turn whose Stop hook was killed stood past its Stop line; a closed marker
 * written before a delivery whose place was unknown read as written after it, and lifted that delivery's bar.
 *
 * Now the hook stamps the marker with the moment it wrote it (`writtenAt`, Date.now), the clock the daemon's own times
 * are on, and the daemon judges by that stamp. A marker with no stamp (a hook before this one) falls back to its file
 * time, which the daemon refuses when it is later than its own clock (lib/private-turn.mjs privateMarkerWrittenAt).
 * These tests run the production hook, intake, tracker and tool admission (test/helpers/private-turn-host.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import * as privateTurn from '../lib/private-turn.mjs'
import { createPrivateTurnTracker, privateMarkerPath, readPrivateJson, requirePrivateTurn, PRIVATE_TURN_REFUSAL } from '../lib/private-turn.mjs'
import { GATED, OWNER, RECIPIENT, actsFor, agentHost, assertOwnerTurn, ownerFrame, type Host } from './helpers/private-turn-host.ts'

// New in this change, read through the namespace so that on a build without it only the tests that need it fail.
const { privateMarkerWrittenAt } = privateTurn as any

const HOUR = 60 * 60 * 1000

/** Spin until the real clock is past `at`. */
function waitPast(at: number) {
  while (Date.now() <= at) { /* spin */ }
}

/** The live marker this host's hook wrote, and its path. */
function liveMarker(host: Host): { path: string, marker: any } {
  for (const path of host.markerPaths) {
    const marker = readPrivateJson(path, 2048)
    if (marker?.live === true) return { path, marker }
  }
  throw new Error('no live marker')
}

/** The file clock runs `aheadMs` ahead of the real clock: the marker the hook just wrote is stamped that far ahead. */
function fileClockAhead(path: string, aheadMs: number): number {
  const at = Date.now() + aheadMs
  utimesSync(path, at / 1000, at / 1000)
  return at
}

/** The marker as a hook before this change writes it: no stamp inside it, only its file time. */
function unstamped(path: string) {
  const marker = JSON.parse(readFileSync(path, 'utf8'))
  delete marker.writtenAt
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 })
}

async function assertGatedRefused(host: Host, label: string) {
  for (const name of GATED) assert.equal(await actsFor(host, name), `refused: ${PRIVATE_TURN_REFUSAL}`, `${label}: ${name}`)
}

/** The owner's message, its hook run and its line drained; `between` runs after the hook wrote the marker. */
function ownerPrompt(host: Host, text: string, between: () => void = () => {}) {
  const sub = host.prompt(host.card(ownerFrame(text)))
  sub.mark()
  between()
  sub.spool(); host.pump()
}

for (const kind of ['stamped by this hook', 'from an older hook, with no stamp'] as const) {
  test(`a Stop whose hook was killed, the marker's file clock an hour ahead (${kind}): the Stop line still ends the owner's turn`, async (t) => {
    const host = agentHost(t)
    ownerPrompt(host, 'Draft the launch plan.', () => {
      const { path } = liveMarker(host)
      if (kind !== 'stamped by this hook') unstamped(path)
      fileClockAhead(path, HOUR)
    })
    await assertOwnerTurn(host, 'the owner\'s own turn, before its Stop')
    const stop = host.stopping({ hook: false }) // killed at its 5 s timeout, or a locked file, before it closed the marker
    stop.mark(); stop.spool(); host.pump()
    await assertGatedRefused(host, 'after the Stop line')
  })
}

test('the file clock a little ahead, read after the real clock caught up: the marker\'s own stamp still places it before the Stop', async (t) => {
  const host = agentHost(t)
  // 400 ms ahead: past the Stop below, yet behind the real clock by the time the daemon reads the marker, so no bound on
  // a future file time can see it. Only the stamp the hook wrote inside the marker can.
  const sub = host.prompt(host.card(ownerFrame('Draft the launch plan.')))
  sub.mark()
  const ahead = fileClockAhead(liveMarker(host).path, 400)
  const stop = host.stopping({ hook: false }) // killed before it closed the marker
  stop.mark()
  waitPast(ahead)
  // The prompt's forwarder line lands only now (a cold start), after the Stop: the daemon reads the marker first here.
  sub.spool(); host.pump()
  await assertOwnerTurn(host, 'before the daemon drained the Stop line')
  stop.spool(); host.pump()
  await assertGatedRefused(host, 'after the Stop line')
})

test('a turn never adopted before its Stop line (no tool called yet), the marker\'s file clock ahead: the Stop line ends it', async (t) => {
  for (const kind of ['stamped', 'unstamped'] as const) {
    const host = agentHost(t)
    const stop = host.stopping({ hook: false })
    ownerPrompt(host, 'Draft the launch plan.', () => {
      const { path } = liveMarker(host)
      if (kind === 'unstamped') unstamped(path)
      fileClockAhead(path, HOUR)
    })
    stop.mark(); stop.spool(); host.pump()
    await assertGatedRefused(host, `${kind}: after the Stop line`)
  }
})

test('control: a Stop line late behind the next owner prompt, the file clock an hour ahead: the stamp keeps that prompt\'s turn the owner\'s', async (t) => {
  const host = agentHost(t)
  ownerPrompt(host, 'Draft the launch plan.')
  await assertOwnerTurn(host, 'the first turn')
  const stop = host.stopping()
  stop.mark()
  ownerPrompt(host, 'Now the budget.', () => { fileClockAhead(liveMarker(host).path, HOUR) })
  await assertOwnerTurn(host, 'the next prompt')
  stop.spool(); host.pump()
  await assertOwnerTurn(host, 'after the late Stop line')
})

/**
 * The tracker as server.ts wires it and the real private turn hook, with no intake: the test calls begin() and end()
 * for the forwarder lines (test/private-turn-late-line.test.ts cli).
 */
function cli(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-file-clock-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd], pid: process.pid, now: Date.now() })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  const tracker = createPrivateTurnTracker({ ownerUserId: OWNER, markerPaths })
  return {
    markerPaths, tracker,
    card: (actingUserId: string, chatId: string) => tracker.deliver({ content: `card ${randomUUID()}`, actingUserId, chatId }),
    prompt(prompt: string) {
      const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd, prompt, prompt_id: randomUUID() }
      recordPrivateBoundary(payload, env)
      return () => tracker.begin({ prompt, sessionId: 's', promptId: payload.prompt_id })
    },
    stopHook() { recordPrivateBoundary({ hook_event_name: 'Stop', session_id: 's', cwd }, env) },
    gated() { try { return requirePrivateTurn(tracker, markerPaths, OWNER).actingUserId } catch { return 'refused' } },
  }
}

for (const kind of ['restored with a fresh file time', 'its file clock an hour ahead', 'from an older hook, its file clock an hour ahead'] as const) {
  test(`a recipient message delivered while the marker could not be read, the closed marker before it then ${kind}: the bar outlives the Stop line`, (t) => {
    const c = cli(t)
    c.prompt(c.card(OWNER, '1'))()
    c.stopHook()
    const path = c.markerPaths[0]!
    if (kind === 'from an older hook, its file clock an hour ahead') unstamped(path)
    const closed = readFileSync(path)
    const writtenAt = statSync(path).mtimeMs
    // The marker cannot be read when the recipient's message is delivered (here: something else stands at its path).
    rmSync(path)
    mkdirSync(path)
    waitPast(writtenAt + 2)
    c.card(RECIPIENT, '2')
    rmSync(path, { recursive: true })
    waitPast(Date.now() + 2)
    // The same closed marker comes back: written before the delivery, its file time now after it.
    writeFileSync(path, closed, { mode: 0o600 })
    if (kind !== 'restored with a fresh file time') fileClockAhead(path, HOUR)
    c.tracker.end()
    c.prompt(c.card(OWNER, '1'))()
    assert.equal(c.gated(), 'refused', 'the recipient\'s message may have reached this turn')
  })
}

test('control: a Stop the CLI ran after the unknown delivery still lifts its bar, the file clock an hour ahead', (t) => {
  const c = cli(t)
  c.prompt(c.card(OWNER, '1'))()
  c.stopHook()
  c.tracker.end()
  const path = c.markerPaths[0]!
  rmSync(path)
  mkdirSync(path)
  c.card(RECIPIENT, '2')
  rmSync(path, { recursive: true })
  c.prompt(c.card(OWNER, '1'))()
  assert.equal(c.gated(), 'refused', 'the turn it may have reached')
  waitPast(Date.now() + 2)
  c.stopHook()
  fileClockAhead(path, HOUR)
  c.tracker.end()
  c.prompt(c.card(OWNER, '1'))()
  assert.equal(c.gated(), OWNER, 'the next turn, after a Stop stamped after the delivery')
})

test('privateMarkerWrittenAt: the stamp inside the marker, else its file time; never a time after the daemon\'s own clock', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hoai-file-clock-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'marker.json')
  writeFileSync(path, '{}')
  const now = Date.now()
  const fileAt = (at: number) => utimesSync(path, at / 1000, at / 1000)
  fileAt(now - 5000)
  assert.equal(privateMarkerWrittenAt({ writtenAt: now - 1000 }, path, now), now - 1000, 'the stamp, not the file time')
  assert.equal(privateMarkerWrittenAt({ writtenAt: now }, path, now), now, 'a stamp of this very millisecond')
  assert.equal(privateMarkerWrittenAt({ writtenAt: now + 1 }, path, now), null, 'a stamp after the daemon\'s clock (the clock jumped back)')
  assert.equal(privateMarkerWrittenAt({}, path, now), statSync(path).mtimeMs, 'no stamp: the file time')
  fileAt(now + HOUR)
  assert.equal(privateMarkerWrittenAt({ writtenAt: now - 1000 }, path, now), now - 1000, 'a stamp outranks a file clock ahead')
  assert.equal(privateMarkerWrittenAt({}, path, now), null, 'no stamp, a file time after the daemon\'s clock: unknown')
  assert.equal(privateMarkerWrittenAt({}, path, now + HOUR), statSync(path).mtimeMs, 'the same file time once the daemon\'s clock reached it')
  for (const bad of ['1', -1, 0, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    fileAt(now - 5000)
    assert.equal(privateMarkerWrittenAt({ writtenAt: bad }, path, now), statSync(path).mtimeMs, `a stamp that is not a time (${String(bad)}): the file time`)
  }
  assert.equal(privateMarkerWrittenAt({}, join(root, 'gone.json'), now), null, 'no stamp and no file: unknown')
})

test('the private turn hook stamps every marker it writes with the moment it wrote it', (t) => {
  const c = cli(t)
  const path = c.markerPaths[0]!
  for (const [label, write] of [['a prompt', () => c.prompt(c.card(OWNER, '1'))], ['a Stop', () => c.stopHook()]] as const) {
    const before = Date.now()
    write()
    const marker = readPrivateJson(path, 2048)
    assert.ok(Number.isSafeInteger(marker?.writtenAt) && marker.writtenAt >= before && marker.writtenAt <= Date.now(), `${label}: ${JSON.stringify(marker?.writtenAt)}`)
  }
})
