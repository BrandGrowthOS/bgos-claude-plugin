import './helpers/real-os-sentinel.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAccountWatcher } from '../lib/helper-account-watcher.mjs'
import { handleFrame } from '../lib/watcher-core.mjs'
import { nodeFs } from '../lib/watcher-bundle.mjs'
import { applyHelperAccount } from '../lib/helper-account-launch.mjs'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'
import { transcriptPathFor } from '../lib/watcher-keepalive.mjs'
import { accountTokenFrom } from '../lib/claude-account-id.mjs'

test('a watcher reports only fresh capkeeper windows from the matching signed-in profile', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helper-statusline-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const now = Date.now()
  const credentials = { machineId: 'machine12345', pairingId: 9 }
  const watcher = createAccountWatcher({ home, credentials, now: () => now, env: {}, fs: nodeFs() }, {
    list: () => [], probe: async () => true,
  })
  for (const label of ['Studio', 'Work']) {
    await watcher.run(randomUUID(), {
      op: 'helper_accounts', requestedBy: 'owner', ...credentials, watcherPairingId: 9,
      ownerUserId: 'fixture', targets: [], accountCommand: { action: 'add', label },
    })
  }
  const ids = (await watcher.snapshot()).accounts.map((a) => a.id)
  const dirs = ids.map((id) => join(home, '.bgos-agent', 'helper-accounts', id, 'state', 'usage'))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  const shortReset = Math.floor(now / 1000) + 3600
  const weekReset = shortReset + 86400
  const observed = new Date(Math.floor(now / 1000) * 1000 - 30000)
  const path = join(dirs[0], 'last-status.json')
  const publish = (value: Record<string, unknown>) => {
    writeFileSync(path, JSON.stringify({ rate_limits: value }))
    utimesSync(path, observed, observed)
  }
  publish({ five_hour: { used_percentage: 0, resets_at: shortReset }, seven_day: { used_percentage: 86.5, resets_at: weekReset },
    spend_limit: { used_percentage: 100 }, privateValue: 'never forward' })
  symlinkSync(path, join(dirs[1], 'last-status.json'))
  const [studio, work] = (await watcher.snapshot()).accounts
  const expected = {
    readAt: observed.toISOString(),
    fiveHour: { used: 0, resetAt: new Date(shortReset * 1000).toISOString() },
    week: { used: 86.5, resetAt: new Date(weekReset * 1000).toISOString() },
  }
  assert.deepEqual(studio.usageWindows, expected)
  assert.equal(studio.usage, null)
  assert.equal(work.usageWindows, undefined)
  publish({ five_hour: { used_percentage: 101, resets_at: shortReset }, seven_day: { used_percentage: 86.5, resets_at: weekReset } })
  assert.deepEqual((await watcher.snapshot()).accounts[0].usageWindows, { readAt: expected.readAt, week: expected.week })
  const stale = new Date(now - 11 * 60_000)
  utimesSync(path, stale, stale)
  assert.equal((await watcher.snapshot()).accounts[0].usageWindows, undefined)
})

