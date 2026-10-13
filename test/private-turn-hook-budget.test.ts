/**
 * The private turn hook finishes inside its registered timeout with a margin, however slowly node starts (0.68.6).
 *
 * THE REPORT (Data, board row d6aa4f1f, 2026-10-13; Mark's run on Vera, 0.68.3, Windows). The UserPromptSubmit
 * private turn hook timed out on cold start: 3082, 3160 and 3706 ms against its 3000 ms limit. Prompts were still
 * admitted, because the marker is written before the hook waits.
 *
 * WHY. After writing a live marker the hook waits up to 2500 ms for the daemon's receipt (<marker>.ready), and that
 * 2500 ms was counted from the marker write. The CLI's timeout counts from the spawn, so every millisecond of a slow
 * node start was added on top: 2500 plus 582 to 1206 ms of start is exactly Vera's 3082 to 3706 ms. The imports cost
 * 7 to 8 ms (measured on this PC), so lazy imports would not move it. A start slower than the whole limit was killed
 * before it even wrote the marker, and that turn's private tools refused.
 *
 * NOW. The wait ends 2500 ms after the marker but never later than 3000 ms after the hook's own process start
 * (performance.now()), so the hook's own time is bounded whatever its start cost; and the CLI's timeout for the private
 * turn hook is 5 s in every registration, leaving 2 s for what the process cannot see (process creation, exit).
 *
 * These tests run the real hook as the CLI does: a stdin payload, killed at the timeout hooks/hooks.json registers.
 *
 * Run with: npx tsx --test test/private-turn-hook-budget.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { privateMarkerPath, readPrivateJson } from '../lib/private-turn.mjs'
import * as hookModule from '../bin/hoai-private-turn-hook.mjs'
import * as preseed from '../lib/claude-preseed.mjs'

const HOOK = fileURLToPath(new URL('../bin/hoai-private-turn-hook.mjs', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'))

/** The timeout the plugin registers for the private turn hook on UserPromptSubmit, in ms. */
function registeredTimeoutMs(): number {
  const entry = MANIFEST.hooks.UserPromptSubmit.flatMap((m: any) => m.hooks ?? []).find((h: any) => String(h.args?.[0] ?? '').endsWith('/bin/hoai-private-turn-hook.mjs'))
  assert.ok(entry, 'the manifest registers the private turn hook on UserPromptSubmit')
  return entry.timeout * 1000
}

/** One agent folder whose own daemon (this test process) is attached, and a delivered prompt for it. */
function agent(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-hook-budget-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'state')
  const cwd = join(base, 'agent')
  mkdirSync(cwd, { recursive: true })
  markFloorAttached({ root, folders: [cwd], projectDir: cwd })
  const markerPath = privateMarkerPath(root, floorKey(cwd))
  const payload = {
    hook_event_name: 'UserPromptSubmit', session_id: randomUUID(), transcript_path: join(cwd, 'session.jsonl'), cwd,
    prompt_id: randomUUID(), prompt: `Owner: list the boards\n<hoai-private-turn id="${randomUUID()}"/>`,
  }
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === 'string' && !/^(BGOS_|CLAUDE_)/.test(k))) as Record<string, string>
  Object.assign(env, { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd })
  return { root, cwd, markerPath, payload, env }
}

/**
 * The CLI running the hook: spawn, write the payload, kill at `limitMs`. `stallMs` holds node before the hook loads
 * (a cold start). `receiptAfterMs`: the daemon writes the .ready receipt this long after the marker appears (null: never).
 */
