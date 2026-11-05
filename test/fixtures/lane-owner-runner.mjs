// Local command-capable server for tests. Every path and input is made up.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
appendFileSync(process.argv[2], 'started\n')
const server = new Server({ name: 'runner', version: '0.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'run', description: 'Run a local test command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] }))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const text = execFileSync('/bin/sh', ['-c', String(params.arguments.command)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return { content: [{ type: 'text', text }] }
})
await server.connect(new StdioServerTransport())