test('authenticated watcher frame returns only after the selected child resumes its pinned transcript and answers', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'account-frame-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const write = (p: string, value: any) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(value))
  }
  const credentials = { machineId: 'machine12345', pairingId: 9, backendUrl: 'http://127.0.0.1:1' }
  const stateDir = join(home, '.bgos-agent', '11'),
    cwd = join(home, 'agent'),
    id = randomUUID(),
    pin = randomUUID()
  const row: any = {
    assistantId: '11',
    stateDir,
    pluginStateDir: stateDir,
    cwd,
    sessionId: pin,
    credentialsPath: join(home, '.bgos-agent', 'credentials-11.json'),
    recipe: { claudeConfigDir: null, cwd, assistantId: '11' },
    launcherLive: true,
  }
  write(row.credentialsPath, { userId: 'user_fixture', assistantId: 11, pairingId: 19, backendUrl: credentials.backendUrl })
  write(join(home, '.bgos-agent', 'watcher', 'credentials.json'), credentials)
  write(sessionTranscriptPath(home, cwd, pin), { uuid: pin, message: 'previous fixture turn' })
  const at = Date.now()
  const agentState = {
    schemaVersion: 1,
    assistantId: '11',
    pid: 101,
    updatedAt: new Date(at).toISOString(),
    sessionId: pin,
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    turnSignal: 'hooks',
  }
  write(join(stateDir, 'agent-state.json'), agentState)
  let job: any
  let probes = 0
  const progress: any[] = [],
    steps: string[] = []
  const ctx: any = {
    home,
    env: {},
    credentials,
    fs: nodeFs(),
    now: () => at,
    pidAlive: () => true,
    log: () => {},
    writeState: () => {},
    client: {
      ack: async () => ({ ok: true }),
      job: async () => ({ ok: true, json: job }),
      progress: async (_: string, p: any) => {
        progress.push(p)
        return { ok: true }
      },
    },
  }
  ctx.accounts = createAccountWatcher(ctx, {
    uuid: () => id,
    list: () => [row],
    probe: async () => { probes++; return true },
    eligible: async () => true,
    requestRestart: async () => {
      const childEnv: any = {}
      applyHelperAccount({ home, cwd, env: childEnv, assistantId: '11', sessionId: pin, sessionTranscriptPath })
      assert.equal(
        JSON.parse(readFileSync(sessionTranscriptPath(home, cwd, pin, childEnv.CLAUDE_CONFIG_DIR), 'utf8')).uuid,
        pin,
      )
      row.recipe.claudeConfigDir = childEnv.CLAUDE_CONFIG_DIR
      write(join(stateDir, 'agent-state.json'), { ...agentState, pid: 102 })
      steps.push('relaunched')
      return { ok: true }
    },
    verify: async () => {
      steps.push('new-boot-hello')
      return { ok: true }
    },
  })
  const frame = async (command: any, targets: any[], outcome = 'done') => {
    job = {
      op: 'helper_accounts',
      machineId: credentials.machineId,
      watcherPairingId: 9,
      ownerUserId: 'user_fixture',
      requestedBy: 'owner',
      targets,
      accountCommand: command,
    }
    await handleFrame(ctx, { op: job.op, rpcId: randomUUID() })
    assert.equal(progress.at(-1).state, outcome)
  }
  await frame({ action: 'add', label: 'Local fixture' }, [])
  const command = { action: 'assign', mode: 'now', accountId: id, assistantId: 11 }
  const targets = [{ assistantId: 11, pairingId: 19 }]
  const profile = join(home, '.bgos-agent', 'helper-accounts', id)
  rmSync(profile, { recursive: true })
  symlinkSync(join(home, '.claude'), profile, 'dir')
  await frame(command, targets)
  assert.equal((await ctx.accounts.snapshot()).status, 'needs_sign_in')
  assert.deepEqual(steps, [])
  assert.equal(probes, 0)
  rmSync(profile)
  await frame(command, targets)
  assert.equal(probes, 0)
  mkdirSync(profile)
  symlinkSync(join(home, '.claude', '.credentials.json'), join(profile, '.credentials.json'))
  await frame(command, targets)
  assert.equal(probes, 0)
  rmSync(join(profile, '.credentials.json'))
  rmSync(sessionTranscriptPath(home, cwd, pin))
  await frame(command, targets, 'failed')
  assert.equal((await ctx.accounts.snapshot()).status, 'failed')
  assert.deepEqual(steps, [])
  write(sessionTranscriptPath(home, cwd, pin), { uuid: pin, message: 'previous fixture turn' })
  await frame({ action: 'assign', mode: 'now', accountId: id, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  assert.deepEqual(steps, ['relaunched', 'new-boot-hello'])
  const snapshot = await ctx.accounts.snapshot()
  assert.equal(snapshot.status, 'back_online')
  assert.equal(snapshot.agents[0].accountId, id)
  assert.ok(!JSON.stringify(snapshot).includes(home))
})

