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
  /** The watcher's cached keep-alive answer, written `agoMs` ago; none when absent. */
  cache?: { answer: Record<string, unknown>; agoMs: number }
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
  if (scene.watcher !== false) files.set(kept.watcherServiceFiles({ platform, home, env: {} })[0]!, 'x')
  if (scene.cache) {
    files.set(kept.keepAliveCacheFile(home), buildKeepAliveCache({ enabledAt: null, showAgentWindows: false, ...scene.cache.answer }, now - scene.cache.agoMs))
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
    alwaysOnRefusalLogged: null,
    alwaysOnReleaseFailure: null,
    process: { platform, env: {}, getuid: () => 501 },
    ASSISTANT_ID: ID,
    BGOS_AGENT_BIN: BIN,
    ALWAYS_ON_WORKDIR: `${home}/hoai-agents/agent-912`,
    homedir: () => home,
    joinPath: posix.join,
    existsSync: (p: string) => p === BIN || files.has(p),
    readTextOrNull: (p: string) => files.get(p) ?? null,
    writeFileSync: (p: string, text: string) => void files.set(p, String(text)),
    bgosGetCachedOn304: async () => ({ code: 'claude-code', alwaysOn: scene.alwaysOn ?? true }),
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
      writeFile: (p: string, text: string) => void files.set(p, text),
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
