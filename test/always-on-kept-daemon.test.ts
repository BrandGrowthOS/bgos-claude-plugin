/**
 * The agent's own daemon on Mac and Linux (server.ts reconcileAlwaysOn), RUN, not scanned: the
 * function is taken from server.ts by its syntax (with isAlwaysOnInstalled beside it) and run with
 * the machine stood in for: a memory of files, bin/bgos-agent answering is-installed and install the
 * way the real one leaves the disk, and the removal's commands recorded. Everything that decides is
 * the real code (lib/agent-kept.mjs, lib/always-on-reconcile.ts, lib/agent-inventory.mjs).
 *
 * What it pins (lib/agent-kept.mjs, switched off stays off, review round 3):
 *   B1  a cached refusal (401/403) is no answer: nothing is removed, nothing installed;
 *   M1  a cache older than 5 minutes is no answer: the watcher rewrites it every minute while it runs;
 *   m1  an install the daemon makes because the agent is kept is seen kept at once (kept-seen);
 *   m2  "no watcher" is the watcher's install missing, never a missing cache: a fresh watcher
 *       before its first sweep moves nothing, so no install loop with the switch off.
 *
 * Run: npx tsx --test test/always-on-kept-daemon.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import ts from 'typescript'

import * as kept from '../lib/agent-kept.mjs'
import { canonicalService } from '../lib/agent-inventory.mjs'
import { buildKeepAliveCache } from '../lib/keepalive-plan.mjs'
import { decideAlwaysOnReconcile, describeOtherSupervisor } from '../lib/always-on-reconcile.ts'
import { serviceRefusalFrom } from '../lib/agent-service.mjs'

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SF = ts.createSourceFile('server.ts', SERVER, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)

function fnText(name: string): string {
  const found: ts.FunctionDeclaration[] = []
  const walk = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found.push(n)
    else ts.forEachChild(n, walk)
  }
  walk(SF)
  assert.equal(found.length, 1, `server.ts declares ${name} once`)
  return found[0]!.getText(SF)
}

const SOURCE = [
  'async function __run(__scope) {',
  ' with (__scope) {',
  '  return (async () => {',
  fnText('isAlwaysOnInstalled'),
  fnText('reconcileAlwaysOn'),
  '   await reconcileAlwaysOn()',
  '  })()',
  ' }',
  '}',
].join('\n')
const JS = ts.transpileModule(SOURCE, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, alwaysStrict: false } }).outputText
const RUN = new Function(`${JS}\nreturn __run;`)() as (scope: unknown) => Promise<void>

const ID = '912'
const BIN = '/plugin/bin/bgos-agent'
const MIN = 60_000

type Scene = {
  platform?: 'darwin' | 'linux'
  alwaysOn?: boolean
  /** The canonical supervisor is installed, `installedAgoMs` ago, and was seen kept (`seen`). */
  installed?: boolean
  installedAgoMs?: number
  seen?: boolean
  /** This HOME's watcher service file is there (default yes). */
  watcher?: boolean
  /** The watcher's cached keep-alive answer, written `agoMs` ago; none when absent. `unmarked`: as a watcher from before the format mark wrote it. */
  cache?: { answer: Record<string, unknown>; agoMs: number; unmarked?: boolean; listedRecently?: string[] }
  /** How this daemon is connected (server.ts AUTH.mode): a pairing by default, or an API key. */
  auth?: 'pairing' | 'apikey'
  /** The assistant answer carries no alwaysOn at all (an older or transitional backend). */
  noAlwaysOn?: boolean
  /** The not-kept run.sh cannot be written beside run.sh (review round 7 M1). */
  runShWriteFails?: boolean
  /** A removal took the supervisor: no service file, the not-kept run.sh in its place (review round 7 M5). */
  removed?: boolean
}

const ON = { enabled: true, assistantIds: ['912'], switchState: 'on' }
const OFF = { enabled: false, assistantIds: [], switchState: 'off' }

