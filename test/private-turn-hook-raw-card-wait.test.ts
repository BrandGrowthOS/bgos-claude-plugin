/**
 * The private turn hook waits for the daemon's receipt for a raw card run as its own prompt, as it does for a delivered
 * one.
 *
 * A reply-overdue reminder or a peer conversation close carries no delivery token, only the raw card tag. Run as a
 * prompt of the owner's turn, the daemon keeps the turn only once its forwarder line is read. Before, the hook returned
 * at once for such a prompt, so the model's next tool call could come before that line and refuse (four board writes
 * lost on 27 Nov). Now the hook waits for the receipt (<marker>.ready) for it too, within the same deadline.
 *
 * These run the real hook as the CLI does: a stdin payload, killed at the timeout hooks/hooks.json registers.
 *
 * Run with: npx tsx --test test/private-turn-hook-raw-card-wait.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { PRIVATE_RAW_CARD_TAG, privateMarkerPath, readPrivateJson } from '../lib/private-turn.mjs'

const HOOK = fileURLToPath(new URL('../bin/hoai-private-turn-hook.mjs', import.meta.url))
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'))
const limitMs = (): number => {
  const entry = MANIFEST.hooks.UserPromptSubmit.flatMap((m: any) => m.hooks ?? []).find((h: any) => String(h.args?.[0] ?? '').endsWith('/bin/hoai-private-turn-hook.mjs'))
  return entry.timeout * 1000
}

const REMINDER = '<channel source="bgos" event_type="reply_overdue" chat_id="9001" message_id="190001" age_seconds="241" owner_inbound="true">\n' +
  '[reply-overdue] Message in chat_id=9001 (message_id=190001) arrived 241s ago and no reply has been sent yet. ' +
  'If you intended to respond, call the `reply` tool now. If you intended to stay silent, ignore this notification.\n' +
  `${PRIVATE_RAW_CARD_TAG}\n</channel>`

function agent(t: any, prompt: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hoai-hook-rawwait-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'state')
  const cwd = join(base, 'agent')
  mkdirSync(cwd, { recursive: true })
  markFloorAttached({ root, folders: [cwd], projectDir: cwd })
  const markerPath = privateMarkerPath(root, floorKey(cwd))
  const payload = { hook_event_name: 'UserPromptSubmit', session_id: randomUUID(), transcript_path: join(cwd, 'session.jsonl'), cwd, prompt_id: randomUUID(), prompt }
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === 'string' && !/^(BGOS_|CLAUDE_)/.test(k))) as Record<string, string>
  Object.assign(env, { BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd })
  return { markerPath, payload, env }
}

/** The CLI runs the hook; the daemon writes its receipt `receiptAfterMs` after the marker appears (null: never). */
async function runHook(a: ReturnType<typeof agent>, receiptAfterMs: number | null) {
  const started = performance.now()
  const child = spawn(process.execPath, [HOOK], { env: a.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  child.stdin.end(JSON.stringify(a.payload))
  let killed = false
  const killer = setTimeout(() => { killed = true; child.kill() }, limitMs())
  let seenAt: number | null = null
  const watch = setInterval(() => {
    const marker = readPrivateJson(a.markerPath, 2048)
    if (!marker?.live || seenAt !== null) return
    seenAt = performance.now()
    if (receiptAfterMs !== null) setTimeout(() => writeFileSync(`${a.markerPath}.ready`, JSON.stringify({ turnId: marker.turnId, sessionId: marker.sessionId, open: false })), receiptAfterMs)
  }, 10)
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)))
  const elapsed = performance.now() - started
  clearTimeout(killer)
  clearInterval(watch)
  const marker = readPrivateJson(a.markerPath, 2048)
  const markerLive = marker?.live === true && marker.sessionId === a.payload.session_id
  return { code, killed, elapsed, stderr, sawMarker: seenAt !== null || markerLive, markerLive }
}

test('a reply reminder run as its own prompt: the hook waits for the daemon\'s receipt before the prompt runs', async (t) => {
  const r = await runHook(agent(t, REMINDER), 800)
  assert.equal(r.killed, false, `killed after ${Math.round(r.elapsed)} ms`)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.sawMarker, true, 'the live marker was written')
  assert.ok(r.elapsed >= 800, `the hook returned after ${Math.round(r.elapsed)} ms, before the receipt at 800 ms after its marker`)
  assert.ok(r.elapsed < 2400, `it ended at the receipt, not at its deadline: ${Math.round(r.elapsed)} ms`)
})

test('a raw card prompt whose receipt never comes still ends inside the registered timeout', async (t) => {
  const r = await runHook(agent(t, REMINDER), null)
  assert.equal(r.killed, false, `killed after ${Math.round(r.elapsed)} ms`)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.elapsed + 1000 <= limitMs(), `${Math.round(r.elapsed)} ms leaves less than 1 s of the timeout`)
})

test('control: a typed prompt (no delivery token, no raw card tag) does not wait for a receipt', async (t) => {
  const r = await runHook(agent(t, 'Also tidy the board while you are at it.'), null)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.sawMarker, true, 'the live marker was written')
  assert.ok(r.elapsed < 1500, `${Math.round(r.elapsed)} ms`)
})

test('control: a typed prompt that only mentions the raw card tag mid line does not wait either', async (t) => {
  const r = await runHook(agent(t, `what does ${PRIVATE_RAW_CARD_TAG} mean in my last card?`), null)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(r.elapsed < 1500, `${Math.round(r.elapsed)} ms`)
})
