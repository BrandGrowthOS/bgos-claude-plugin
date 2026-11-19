import './helpers/real-os-sentinel.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAccountWatcher } from '../lib/helper-account-watcher.mjs'
import { handleFrame } from '../lib/watcher-core.mjs'
import { nodeFs } from '../lib/watcher-bundle.mjs'
import { applyHelperAccount } from '../lib/helper-account-launch.mjs'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'

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
