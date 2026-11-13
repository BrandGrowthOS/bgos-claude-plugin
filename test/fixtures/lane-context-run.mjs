import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { main } from '../../bin/hoai-lane.mjs'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const load = (path) => import(pathToFileURL(join(config.libraryRoot, path)).href)
const { superviseLane } = await load('lib/lane-supervisor.mjs')
const { lanePaths } = await load('lib/lane-core.mjs')
const paths = lanePaths({ home: config.home, assistantId: '1076', userId: 'user_made_up' })
const notices = []
try {
  await main(['run', '--assistant', '1076', '--lane', 'user_made_up'], {
    supervise: async (options) => {
      if (config.expectInherited && options.ownerEnv.ANTHROPIC_API_KEY !== 'made-up-owner-api') throw new Error('inherited input missing at command boundary')
      const result = await superviseLane({ ...options, pluginRoot: config.libraryRoot,
        tokenStore: { read: () => ({ ok: true, token: 'made-up-lane-oauth-token' }) },
        launchFacts: async () => ({ policy: { v: 1, shell: true }, read: true }),
        readClaudeJson: () => null, watchMs: 100, stopGraceMs: 500,
        runNotice: async ({ env }) => { notices.push(env.HOAI_LANE_NOTICE); return 0 },
        spawnExpect: (script, opts) => {
          writeFileSync(paths.mcpPath, '{"mcpServers":{}}')
          const command = script.replace('{--restricted}', '{Run the scripted lane check.} {--restricted}')
          return spawn('/usr/bin/expect', ['-c', command], { cwd: opts.cwd, env: { ...opts.env, ANTHROPIC_BASE_URL: config.local, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTPS_PROXY: config.local, NO_PROXY: '127.0.0.1' }, stdio: 'ignore' })
        },
      })
      const policy = JSON.parse(readFileSync(paths.launchPolicyPath, 'utf8'))
      writeFileSync(config.resultFile, JSON.stringify({ result, policy, notices, inheritedApiVisible: options.ownerEnv.ANTHROPIC_API_KEY === 'made-up-owner-api' }))
      return result
    },
  })
} catch (err) { writeFileSync(config.resultFile, JSON.stringify({ error: String(err), stack: err.stack })) }
