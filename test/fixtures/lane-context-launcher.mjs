import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { main, tclQuote } from '../../bin/hoai-core.mjs'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
// The real launcher's spawn path. Explicitly name the local MCP
// fixture so the CLI's scrubbed mode needs no project-server consent dialog.
const code = await main(['--new', '--force'], {
  spawnImpl: (file, args, options) => spawn(file, file === 'expect'
    ? args.map((arg) => arg.replace(/^spawn claude /m, `spawn claude {--strict-mcp-config} {--mcp-config} ${tclQuote(config.agentMcp)} `))
    : args, options),
})
process.exitCode = code
