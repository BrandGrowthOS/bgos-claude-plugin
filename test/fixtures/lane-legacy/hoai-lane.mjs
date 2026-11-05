// A process that loads the frozen supervisor before the current owner sweeps it.
// Children are inert EventEmitters. No CLI, credentials or server is executed.
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareToolPolicy } from './lane-policy.mjs'
import { lanePaths, laneStateBody } from './lane-core.mjs'
import { superviseLane } from './lane-supervisor.mjs'

const home = process.argv[2]
const paths = lanePaths({ home, assistantId: '1076', userId: 'user_ana' })
mkdirSync(paths.peopleDir, { recursive: true })
writeFileSync(paths.loginModesPath, JSON.stringify({ modes: { user_ana: 'own_token' } }))
let policy = { v: 1 }
let time = Date.parse('2026-10-18T10:00:00Z')
let launches = 0
let comparison = null
process.on('message', (message) => {
  if (message !== 'grant-and-idle') return
  policy = { v: 1, ownerMcpServers: true }
  comparison = compareToolPolicy(JSON.parse(readFileSync(paths.launchPolicyPath, 'utf8')).policy, policy)
  if (comparison === 'looser') {
    writeFileSync(paths.restartRequestPath, JSON.stringify({ when: 'idle', reasons: ['policy_loosened'], fresh: false }))
  }
  writeFileSync(paths.laneJsonPath, JSON.stringify(laneStateBody({ userId: 'user_ana', assistantId: '1076', lastActivityAtMs: time - 60_001, inFlight: false })))
})
const result = await superviseLane({
  assistantId: '1076', userId: 'user_ana', home,
  ownerEnv: { HOME: home, PATH: '/usr/bin:/bin' },
  backendUrl: 'http://127.0.0.1:9/api/v1',
  pluginRoot: '/fixture-plugin', nodePath: process.execPath, claudePath: '/fixture-claude',
  selfPid: process.pid, isAlive: (pid) => pid === process.pid,
  availableBytes: () => 64 * 1024 ** 3,
  tokenStore: { read: () => ({ ok: true, token: 'made-up-lane-token' }) },
  now: () => time,
  sleep: async (ms) => { time += ms; await new Promise((resolve) => setTimeout(resolve, 5)) },
  watchMs: 5_000, stopGraceMs: 10_000, gateBlock: '# fixture gate',
  generateId: () => '11111111-2222-4333-8444-555555555555',
  launchFacts: async () => ({ policy, read: true }),
  readClaudeJson: () => ({ mcpServers: { fixture_server: { command: 'inert-fixture-command' } } }),
  spawnExpect: () => {
    launches += 1
    const child = new EventEmitter()
    child.pid = 7000 + launches
    child.kill = () => { setImmediate(() => child.emit('exit', 143)); return true }
    if (launches === 1) process.send({ kind: 'ready', launch: JSON.parse(readFileSync(paths.launchPolicyPath, 'utf8')) })
    else writeFileSync(paths.stopRequestPath, JSON.stringify({ reason: 'fixture_done' }))
    return child
  },
  runNotice: async () => 0,
})
process.send({ kind: 'done', result, launches, comparison, servers: Object.keys(JSON.parse(readFileSync(paths.mcpPath, 'utf8')).mcpServers) }, () => process.disconnect())