async function runHook(a: ReturnType<typeof agent>, { stallMs = 0, receiptAfterMs = null as number | null, limitMs = registeredTimeoutMs() } = {}) {
  // What this machine spends right now creating a node process, starting it and ending it: time the hook cannot see
  // of itself, and that the 2 s between its deadline and the timeout is for. Measured under the same load.
  const bareStarted = performance.now()
  await new Promise((resolve) => spawn(process.execPath, ['-e', '0'], { env: a.env, stdio: 'ignore', windowsHide: true }).on('exit', resolve))
  const overhead = performance.now() - bareStarted
  const args = stallMs > 0 ? [`--import=data:text/javascript,Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${stallMs})`, HOOK] : [HOOK]
  const started = performance.now()
  const child = spawn(process.execPath, args, { env: a.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  child.stdin.end(JSON.stringify(a.payload))
  let killed = false
  const killer = setTimeout(() => { killed = true; child.kill() }, limitMs)
  // The daemon's side: once the marker is there, write its receipt (.ready) after receiptAfterMs.
  let receipt: ReturnType<typeof setInterval> | null = null
  if (receiptAfterMs !== null) {
    receipt = setInterval(() => {
      const marker = readPrivateJson(a.markerPath, 2048)
      if (!marker?.live) return
      clearInterval(receipt!)
      receipt = null
      setTimeout(() => writeFileSync(`${a.markerPath}.ready`, JSON.stringify({ turnId: marker.turnId, sessionId: marker.sessionId })), receiptAfterMs)
    }, 10)
  }
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)))
  const elapsed = performance.now() - started
  clearTimeout(killer)
  if (receipt) clearInterval(receipt)
  const marker = readPrivateJson(a.markerPath, 2048)
  return { code, killed, elapsed, overhead, stderr, markerLive: marker?.live === true && marker.sessionId === a.payload.session_id }
}

/**
 * Ends inside the registered timeout, exit 0, its marker written, and its own time (the wall time less what a bare
 * node start costs right now) leaves a full second of the timeout and stays near its deadline.
 */
function assertInBudget(r: Awaited<ReturnType<typeof runHook>>, label: string, stallMs = 0) {
  const limitMs = registeredTimeoutMs()
  const deadline = (hookModule as any).PRIVATE_TURN_HOOK_DEADLINE_MS ?? 2500
  assert.equal(r.killed, false, `${label}: killed at the ${limitMs} ms timeout after ${Math.round(r.elapsed)} ms`)
  assert.equal(r.code, 0, `${label}: exit ${r.code}: ${r.stderr}`)
  assert.equal(r.markerLive, true, `${label}: the live marker was written`)
  const own = r.elapsed - r.overhead
  assert.ok(own + 1000 <= limitMs, `${label}: ${Math.round(own)} ms of its own (${Math.round(r.elapsed)} ms in all) leaves less than 1 s of the ${limitMs} ms timeout`)
  assert.ok(own <= Math.max(deadline, stallMs + 100) + 700, `${label}: ${Math.round(own)} ms of its own, past its ${deadline} ms deadline`)
}

test('Vera: a 1.2 s cold start with no receipt (the daemon late) finishes inside the timeout with a second to spare', async (t) => {
  assertInBudget(await runHook(agent(t), { stallMs: 1200 }), '1200 ms start', 1200)
})

test('a 2 s cold start with no receipt finishes inside the timeout with a second to spare', async (t) => {
  // Also what tells a bigger timeout alone apart: the old wait would take 2 s + 2.5 s, over a 5 s limit's margin.
  assertInBudget(await runHook(agent(t), { stallMs: 2000 }), '2000 ms start', 2000)
})

test('a cold start slower than the old 3 s limit still writes its marker, and does not wait any more', async (t) => {
  assertInBudget(await runHook(agent(t), { stallMs: 3100 }), '3100 ms start', 3100)
})

test('a normal start with no receipt keeps the whole 2.5 s wait, and still leaves the margin', async (t) => {
  const r = await runHook(agent(t))
  assertInBudget(r, 'normal start, no receipt')
  assert.ok(r.elapsed >= 2400, `the wait is not cut short for a normal start: ${Math.round(r.elapsed)} ms`)
})

test('control: a normal start whose receipt comes at once ends at once, well under the limit', async (t) => {
  const r = await runHook(agent(t), { receiptAfterMs: 0 })
  assertInBudget(r, 'normal start, prompt receipt')
  assert.ok(r.elapsed < 1500, `${Math.round(r.elapsed)} ms`)
})

test('control: a receipt 800 ms after the marker is still waited for (the wait was bounded, not removed)', async (t) => {
  const r = await runHook(agent(t), { receiptAfterMs: 800 })
  assertInBudget(r, 'receipt after 800 ms')
  assert.ok(r.elapsed >= 800 && r.elapsed < 2400, `${Math.round(r.elapsed)} ms`)
})

