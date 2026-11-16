// A local MCP child for the real launcher/CLI integration test.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const load = (path) => import(pathToFileURL(join(config.libraryRoot, path)).href)
const { supervisorEnv } = await load('lib/lane-owner.ts')
const server = new Server({ name: 'bgos', version: '0.0.0' }, { capabilities: { tools: {}, experimental: { 'claude/channel': {} } } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
let started = false
server.oninitialized = () => {
  if (started) return
  started = true
  const source = { ...process.env }
  // These are only the local API fence. The dedicated config scenario keeps
  // them to verify that production supports non-login configuration.
  if (config.hideOwnerConfig) { delete source.CLAUDE_CONFIG_DIR; delete source.ANTHROPIC_BASE_URL }
  const env = supervisorEnv(source, `${config.local}/api/v1`)
  writeFileSync(config.daemonFile, JSON.stringify({ pid: process.pid, agentPid: process.ppid, oauthVisible: !!process.env.CLAUDE_CODE_OAUTH_TOKEN, proof: env.HOAI_LANE_SHELL_CONTEXT, unknownVisible: Object.values(env).includes('made-up-unknown-owner') }))
  // A separate command process starts with exactly the production builder's
  // output. Its original OS environment is part of what this test measures.
  const child = spawn(process.execPath, ['--import', config.tsx, new URL('./lane-context-run.mjs', import.meta.url).pathname, process.argv[2]], { env, stdio: 'ignore' })
  child.on('error', (err) => writeFileSync(config.resultFile, JSON.stringify({ error: String(err) })))
}
await server.connect(new StdioServerTransport())