test('verify #10: a job that throws in the real frame handler reaches the owner as refused, by its own id', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'account-throw-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const credentials = { machineId: 'machine12345', pairingId: 9, backendUrl: 'http://127.0.0.1:1' }
  const rpcId = randomUUID()
  // A Restore on a computer with no saved logins: the watcher refuses it.
  const job = { op: 'helper_accounts', requestedBy: 'owner', ...credentials, watcherPairingId: 9, ownerUserId: 'user_fixture', targets: [], accountCommand: { action: 'rebind' } }
  let published = 0
  const progress: any[] = []
  const ctx: any = {
    home, env: {}, credentials, fs: nodeFs(), now: () => Date.now(), pidAlive: () => true, log: () => {}, writeState: () => {},
    publishAccounts: async () => { published++ },
    client: {
      ack: async () => ({ ok: true }),
      job: async () => ({ ok: true, json: job }),
      progress: async (_: string, p: any) => { progress.push(p); return { ok: true } },
    },
  }
  ctx.accounts = createAccountWatcher(ctx, { list: () => [], probe: async () => true })
  await handleFrame(ctx, { op: job.op, rpcId })
  assert.deepEqual((await ctx.accounts.snapshot()).refusedRpcIds, [rpcId])
  assert.ok(published >= 1)
  assert.equal(progress.at(-1).state, 'failed')
})

