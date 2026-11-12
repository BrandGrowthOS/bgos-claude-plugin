/**
 * A person's lane and the Agent Browser (shared agent vault, plugin 0.90.0;
 * BGOS plan 2026-11-13 section 9). The relay now admits a lane credential
 * (section 4.2), so the share's `browser` option is loaded, no longer only
 * recorded:
 *
 *   - browser on: the lane's settings allow exactly the browser tools the lane
 *     daemon serves under `bgos` (a fixed list, so a new host tool never
 *     widens a lane) and the two vault tools; nothing else of `bgos`;
 *   - browser off: none of them;
 *   - the browser tools are not built in tools and never reach a thread
 *     (laneAllowAdditions, which threads use, is unchanged);
 *   - a change of the option restarts the lane like any launch option:
 *     off is tighter, on is looser;
 *   - the system prompt says what the person's browser is.
 *
 * No em or en dashes in this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LANE_BUILTIN_TOOLS, lanePaths } from '../lib/lane-core.mjs'
import {
  compareToolPolicy,
  laneAllowAdditions,
  laneBrowserAllowAdditions,
  LANE_BROWSER_TOOL_NAMES,
  LANE_VAULT_TOOL_NAMES,
  laneToolsFor,
  LAUNCH_POLICY_OPTIONS,
  LOCKED_TOOL_POLICY,
} from '../lib/lane-policy.mjs'
import { prepareLaneLaunch } from '../lib/lane-supervisor.mjs'

const only = (option: string) => ({ ...LOCKED_TOOL_POLICY, [option]: true })

test('browser on allows exactly the lane browser tools and the two vault tools under bgos', () => {
  const rules = laneBrowserAllowAdditions(only('browser'))
  assert.deepEqual(rules, [...LANE_BROWSER_TOOL_NAMES, ...LANE_VAULT_TOOL_NAMES].map((name) => `mcp__bgos__${name}`))
  assert.deepEqual([...LANE_VAULT_TOOL_NAMES], ['vault_items', 'vault_fill'])
  for (const name of LANE_BROWSER_TOOL_NAMES) assert.match(name, /^(browser_|hoai_browser_)[a-z_]+$/)
  // A file on the owner's computer never leaves through a person's browser.
  for (const never of ['browser_file_upload', 'browser_drop', 'hoai_vault_fill', 'browser_evaluate', 'browser_run_code_unsafe']) {
    assert.equal(LANE_BROWSER_TOOL_NAMES.includes(never), false, never)
  }
  assert.deepEqual(laneBrowserAllowAdditions(LOCKED_TOOL_POLICY), [])
  assert.deepEqual(laneBrowserAllowAdditions({ ...LOCKED_TOOL_POLICY, webFetch: true, readAgentFolder: true }), [])
  assert.deepEqual(laneBrowserAllowAdditions({ v: 1, browser: 'true' }), [], 'only a literal true')
})

test('the browser adds no built in tool and nothing to the rules a thread takes', () => {
  assert.deepEqual(laneToolsFor(only('browser'), LANE_BUILTIN_TOOLS), [...LANE_BUILTIN_TOOLS])
  assert.deepEqual(laneAllowAdditions(only('browser'), { platform: 'darwin' }), [])
})

test('a change of the browser option restarts the lane: off is tighter, on is looser', () => {
  assert.ok(LAUNCH_POLICY_OPTIONS.includes('browser'))
  assert.equal(compareToolPolicy(LOCKED_TOOL_POLICY, only('browser')), 'looser')
  assert.equal(compareToolPolicy(only('browser'), LOCKED_TOOL_POLICY), 'tighter')
  assert.equal(compareToolPolicy(only('browser'), only('webFetch')), 'tighter')
  assert.equal(compareToolPolicy(only('browser'), only('browser')), 'same')
})

for (const browser of [true, false]) {
  test(`the launch writes the browser rules and the prompt line only with browser ${browser ? 'on' : 'off'}`, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lane-bp-')))
    const paths = lanePaths({ home, assistantId: '1076', userId: 'user_test' })
    fs.mkdirSync(paths.workDir, { recursive: true })
    try {
      const launch = await prepareLaneLaunch({
        o: { home, assistantId: '1076', userId: 'user_test', ownerEnv: {}, nodePath: process.execPath, pluginRoot: process.cwd() },
        fs, paths, platform: 'darwin', login: { mode: 'inherit', configDir: paths.configDir },
        launchFacts: async () => ({ policy: { v: 1, browser }, read: true }),
        log: () => {}, now: Date.now,
      } as never)
      assert.equal(launch.policy.browser, browser)
      const allow: string[] = JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')).permissions.allow
      const bgos = allow.filter((rule) => rule.startsWith('mcp__bgos__'))
      assert.deepEqual(bgos, browser ? ['mcp__bgos__reply', ...laneBrowserAllowAdditions(only('browser'))] : ['mcp__bgos__reply'])
      const env = JSON.parse(fs.readFileSync(paths.mcpPath, 'utf8')).mcpServers.bgos.env
      assert.equal(JSON.parse(env.HOAI_LANE_LAUNCH_POLICY).browser, browser, 'the lane daemon serves what this launch allows')
      const prompt = fs.readFileSync(paths.systemPromptPath, 'utf8')
      if (browser) assert.match(prompt, /own browser on this computer/)
      else assert.doesNotMatch(prompt, /browser/i)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
}
