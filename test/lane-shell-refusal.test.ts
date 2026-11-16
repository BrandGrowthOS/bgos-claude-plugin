import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { lanePaths, LANE_NOTICES } from '../lib/lane-core.mjs'
import { prepareLaneLaunch } from '../lib/lane-supervisor.mjs'
import { drainLaneEvents, supervisorEnv } from '../lib/lane-owner.ts'

const sentence = 'Running commands is not available for people you share with yet.'
const scenarios = [
  { name: 'no grant', env: {}, grant: false },
  { name: 'stored grant', env: {}, grant: true },
  { name: 'clean environment', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, grant: true },
  { name: 'daemon claiming eligibility', env: { HOAI_LANE_SHELL_CONTEXT: 'clean' }, grant: true },
  { name: 'owner login', env: { ANTHROPIC_API_KEY: 'made-up-owner-key' }, grant: true },
  { name: 'unknown input', env: { FUTURE_LOGIN: 'made-up-value' }, grant: true },
]

for (const scenario of scenarios) {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const mode of ['inherit', 'own_token']) {
      test(`shell refused: ${scenario.name}, ${platform}, ${mode}`, async () => {
        const home = fs.realpathSync(fs.mkdtempSync(join(process.cwd(), 'node_modules/lane-refusal-')))
        const paths = lanePaths({ home, assistantId: '1076', userId: 'user_test' })
        fs.mkdirSync(paths.workDir, { recursive: true })
        if (scenario.grant) {
          fs.mkdirSync(join(home, '.bgos-agent'), { recursive: true })
          fs.writeFileSync(join(home, '.bgos-agent/shell-host.json'), JSON.stringify({ v: 1, assistantId: '1076', userId: 'user_test', dedicatedAccount: true }))
        }
        const logs: string[] = []
        try {
          const launch = await prepareLaneLaunch({
            o: { home, assistantId: '1076', userId: 'user_test', ownerEnv: scenario.env, launchContext: 'clean', nodePath: process.execPath, pluginRoot: process.cwd(), shellSandboxAvailable: () => true },
            fs, paths, platform, login: { mode, configDir: paths.configDir },
            launchFacts: async () => ({ policy: { v: 1, shell: scenario.grant, ownerMcpServers: scenario.grant, webFetch: true }, read: true }),
            readClaudeJson: () => ({ mcpServers: { runner: { command: 'made-up-runner' } } }), log: (line: string) => logs.push(line), now: Date.now,
          } as never)
          assert.equal(launch.policy.shell, false)
          assert.equal(launch.shellRefused, scenario.grant ? 'unavailable' : null)
          assert.equal(launch.policy.ownerMcpServers, false)
          assert.equal(launch.ownerMcpRefused, scenario.grant ? 'unavailable' : null)
          assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(paths.mcpPath, 'utf8')).mcpServers), ['bgos'])
          assert.deepEqual(launch.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
          const settings = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8'))
          assert.equal(settings.permissions.allow.includes('Bash'), false)
          assert.equal('sandbox' in settings, false)
          assert.deepEqual(logs, scenario.grant ? [sentence, 'Your own tools are not available for people you share with yet.'] : [])
          assert.equal(JSON.parse(fs.readFileSync(paths.launchPolicyPath, 'utf8')).policy.shell, false)
          const mcp = JSON.parse(fs.readFileSync(paths.mcpPath, 'utf8')).mcpServers.bgos.env
          assert.equal(JSON.parse(mcp.HOAI_LANE_LAUNCH_POLICY).shell, false, 'the effective policy for heartbeat comparisons')
          assert.doesNotMatch(fs.readFileSync(paths.systemPromptPath, 'utf8'), /Run commands/)
        } finally { fs.rmSync(home, { recursive: true, force: true }) }
      })
    }
  }
}

for (const [notice, plain] of [['shell_refused', sentence], ['owner_mcp_refused', 'Your own tools are not available for people you share with yet.']]) {
test(`the owner and person receive the same plain ${notice} refusal`, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(process.cwd(), 'node_modules/lane-refusal-notice-')))
  const paths = lanePaths({ home, assistantId: '1076', userId: 'user_test' })
  fs.mkdirSync(paths.laneDir, { recursive: true })
  fs.writeFileSync(paths.eventsPath, JSON.stringify({ event: 'notice', notice, chatIds: [777] }) + '\n')
  const owners: string[] = [], people: string[] = []
  try {
    await drainLaneEvents({ home, assistantId: '1076', log: () => {} }, {
      report: async () => {}, notifyOwner: async (text) => { owners.push(text) },
      notify: async (_id, text) => { people.push(text) },
    })
    assert.equal(LANE_NOTICES[notice as keyof typeof LANE_NOTICES], plain)
    assert.deepEqual(owners, [plain])
    assert.deepEqual(people, [plain])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
}

test('supervisor allow list protects locked lanes and discards eligibility claims', () => {
  const env = supervisorEnv({ PATH: '/bin', LC_ALL: 'C', ANTHROPIC_API_KEY: 'made-up-inherit-key', CLAUDE_CONFIG_DIR: '/made-up-config', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', HOAI_LANE_SHELL_CONTEXT: 'clean', SOME_NEW_NAME: 'made-up', CLAUDE_CODE_SSE_ACCESS_TOKEN: 'made-up', CLAUDE_CODE_SSE_PORT: '1234', LC_NEW_LOGIN: 'made-up' }, 'http://127.0.0.1:9')
  assert.deepEqual(env, { PATH: '/bin', LC_ALL: 'C', ANTHROPIC_API_KEY: 'made-up-inherit-key', CLAUDE_CONFIG_DIR: '/made-up-config', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', BGOS_BACKEND_URL: 'http://127.0.0.1:9' })
})