test('verify B: a second press refused in the real frame handler never overwrites the change still waiting', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'account-inflight-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const write = (p: string, value: string) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, value)
  }
  const credentials = { machineId: 'machine12345', pairingId: 9, backendUrl: 'http://127.0.0.1:1' }
  const stateDir = join(home, '.bgos-agent', '11'),
    cwd = join(home, 'agent'),
    pin = randomUUID()
  const row: any = {
    assistantId: '11', stateDir, pluginStateDir: stateDir, cwd, sessionId: pin,
    credentialsPath: join(home, '.bgos-agent', 'credentials-11.json'),
    recipe: { claudeConfigDir: null, cwd, assistantId: '11' }, launcherLive: true,
  }
  write(row.credentialsPath, JSON.stringify({ userId: 'user_fixture', assistantId: 11, pairingId: 19, backendUrl: credentials.backendUrl }))
  // Mid turn: the first Switch now waits for it.
  write(join(stateDir, 'agent-state.json'), JSON.stringify({
    schemaVersion: 1, assistantId: '11', pid: 101, updatedAt: new Date().toISOString(), sessionId: pin,
    turnInFlight: true, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, turnSignal: 'hooks',
  }))
  let job: any
  const ctx: any = {
    home, env: {}, credentials, fs: nodeFs(), now: () => Date.now(), pidAlive: () => true, log: () => {}, writeState: () => {},
    publishAccounts: async () => {},
    client: { ack: async () => ({ ok: true }), job: async () => ({ ok: true, json: job }), progress: async () => ({ ok: true }) },
  }
  ctx.accounts = createAccountWatcher(ctx, { list: () => [row], probe: async () => true, eligible: async () => true })
  const send = async (accountCommand: any, targets: any[] = []) => {
    const rpcId = randomUUID()
    job = { op: 'helper_accounts', requestedBy: 'owner', ...credentials, watcherPairingId: 9, ownerUserId: 'user_fixture', targets, accountCommand }
    await handleFrame(ctx, { op: job.op, rpcId })
    return rpcId
  }
  await send({ action: 'add', label: 'Reserve' })
  const [b] = (await ctx.accounts.snapshot()).accounts.map((x: any) => x.id)
  const first = await send({ action: 'assign', mode: 'now', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  assert.equal((await ctx.accounts.snapshot()).status, 'waiting_for_turn')
  const second = await send({ action: 'assign', mode: 'now', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  const snap = await ctx.accounts.snapshot()
  assert.deepEqual([snap.status, snap.statusRpcId], ['waiting_for_turn', first])
  assert.deepEqual(snap.refusedRpcIds, [second])
})

test('verify #9: the real watcher reads a stopped agent and saves the login for its next start, without a restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'account-stopped-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const write = (p: string, value: string) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, value)
  }
  const credentials = { machineId: 'machine12345', pairingId: 9, backendUrl: 'http://127.0.0.1:1' }
  const stateDir = join(home, '.bgos-agent', '11'),
    cwd = join(home, 'agent'),
    pin = randomUUID()
  const row: any = {
    assistantId: '11', stateDir, pluginStateDir: stateDir, cwd, sessionId: pin,
    credentialsPath: join(home, '.bgos-agent', 'credentials-11.json'),
    recipe: { claudeConfigDir: null, cwd, assistantId: '11' },
    launcherLive: false, keepaliveDeclared: false,
  }
  write(row.credentialsPath, JSON.stringify({ userId: 'user_fixture', assistantId: 11, pairingId: 19, backendUrl: credentials.backendUrl }))
  // The daemon's last word is an hour old: nothing runs this agent now.
  write(join(stateDir, 'agent-state.json'), JSON.stringify({
    schemaVersion: 1, assistantId: '11', pid: 101, updatedAt: new Date(Date.now() - 3600000).toISOString(), sessionId: pin,
    turnInFlight: true, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, turnSignal: 'hooks',
  }))
  let restarts = 0
  const watcher = createAccountWatcher({ home, credentials, now: () => Date.now(), env: {}, fs: nodeFs(), pidAlive: () => false, sleep: async () => {} }, {
    list: () => [row], probe: async () => true, eligible: async () => true,
    requestRestart: async () => { restarts++; return { ok: true } },
    verify: async () => ({ ok: true }),
  })
  const job = (accountCommand: any, targets: any[] = []) => watcher.run(randomUUID(), {
    op: 'helper_accounts', requestedBy: 'owner', ...credentials, watcherPairingId: 9, ownerUserId: 'user_fixture', targets, accountCommand,
  })
  await job({ action: 'add', label: 'Reserve' })
  const [b] = (await watcher.snapshot()).accounts.map((x: any) => x.id)
  await job({ action: 'assign', mode: 'now', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  assert.equal(restarts, 0)
  assert.equal((await watcher.snapshot()).agents[0].status, 'saved')
  const registry = JSON.parse(readFileSync(join(home, '.bgos-agent', 'helper-accounts', 'registry.json'), 'utf8'))
  assert.equal(registry.targets['11'].choice, b)
})

test('review #14: without the pinned transcript the watcher never asks for a restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'account-pin-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const write = (p: string, value: string) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, value)
  }
  const credentials = { machineId: 'machine12345', pairingId: 9, backendUrl: 'http://127.0.0.1:1' }
  const stateDir = join(home, '.bgos-agent', '11'),
    cwd = join(home, 'agent'),
    pin = randomUUID()
  const row: any = {
    assistantId: '11', stateDir, pluginStateDir: stateDir, cwd, sessionId: pin,
    credentialsPath: join(home, '.bgos-agent', 'credentials-11.json'),
    recipe: { claudeConfigDir: null, cwd, assistantId: '11' }, launcherLive: true,
  }
  write(row.credentialsPath, JSON.stringify({ userId: 'user_fixture', assistantId: 11, pairingId: 19, backendUrl: credentials.backendUrl }))
  write(join(stateDir, 'agent-state.json'), JSON.stringify({
    schemaVersion: 1, assistantId: '11', pid: 101, updatedAt: new Date().toISOString(), sessionId: pin,
    turnInFlight: false, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, turnSignal: 'hooks',
  }))
  // The pinned conversation's transcript is NOT on disk.
  let restarts = 0
  const watcher = createAccountWatcher({ home, credentials, now: () => Date.now(), env: {}, fs: nodeFs(), pidAlive: () => true, sleep: async () => {} }, {
    list: () => [row], probe: async () => true, eligible: async () => true,
    requestRestart: async () => { restarts++; return { ok: true } },
    verify: async () => ({ ok: true }),
  })
  const job = (accountCommand: any, targets: any[] = []) => watcher.run(randomUUID(), {
    op: 'helper_accounts', requestedBy: 'owner', ...credentials, watcherPairingId: 9, ownerUserId: 'user_fixture', targets, accountCommand,
  })
  await job({ action: 'add', label: 'Reserve' })
  const [b] = (await watcher.snapshot()).accounts.map((x: any) => x.id)
  await job({ action: 'assign', mode: 'now', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  assert.equal(restarts, 0)
  assert.equal((await watcher.snapshot()).agents[0].status, 'failed')
})

