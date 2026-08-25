/**
 * Startup must reach the poll, and the log must name the phase that did not.
 *
 * WHY (2026-08-25, external tester, pairing 1041): the daemon's last log line
 * on two separate starts was `MCP server connected over stdio`. Between that
 * line and the first poll, main() awaited three things: the served capability
 * canon, the slash-command registry, and chat discovery. Nothing in the file
 * was bounded, so a stalled call in that window meant the daemon never polled
 * again, and because nothing narrated the window, a hang and a crash produced
 * an identical log.
 *
 * Two families of guard here:
 *
 *  1. A MIRROR of main()'s startup sequence built from the SAME helpers
 *     server.ts uses, driven with a warm-up that hangs, a warm-up that
 *     throws, and a registry walk that hangs. In every case the mirror must
 *     still reach the polling phase. This repo's convention for behaviour
 *     that lives in the un-importable server.ts (see poll-core.test.ts,
 *     pending-empty-system.test.ts).
 *  2. SOURCE CONTRACTS over server.ts, so the mirror cannot silently drift
 *     from the thing it mirrors: the warm-up must not be awaited, the
 *     registry must be bounded, the phases must be narrated, and no bare
 *     unbounded fetch may come back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  isDeadlineExceeded,
  startupPhase,
  withDeadline,
} from '../lib/bounded-fetch.ts'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
  'utf8',
)

/**
 * Just the startup window: from the last line the tester's log ever reached
 * to the line that says delivery is live. Assertions about what may or may
 * not block delivery belong to THIS region, not to the whole file (the same
 * calls are legitimately awaited from runtime handlers).
 */
const startupRegion = (() => {
  const from = source.indexOf("log('MCP server connected over stdio')")
  const to = source.indexOf('startup complete: polling armed')
  assert.ok(from > 0 && to > from, 'could not locate the startup window in server.ts')
  return source.slice(from, to)
})()

const NEVER = new Promise<never>(() => {})

interface MirrorDeps {
  warmup: () => Promise<unknown>
  slashRegistry: () => Promise<string[]>
  discoverChats: () => Promise<void>
  poll: () => Promise<void>
  log: (msg: string) => void
  registryDeadlineMs?: number
}

/**
 * The shape of main() from `MCP server connected over stdio` to the moment
 * polling is armed. Mirrors server.ts step for step.
 */
async function startupMirror(deps: MirrorDeps): Promise<void> {
  const log = deps.log
  const phase = <T,>(name: string, run: () => Promise<T>): Promise<T> =>
    startupPhase(name, run, { log })

  // Step 1.5: warm-up, NOT awaited.
  void phase('capability-canon warm-up', deps.warmup).catch((err) =>
    log(`capability canon warm-up gave up: ${err}`),
  )

  // Step 1.75: awaited, but bounded.
  const registry = await phase('slash-command registry', () =>
    withDeadline(deps.slashRegistry(), {
      timeoutMs: deps.registryDeadlineMs ?? 25,
      label: 'slash-command registry walk',
      log,
    }),
  )
  log(
    isDeadlineExceeded(registry)
      ? 'registry: proceeding without it'
      : `registry: ${registry.length} command(s)`,
  )

  // Step 2: awaited on purpose, it decides what there is to poll.
  await phase('discover chats', deps.discoverChats)
  await phase('boot poll sweep', deps.poll)
  log('startup complete: polling armed, message delivery is live')
}

function harness(over: Partial<MirrorDeps> = {}): {
  run: () => Promise<void>
  lines: string[]
  state: { polled: number; discovered: number }
} {
  const lines: string[] = []
  const state = { polled: 0, discovered: 0 }
  const deps: MirrorDeps = {
    warmup: async () => 'canon',
    slashRegistry: async () => ['reply'],
    discoverChats: async () => {
      state.discovered += 1
    },
    poll: async () => {
      state.polled += 1
    },
    log: (msg) => lines.push(msg),
    ...over,
  }
  return { run: () => startupMirror(deps), lines, state }
}