async function reconcile(scene: Scene) {
  const platform = scene.platform ?? 'darwin'
  const home = platform === 'darwin' ? '/Users/user' : '/home/user'
  const sd = `${home}/.bgos-agent/${ID}`
  const service = canonicalService(platform, home, ID, () => true)!
  const now = Date.now()
  const stampAgo = (ms: number) => `${Math.floor((now - ms) / 1000)}\n`
  const files = new Map<string, string>()
  if (scene.installed) {
    files.set(service.file, '<plist/>')
    files.set(`${sd}/run.sh`, '#!/usr/bin/env bash\nexec hoai-core\n')
    const stamp = stampAgo(scene.installedAgoMs ?? 60 * MIN)
    files.set(`${sd}/${kept.INSTALLED_AT_FILE_NAME}`, stamp)
    if (scene.seen) files.set(`${sd}/${kept.KEPT_SEEN_FILE_NAME}`, stamp)
  }
  if (scene.removed) {
    files.set(`${sd}/run.sh`, `#!/usr/bin/env bash\n${kept.NOT_KEPT_RUN_SH_MARK}\nexit 0\n`)
    files.set(`${sd}/${kept.INSTALLED_AT_FILE_NAME}`, stampAgo(60 * MIN))
    files.set(`${sd}/${kept.KEPT_SEEN_FILE_NAME}`, stampAgo(60 * MIN))
  }
  if (scene.watcher !== false) files.set(kept.watcherServiceFiles({ platform, home, env: {} })[0]!, 'x')
  if (scene.cache) {
    const empty = scene.cache.listedRecently ? { listedRecently: scene.cache.listedRecently } : {}
    const text = buildKeepAliveCache({ enabledAt: null, showAgentWindows: false, ...scene.cache.answer, ...empty }, now - scene.cache.agoMs)
    files.set(kept.keepAliveCacheFile(home), scene.cache.unmarked ? `${JSON.stringify({ ...JSON.parse(text), format: undefined }, null, 2)}\n` : text)
  }
  const installStamp = stampAgo(0)
  const logs: string[] = []
  const agentCalls: string[][] = []
  const releaseCalls: string[][] = []
  const scope: Record<string, unknown> = {
    ...kept,
    canonicalService,
    decideAlwaysOnReconcile,
    describeOtherSupervisor,
    serviceRefusalFrom,
    // server.ts's module state, set and read by the reconcile.
    reconcileBusy: false,
    reconcileDisabledReason: null,
    alwaysOnDeferLogged: false,
    alwaysOnWaitLogged: false,
    alwaysOnHeldLogged: false,
    alwaysOnRefusalLogged: null,
    alwaysOnReleaseFailure: null,
    process: { platform, env: {}, getuid: () => 501 },
    ASSISTANT_ID: ID,
    AUTH: { mode: scene.auth ?? 'pairing' },
    BGOS_AGENT_BIN: BIN,
    ALWAYS_ON_WORKDIR: `${home}/hoai-agents/agent-912`,
    homedir: () => home,
    joinPath: posix.join,
    existsSync: (p: string) => p === BIN || files.has(p),
    readTextOrNull: (p: string) => files.get(p) ?? null,
    writeFileSync: (p: string, text: string) => void files.set(p, String(text)),
    bgosGetCachedOn304: async () => ({ code: 'claude-code', ...(scene.noAlwaysOn ? {} : { alwaysOn: scene.alwaysOn ?? true }) }),
    // bin/bgos-agent: is-installed reads the canonical file; install writes it and stamps installed-at.
    execFileAsync: async (file: string, args: string[]) => {
      assert.equal(file, BIN)
      agentCalls.push([...args])
      if (args[0] === 'is-installed') {
        if (files.has(service.file)) return { stdout: '', stderr: '' }
        throw Object.assign(new Error('not installed'), { code: 1, stdout: '', stderr: '' })
      }
      if (args[0] === 'install') {
        files.set(service.file, '<plist/>')
        files.set(`${sd}/${kept.INSTALLED_AT_FILE_NAME}`, installStamp)
        return { stdout: '', stderr: '' }
      }
      throw new Error(`bgos-agent ${args.join(' ')} is not stood in for`)
    },
    alwaysOnReleaseExec: async (file: string, args: readonly string[]) => {
      releaseCalls.push([file, ...args])
      return { code: 0, stdout: '', stderr: '' }
    },
    alwaysOnReleaseFs: {
      exists: (p: string) => files.has(p),
      writeFile: (p: string, text: string) => {
        if (scene.runShWriteFails && p.endsWith('.not-kept.tmp')) throw new Error('EACCES: permission denied')
        files.set(p, text)
      },
      rename: (from: string, to: string) => {
        files.set(to, files.get(from) ?? '')
        files.delete(from)
      },
      rm: (p: string) => void files.delete(p),
    },
    readAlwaysOnSupervision: () => ({ state: 'none' }),
    supervisionProbe: () => ({}),
    alwaysOnExecSync: () => ({ code: 1, stdout: '' }),
    logAgentServiceNotes: () => undefined,
    log: (line: string) => void logs.push(line),
    reportStandDown: async () => undefined,
    standDownPhase: () => 'boot',
  }
  const proxy = new Proxy(scope, {
    has: (t, k) => typeof k === 'string' && k in t,
    get: (t, k) => (t as Record<string | symbol, unknown>)[k],
    set: (t, k, v) => {
      ;(t as Record<string | symbol, unknown>)[k] = v
      return true
    },
  })
  await RUN(proxy)
  assert.equal(logs.some((l) => /reconcile error/.test(l)), false, logs.join('\n'))
  return {
    files,
    logs,
    installs: agentCalls.filter((a) => a[0] === 'install').length,
    releaseCalls,
    installed: files.has(service.file),
    runSh: files.get(`${sd}/run.sh`) ?? '',
    keptSeen: files.get(`${sd}/${kept.KEPT_SEEN_FILE_NAME}`) ?? null,
    installStamp,
  }
}