test('the wait ends 2.5 s after the marker, never later than 3 s after the process started', () => {
  const end = (hookModule as any).readyWaitEnd
  assert.equal(typeof end, 'function', 'bin/hoai-private-turn-hook.mjs exports readyWaitEnd')
  assert.equal(end(100), 2600)
  assert.equal(end(500), 3000)
  assert.equal(end(1200), 3000)
  assert.equal(end(3500), 3000, 'past the deadline: no wait at all')
  assert.equal((hookModule as any).PRIVATE_TURN_READY_WAIT_MS, 2500)
  assert.equal((hookModule as any).PRIVATE_TURN_HOOK_DEADLINE_MS, 3000)
})

test('every registration gives the private turn hook the same timeout, with 2 s over its own deadline', () => {
  const seconds = (preseed as any).PRIVATE_HOOK_TIMEOUT_SECONDS
  assert.equal(seconds, 5, 'lib/claude-preseed.mjs PRIVATE_HOOK_TIMEOUT_SECONDS')
  assert.ok((hookModule as any).PRIVATE_TURN_HOOK_DEADLINE_MS + 2000 <= seconds * 1000)
  const entries = Object.entries(MANIFEST.hooks).flatMap(([event, matchers]: [string, any]) =>
    matchers.flatMap((m: any) => (m.hooks ?? []).filter((h: any) => String(h.args?.[0] ?? '').endsWith('/bin/hoai-private-turn-hook.mjs')).map((h: any) => [event, h.timeout])))
  assert.deepEqual(entries.map(([event]: any) => event).sort(), ['PreToolUse', 'SessionEnd', 'Stop', 'SubagentStart', 'UserPromptSubmit'])
  for (const [event, timeout] of entries) assert.equal(timeout, seconds, `hooks/hooks.json ${event}`)
})

test('a clone folder registered with the old 3 s private entries is rewritten to the new timeout, once per event', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-hook-budget-reg-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const settingsPath = join(base, '.claude', 'settings.local.json')
  const forwarderPath = fileURLToPath(new URL('../bin/hoai-hook.mjs', import.meta.url))
  const first = (preseed as any).ensureHookEntries({ settingsPath, forwarderPath })
  assert.equal(first.changed, true)
  // Downgrade every private entry to the 0.68.3 timeout, as an older registrar wrote it.
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  let downgraded = 0
  for (const matchers of Object.values(settings.hooks) as any[]) for (const m of matchers) for (const h of m.hooks ?? []) {
    if (String(h.args?.[0] ?? '').endsWith('hoai-private-turn-hook.mjs')) { h.timeout = 3; downgraded++ }
  }
  assert.equal(downgraded, 5)
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  const again = (preseed as any).ensureHookEntries({ settingsPath, forwarderPath })
  assert.equal(again.changed, true, 'an old timeout is not "already registered"')
  const now = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const privates = Object.entries(now.hooks).flatMap(([event, matchers]: [string, any]) =>
    matchers.flatMap((m: any) => (m.hooks ?? []).filter((h: any) => String(h.args?.[0] ?? '').endsWith('hoai-private-turn-hook.mjs')).map((h: any) => [event, h.timeout])))
  assert.equal(privates.length, 5, 'one private entry per event, nothing stacked')
  for (const [event, timeout] of privates) assert.equal(timeout, 5, event)
  assert.equal((preseed as any).ensureHookEntries({ settingsPath, forwarderPath }).changed, false, 'and then it holds')
  assert.ok(existsSync(settingsPath))
  // Each check sees an old entry on its own: the helper guard's two events, and the prompt, Stop and SessionEnd entries.
  for (const events of [['SubagentStart', 'PreToolUse'], ['UserPromptSubmit', 'Stop', 'SessionEnd']]) {
    const partly = JSON.parse(readFileSync(settingsPath, 'utf8'))
    for (const event of events) for (const m of partly.hooks[event]) for (const h of m.hooks ?? []) {
      if (String(h.args?.[0] ?? '').endsWith('hoai-private-turn-hook.mjs')) h.timeout = 3
    }
    writeFileSync(settingsPath, JSON.stringify(partly, null, 2))
    assert.equal((preseed as any).ensureHookEntries({ settingsPath, forwarderPath }).changed, true, `an old timeout on ${events.join(', ')} alone`)
    const fixed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    for (const event of events) {
      const timeouts = fixed.hooks[event].flatMap((m: any) => (m.hooks ?? []).filter((h: any) => String(h.args?.[0] ?? '').endsWith('hoai-private-turn-hook.mjs')).map((h: any) => h.timeout))
      assert.deepEqual(timeouts, [5], event)
    }
  }
})