// ── 1. The mirror reaches the poll whatever the warm-ups do ──────────────────

test('a warm-up that never answers does not stop the daemon reaching the poll', { timeout: 3_000 }, async () => {
  const h = harness({ warmup: () => NEVER })
  await h.run()
  assert.equal(h.state.polled, 1, 'the boot poll sweep never ran')
  assert.ok(
    h.lines.includes('startup complete: polling armed, message delivery is live'),
    'startup never reported itself complete',
  )
  // And the log still says the warm-up is outstanding, rather than hiding it.
  assert.ok(h.lines.includes('startup phase start: capability-canon warm-up'))
  assert.equal(
    h.lines.some((l) => l.startsWith('startup phase ok: capability-canon warm-up')),
    false,
    'a hung warm-up must not be reported as finished',
  )
})

test('a warm-up that THROWS does not stop the daemon reaching the poll', { timeout: 3_000 }, async () => {
  const h = harness({
    warmup: async () => {
      throw new Error('GET 500: capabilities endpoint exploded')
    },
  })
  await h.run()
  assert.equal(h.state.polled, 1)
  await new Promise((r) => setTimeout(r, 5))
  assert.ok(
    h.lines.some((l) =>
      /startup phase FAILED: capability-canon warm-up .*capabilities endpoint exploded/.test(l),
    ),
    `the failure must be named in the log, got: ${JSON.stringify(h.lines)}`,
  )
})

test('a SLOW warm-up does not delay the poll by even its own duration', { timeout: 3_000 }, async () => {
  let released = false
  const h = harness({
    warmup: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          released = true
          resolve('late canon')
        }, 200),
      ),
  })
  await h.run()
  assert.equal(h.state.polled, 1)
  assert.equal(released, false, 'startup waited for a warm-up it should not wait for')
})

test('a registry walk that hangs is abandoned and the daemon still polls', { timeout: 3_000 }, async () => {
  const h = harness({ slashRegistry: () => NEVER, registryDeadlineMs: 25 })
  await h.run()
  assert.equal(h.state.polled, 1)
  assert.ok(
    h.lines.some((l) =>
      /deadline exceeded after 25ms: slash-command registry walk/.test(l),
    ),
    'abandoning the walk must be logged, not silent',
  )
  assert.ok(h.lines.includes('registry: proceeding without it'))
  assert.ok(
    h.lines.includes('startup complete: polling armed, message delivery is live'),
  )
})

test('the ordinary path is unchanged: registry first, then discovery, then poll', { timeout: 3_000 }, async () => {
  const h = harness()
  await h.run()
  assert.equal(h.state.discovered, 1)
  assert.equal(h.state.polled, 1)
  const order = h.lines.filter((l) => l.startsWith('startup phase start: '))
  assert.deepEqual(order, [
    'startup phase start: capability-canon warm-up',
    'startup phase start: slash-command registry',
    'startup phase start: discover chats',
    'startup phase start: boot poll sweep',
  ])
  assert.ok(h.lines.includes('registry: 1 command(s)'))
})

test('a phase that hangs is identifiable from the log alone', async () => {
  // The whole point of the narration: the LAST `start` with no matching `ok`
  // names the phase that stopped, which is the answer nobody could get from
  // "MCP server connected over stdio" and silence.
  const h = harness({ discoverChats: () => NEVER })
  void h.run()
  await new Promise((r) => setTimeout(r, 60))
  const started = h.lines
    .filter((l) => l.startsWith('startup phase start: '))
    .map((l) => l.slice('startup phase start: '.length))
  const finished = h.lines
    .filter((l) => l.startsWith('startup phase ok: '))
    .map((l) => l.slice('startup phase ok: '.length).replace(/ \(\d+ms\)$/, ''))
  const stuck = started.filter((name) => !finished.includes(name))
  assert.ok(stuck.includes('discover chats'), `stuck phases: ${stuck.join(', ')}`)
  assert.equal(h.state.polled, 0)
})