/** A saved login's folder names its Claude account: a fake status read, never the CLI. */
const folderAccount = (env: any) => accountTokenFrom(JSON.stringify({ loggedIn: true, accountUuid: `acct-${String(env.CLAUDE_CONFIG_DIR ?? 'own').split(/[\\/]/).pop()}` }))

async function limitSwitchRig(t: any, probe: (env: any) => Promise<any>) {
  const home = mkdtempSync(join(tmpdir(), 'account-limit-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const write = (p: string, value: string) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, value)
  }
  const at = Date.now()
  const credentials = { machineId: 'machine12345', pairingId: 9, backendUrl: 'http://127.0.0.1:1' }
  const stateDir = join(home, '.bgos-agent', '11'),
    cwd = join(home, 'agent'),
    pin = randomUUID()
  const state = (pid: number, extra: object = {}) =>
    write(join(stateDir, 'agent-state.json'), JSON.stringify({
      schemaVersion: 1, assistantId: '11', pid, updatedAt: new Date(Date.now()).toISOString(), sessionId: pin,
      turnInFlight: false, pendingMessages: 0, pendingPermissions: 0, activeOperations: 0, turnSignal: 'hooks', ...extra,
    }))
  const row: any = {
    assistantId: '11', stateDir, pluginStateDir: stateDir, cwd, sessionId: pin,
    credentialsPath: join(home, '.bgos-agent', 'credentials-11.json'),
    recipe: { claudeConfigDir: null, cwd, assistantId: '11', startedAt: new Date(at - 3600000).toISOString() },
    launcherLive: true,
  }
  write(row.credentialsPath, JSON.stringify({ userId: 'user_fixture', assistantId: 11, pairingId: 19, backendUrl: credentials.backendUrl }))
  write(join(home, '.bgos-agent', 'watcher', 'credentials.json'), JSON.stringify(credentials))
  const calls = { eligible: 0, limitEligible: 0 }
  const watcher = createAccountWatcher({ home, credentials, now: () => Date.now(), env: {}, fs: nodeFs(), pidAlive: () => true, sleep: async () => {} }, {
    list: () => [row],
    probe,
    eligible: async () => { calls.eligible++; return false },
    limitEligible: async () => { calls.limitEligible++; return true },
    requestRestart: async () => {
      row.recipe = { ...row.recipe, claudeConfigDir: profileB }
      state(202)
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  })
  const job = (accountCommand: any, targets: any[] = []) => watcher.run(randomUUID(), {
    op: 'helper_accounts', requestedBy: 'owner', ...credentials, watcherPairingId: 9, ownerUserId: 'user_fixture', targets, accountCommand,
  })
  await job({ action: 'add', label: 'Studio' })
  await job({ action: 'add', label: 'Reserve' })
  const [a, b] = (await watcher.snapshot()).accounts.map((x: any) => x.id)
  const profileA = join(home, '.bgos-agent', 'helper-accounts', a)
  const profileB = join(home, '.bgos-agent', 'helper-accounts', b)
  row.recipe.claudeConfigDir = profileA
  // At its limit: the owner's message is still owed and the picker holds the turn flag.
  state(101, { turnInFlight: true, pendingMessages: 1 })
  const transcript = transcriptPathFor({ configDir: profileA, cwd, sessionId: pin })
  const iso = (ms: number) => new Date(ms).toISOString()
  write(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: iso(at - 600000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Earlier answer.' }] } }),
    JSON.stringify({ type: 'user', timestamp: iso(at - 120000), message: { role: 'user', content: '<channel chat_id="1" sender_type="user">next task</channel>' } }),
    JSON.stringify({ type: 'assistant', timestamp: iso(at - 60000), isApiErrorMessage: true, error: 'rate_limit',
      apiErrorParams: { rate_limit_info: { resetsAt: Math.floor((at + 3 * 3600000) / 1000) } },
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your Opus limit · resets 6pm (Asia/Dubai)" }] } }),
  ].join('\n') + '\n')
  return { job, watcher, a, b, calls, transcript, cwd, pin, profileB, iso, at }
}

test('the real watcher reads the agent limit line from its transcript and switches at the limit with the conversation', async (t) => {
  const { job, watcher, a, b, calls, transcript, cwd, pin, profileB, iso, at } = await limitSwitchRig(t, async (env) => ({ read: true, signedIn: true, account: folderAccount(env) }))
  await job({ action: 'assign', mode: 'limit', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  const snap = await watcher.snapshot()
  assert.deepEqual(snap.agents, [{ assistantId: 11, accountId: b, status: 'back_online' }])
  assert.deepEqual(snap.accounts.find((x: any) => x.id === a).limits, [{ model: 'opus', until: iso(Math.floor((at + 3 * 3600000) / 1000) * 1000) }])
  assert.deepEqual(calls, { eligible: 0, limitEligible: 1 })
  // The same conversation, linked into the new login before the restart.
  assert.equal(readFileSync(transcriptPathFor({ configDir: profileB, cwd, sessionId: pin }), 'utf8'), readFileSync(transcript, 'utf8'))
})

test('end to end on fakes, rule A: a saved login on the SAME Claude account is never switched to at the limit', async (t) => {
  const same = accountTokenFrom(JSON.stringify({ loggedIn: true, accountUuid: 'acct-same' }))
  const { job, watcher, a, b, calls } = await limitSwitchRig(t, async () => ({ read: true, signedIn: true, account: same }))
  await job({ action: 'assign', mode: 'limit', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  await watcher.tick()
  const snap = await watcher.snapshot()
  assert.deepEqual(snap.agents, [{ assistantId: 11, accountId: a, status: 'waiting_for_room', rule: { mode: 'limit', accountId: b } }])
  assert.deepEqual(calls, { eligible: 0, limitEligible: 0 }, 'nothing is even checked for a restart')
})

test('end to end on fakes, rule C: a status read that times out at the limit switches nothing and keeps the rule', async (t) => {
  let timedOut = true
  const { job, watcher, a, b, calls } = await limitSwitchRig(t, async (env) => (timedOut ? { read: false } : { read: true, signedIn: true, account: folderAccount(env) }))
  await job({ action: 'assign', mode: 'limit', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  await watcher.tick()
  assert.deepEqual((await watcher.snapshot()).agents, [{ assistantId: 11, accountId: a, status: 'waiting_for_room', rule: { mode: 'limit', accountId: b } }])
  assert.deepEqual(calls, { eligible: 0, limitEligible: 0 })
  timedOut = false
  await watcher.tick()
  assert.deepEqual((await watcher.snapshot()).agents, [{ assistantId: 11, accountId: b, status: 'back_online' }])
})

test('end to end on fakes, rule C: only the target login times out (the limited one reads fine): the rule waits, never needs_sign_in', async (t) => {
  let timedOut = true
  let target = ''
  const { job, watcher, a, b, calls } = await limitSwitchRig(t, async (env) =>
    timedOut && target && String(env.CLAUDE_CONFIG_DIR ?? '').includes(target) ? { read: false } : { read: true, signedIn: true, account: folderAccount(env) },
  )
  target = b
  await job({ action: 'assign', mode: 'limit', accountId: b, assistantId: 11 }, [{ assistantId: 11, pairingId: 19 }])
  await watcher.tick()
  assert.deepEqual((await watcher.snapshot()).agents, [{ assistantId: 11, accountId: a, status: 'waiting_for_room', rule: { mode: 'limit', accountId: b } }])
  assert.deepEqual(calls, { eligible: 0, limitEligible: 0 })
  timedOut = false
  await watcher.tick()
  assert.deepEqual((await watcher.snapshot()).agents, [{ assistantId: 11, accountId: b, status: 'back_online' }])
})