test('the harness runs the real reconcile: kept and installed is left; the switch off removes without ending what runs (control)', async () => {
  const left = await reconcile({ installed: true, seen: true, cache: { answer: ON, agoMs: MIN } })
  assert.equal(left.installed, true)
  assert.equal(left.installs, 0)
  const removed = await reconcile({ installed: true, seen: true, cache: { answer: OFF, agoMs: MIN } })
  assert.equal(removed.installed, false)
  assert.ok(removed.runSh.includes(kept.NOT_KEPT_RUN_SH_MARK))
  assert.deepEqual(removed.releaseCalls, [], 'Mac: no launchctl now, the job boots itself out after the agent exits')
  assert.ok(removed.logs.some((l) => /always-on: not kept running \(switch_off\), supervisor removed/.test(l)), removed.logs.join('\n'))
})

test('m1: an install the daemon makes because the agent is kept is seen kept at once, with the stamp bin/bgos-agent just wrote', async () => {
  // Kept by the switch and the list; and, today's meaning, on a computer with no watcher.
  for (const scene of [{ cache: { answer: ON, agoMs: MIN } }, { watcher: false }] as Scene[]) {
    const out = await reconcile(scene)
    assert.equal(out.installs, 1, JSON.stringify(scene))
    assert.equal(out.keptSeen, `${out.installStamp.trim()}\n`, `${JSON.stringify(scene)}: ${out.logs.join('\n')}`)
  }
})

test('B1: a refusal the watcher cached (401/403, marked refused) is no answer: the daemon neither removes nor installs, and never reads it as the switch off', async () => {
  const answer = { ...OFF, refused: true }
  const installed = await reconcile({ installed: true, seen: true, cache: { answer, agoMs: MIN } })
  assert.equal(installed.installed, true, installed.logs.join('\n'))
  assert.equal(installed.runSh, '#!/usr/bin/env bash\nexec hoai-core\n')
  assert.equal(installed.logs.some((l) => /not kept|switch_off/.test(l)), false, installed.logs.join('\n'))
  const bare = await reconcile({ cache: { answer, agoMs: MIN } })
  assert.equal(bare.installs, 0, 'no answer: nothing installed either')
})

test('round 4 m2: an older watcher\'s refusal (OFF, fresh, written before the format mark, so not marked refused) is no answer: the daemon removes nothing, on Mac or Linux', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const old = await reconcile({ platform, installed: true, seen: true, cache: { answer: OFF, agoMs: MIN, unmarked: true } })
    assert.equal(old.installed, true, `${platform}: ${old.logs.join('\n')}`)
    assert.equal(old.runSh, '#!/usr/bin/env bash\nexec hoai-core\n')
    assert.deepEqual(old.releaseCalls, [])
    assert.equal(old.logs.some((l) => /not kept|switch_off/.test(l)), false, old.logs.join('\n'))
    const bare = await reconcile({ platform, cache: { answer: ON, agoMs: MIN, unmarked: true } })
    assert.equal(bare.installs, 0, `${platform}: unmarked is no answer whatever it says: nothing installed either`)
  }
  // The control: the same OFF from this watcher (marked) is the owner's switch.
  const marked = await reconcile({ installed: true, seen: true, cache: { answer: OFF, agoMs: MIN } })
  assert.equal(marked.installed, false)
})