// ── 2. Source contracts: the mirror must keep mirroring server.ts ────────────

test('server.ts has no unbounded fetch left', () => {
  assert.equal(
    /await fetch\(/.test(source),
    false,
    'a bare `await fetch(` is back in server.ts: it can hang forever',
  )
  assert.match(source, /from '\.\/lib\/bounded-fetch\.js'/)
})

test('server.ts declares a deadline for each distinct use, with a reason', () => {
  assert.match(source, /const HTTP_TIMEOUT_MS = /)
  assert.match(source, /const STARTUP_WARMUP_TIMEOUT_MS = /)
  assert.match(source, /const PEER_HTTP_TIMEOUT_MS = /)
  assert.match(source, /const UPLOAD_TIMEOUT_MS = /)
  assert.match(source, /const SLASH_REGISTRY_DEADLINE_MS = /)
  // The peer bound must stay ABOVE the ordinary one: send_to_peer holds the
  // request open server side for up to 50s, so an ordinary bound would cut
  // off a reply the backend was about to hand us.
  const peer = Number(/const PEER_HTTP_TIMEOUT_MS = ([0-9_]+)/.exec(source)?.[1]?.replace(/_/g, ''))
  const ordinary = Number(
    /const HTTP_TIMEOUT_MS = Math\.max\(\s*[0-9_]+,\s*Number\(process\.env\.BGOS_HTTP_TIMEOUT_MS\) \|\| ([0-9_]+),/
      .exec(source)?.[1]
      ?.replace(/_/g, ''),
  )
  assert.ok(Number.isFinite(peer) && Number.isFinite(ordinary), 'could not read the bounds')
  assert.ok(peer > 50_000, `the peer bound (${peer}ms) must exceed the 50s server-side wait`)
  assert.ok(peer > ordinary, 'the peer bound must be the longer of the two')
  // The warm-up gives up quickly BECAUSE it has a bundled fallback.
  const warmup = Number(/const STARTUP_WARMUP_TIMEOUT_MS = ([0-9_]+)/.exec(source)?.[1]?.replace(/_/g, ''))
  assert.ok(warmup < ordinary, 'the startup warm-up should give up sooner than an ordinary call')
})

test('the capability warm-up is NOT awaited on the startup path', () => {
  assert.equal(
    /await loadServedCapabilities\(\)/.test(startupRegion),
    false,
    'the capability warm-up is being awaited again: an unavailable backend can block delivery',
  )
  assert.match(
    startupRegion,
    /void phase\('capability-canon warm-up', \(\) => loadServedCapabilities\(\)\)/,
  )
})

test('the slash registry is awaited but bounded', () => {
  assert.equal(
    /const initialSlashCommands = await refreshSlashCommandRegistry\(\)/.test(startupRegion),
    false,
    'the registry walk is unbounded again: a stalled filesystem would hold messages',
  )
  assert.match(startupRegion, /withDeadline\(refreshSlashCommandRegistry\(\)/)
  assert.match(startupRegion, /timeoutMs: SLASH_REGISTRY_DEADLINE_MS/)
})

test('every startup step between the transport and the poll is narrated', () => {
  for (const name of [
    'capability-canon warm-up',
    'slash-command registry',
    'discover chats',
    'boot poll sweep',
    'update stream init',
  ]) {
    assert.ok(
      startupRegion.includes(`phase('${name}'`),
      `startup step "${name}" is no longer narrated: a hang there would be unreadable again`,
    )
  }
  assert.match(source, /startup phase start: websocket connect/)
  assert.match(source, /startup complete: polling armed, message delivery is live/)
})

test('loadServedCapabilities is single-flight, so the background warm-up cannot double-fetch', () => {
  assert.match(source, /capabilitiesInFlight/)
  assert.match(source, /if \(capabilitiesInFlight\) return capabilitiesInFlight/)
})

test('a fired deadline is distinguishable in the capability log line', () => {
  assert.match(source, /isFetchTimeoutError\(err\)/)
  assert.match(source, /warm-up deadline/)
})