test('round 4 m1 (the maintainer\'s ruling): an empty list with the switch on is no answer to the daemon until the watcher read it twice a minute apart; then the agent is not listed', async () => {
  const EMPTY = { enabled: true, assistantIds: [], switchState: 'on' }
  // The watcher counts the reads (by its steady clock, round 4c); the cache carries only who they confirm is listed.
  const once = await reconcile({ installed: true, seen: true, cache: { answer: EMPTY, agoMs: MIN } })
  assert.equal(once.installed, true, once.logs.join('\n'))
  assert.equal(once.logs.some((l) => /not kept/.test(l)), false, once.logs.join('\n'))
  // A second empty read a minute after the first.
  const twice = await reconcile({ installed: true, seen: true, cache: { answer: EMPTY, agoMs: MIN, listedRecently: [] } })
  assert.equal(twice.installed, false, twice.logs.join('\n'))
  assert.ok(twice.logs.some((l) => /not kept running \(not_listed/.test(l)), twice.logs.join('\n'))
})

test('round 4c ruling, pinned: the daemon\'s own alwaysOn:false read is the owner\'s switch and removes on ONE read, even while the list still names the agent', async () => {
  const out = await reconcile({ installed: true, seen: true, alwaysOn: false, cache: { answer: { enabled: true, assistantIds: [912], switchState: 'on' }, agoMs: MIN } })
  assert.equal(out.installed, false, out.logs.join('\n'))
  assert.ok(out.logs.some((l) => /not kept running \(always_on_off:was_kept/.test(l)), out.logs.join('\n'))
})

test('round 4c ruling: a good list that leaves this agent out is no answer to the daemon until the watcher confirmed it', async () => {
  const OTHERS = { enabled: true, assistantIds: [7], switchState: 'on' }
  const once = await reconcile({ installed: true, seen: true, cache: { answer: OTHERS, agoMs: MIN } })
  assert.equal(once.installed, true, once.logs.join('\n'))
  const listed = await reconcile({ installed: true, seen: true, cache: { answer: OTHERS, agoMs: MIN, listedRecently: ['7', '912'] } })
  assert.equal(listed.installed, true, listed.logs.join('\n'))
  const twice = await reconcile({ installed: true, seen: true, cache: { answer: OTHERS, agoMs: MIN, listedRecently: ['7'] } })
  assert.equal(twice.installed, false, twice.logs.join('\n'))
})

test('M1: the daemon trusts the watcher\'s cache only while it is fresh: OFF older than 5 minutes removes nothing, and ON older than 5 minutes installs nothing', async () => {
  const fresh = await reconcile({ installed: true, seen: true, cache: { answer: OFF, agoMs: 4 * MIN } })
  assert.equal(fresh.installed, false, 'fresh: the switch off, removed')
  const stale = await reconcile({ installed: true, seen: true, cache: { answer: OFF, agoMs: 6 * MIN } })
  assert.equal(stale.installed, true, stale.logs.join('\n'))
  assert.equal(stale.logs.some((l) => /not kept/.test(l)), false)
  const staleOn = await reconcile({ cache: { answer: ON, agoMs: 6 * MIN } })
  assert.equal(staleOn.installs, 0)
  // Linux too: the same rule, the same reader.
  const linux = await reconcile({ platform: 'linux', installed: true, seen: true, cache: { answer: OFF, agoMs: 6 * MIN } })
  assert.equal(linux.installed, true)
  assert.deepEqual(linux.releaseCalls, [])
})

test('m2: a watcher installed but not yet swept (no cache) is no answer: with Always on on, nothing is installed for the sweep to remove a minute later; no watcher at all keeps today\'s meaning', async () => {
  const fresh = await reconcile({})
  assert.equal(fresh.installs, 0, fresh.logs.join('\n'))
  const again = await reconcile({})
  assert.equal(again.installs, 0, 'no loop: still nothing')
  const none = await reconcile({ watcher: false })
  assert.equal(none.installs, 1, 'no watcher: Always on alone, as before')
  const noneOff = await reconcile({ watcher: false, cache: { answer: OFF, agoMs: MIN } })
  assert.equal(noneOff.installs, 1, 'a cache an uninstalled watcher left is no switch')
})

// Review round 5, B2: an agent with no pairing can never be on the backend's list, so the daemon follows its own Always on read.
const OTHERS_ONLY = { enabled: true, assistantIds: [7], switchState: 'on' }

test('r5 A1: Always on ON, connected with a key, seen kept: its supervisor stays', async () => {
  const out = await reconcile({ auth: 'apikey', alwaysOn: true, installed: true, seen: true, cache: { answer: OTHERS_ONLY, agoMs: MIN, listedRecently: ['7'] } })
  assert.equal(out.installed, true, out.logs.join('\n'))
})

test('r5 A2: Always on ON, connected with a key, no supervisor yet: the daemon installs one', async () => {
  const out = await reconcile({ auth: 'apikey', alwaysOn: true, installed: false, cache: { answer: OTHERS_ONLY, agoMs: MIN, listedRecently: ['7'] } })
  assert.equal(out.installs, 1, out.logs.join('\n'))
})

test('r5 control: connected with a key, Always on OFF with the same answer still removes on one read', async () => {
  const out = await reconcile({ auth: 'apikey', alwaysOn: false, installed: true, seen: true, cache: { answer: OTHERS_ONLY, agoMs: MIN, listedRecently: ['7'] } })
  assert.equal(out.installed, false, out.logs.join('\n'))
})

test('r5 pin: connected with a key, the computer switch OFF still removes with Always on ON', async () => {
  const out = await reconcile({ auth: 'apikey', alwaysOn: true, installed: true, seen: true, cache: { answer: OFF, agoMs: MIN } })
  assert.equal(out.installed, false, out.logs.join('\n'))
})

test('r5 pin: a paired agent confirmed left out still goes, the two-read rule is unchanged for agents the list could name', async () => {
  const out = await reconcile({ auth: 'pairing', alwaysOn: true, installed: true, seen: true, cache: { answer: OTHERS_ONLY, agoMs: MIN, listedRecently: ['7'] } })
  assert.equal(out.installed, false, out.logs.join('\n'))
})

// Review round 6, V8: an answer with no `alwaysOn` (an older or transitional backend) moves nothing, whatever the
// watcher's cache says. Without that guard a cached switch OFF would remove, and a cached list would install.
test('r6 V8: an assistant answer without alwaysOn moves nothing: a cached switch OFF removes nothing, a cached list installs nothing', async () => {
  const off = await reconcile({ noAlwaysOn: true, installed: true, seen: true, cache: { answer: OFF, agoMs: MIN } })
  assert.equal(off.installed, true, off.logs.join('\n'))
  assert.deepEqual(off.releaseCalls, [])
  const on = await reconcile({ noAlwaysOn: true, installed: false, cache: { answer: ON, agoMs: MIN } })
  assert.equal(on.installs, 0, on.logs.join('\n'))
  // The same answers with alwaysOn act, so the cases above are the guard's.
  assert.equal((await reconcile({ alwaysOn: true, installed: true, seen: true, cache: { answer: OFF, agoMs: MIN } })).installed, false)
  assert.equal((await reconcile({ alwaysOn: true, installed: false, cache: { answer: ON, agoMs: MIN } })).installs, 1)
})

test('r7 M1: Linux, a removal whose not-kept run.sh cannot be written is said as removed in part, with the marker left; never as removed', async () => {
  const out = await reconcile({ platform: 'linux', installed: true, seen: true, alwaysOn: false, cache: { answer: ON, agoMs: MIN }, runShWriteFails: true })
  assert.equal(out.installed, false, 'the unit is gone')
  assert.equal(out.files.has(`/home/user/.bgos-agent/${ID}/${kept.NOT_KEPT_FILE_NAME}`), true, 'the sign the sweep reads')
  assert.ok(out.logs.some((l) => /always-on: not kept running \([^)]*\), supervisor removed in part: .*could not be replaced/.test(l)), out.logs.join('\n'))
  assert.equal(out.logs.some((l) => /supervisor removed:|supervisor NOT removed/.test(l)), false, out.logs.join('\n'))
})

test('r7 M3: the daemon\'s removal takes bin/bgos-agent\'s install lock through its own file system: one directory, never a recursive mkdir', () => {
  const start = SERVER.indexOf('const alwaysOnReleaseFs = {')
  const body = SERVER.slice(start, SERVER.indexOf('\n}\n', start))
  assert.match(body, /mkdirExclusive: \(path: string\) => void mkdirSync\(path\),/)
  assert.match(body, /rmdir: \(path: string\) => rmdirSync\(path\),/)
})

test('r7 M5 (r7rev FUZZ run 427): a supervisor a removal took is not put back by the daemon on the watcher\'s cached list, which can be older than the removal; the watcher\'s live read does it', async () => {
  // Always on off (the daemon removed), the computer switch then off with no read since, Always on back on.
  const held = await reconcile({ removed: true, alwaysOn: true, cache: { answer: ON, agoMs: MIN } })
  assert.equal(held.installs, 0, held.logs.join('\n'))
  assert.ok(held.logs.some((l) => /not installing it here; the watcher installs it once a live keep-alive read names it/.test(l)), held.logs.join('\n'))
  // Controls: never removed, it is installed as before; kept by Always on alone (a key agent, no watcher), too.
  assert.equal((await reconcile({ alwaysOn: true, cache: { answer: ON, agoMs: MIN } })).installs, 1)
  assert.equal((await reconcile({ removed: true, alwaysOn: true, auth: 'apikey', cache: { answer: OTHERS_ONLY, agoMs: MIN, listedRecently: ['7'] } })).installs, 1)
  assert.equal((await reconcile({ removed: true, alwaysOn: true, watcher: false })).installs, 1)
})
