/**
 * server.ts wires the thread lanes and By the way (Threads phase 1) with real
 * dependencies: the session this daemon has proven, the folder its session
 * runs in, the agent's own state dir, the voice_rpc ops, a reconcile on every
 * (re)connect, the hourly sweep, and a stop of every lane on shutdown. A
 * source read, like the other wiring tests: server.ts boots a whole daemon.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')

function block(startMarker: string, endMarker: string): string {
  const start = server.indexOf(startMarker)
  assert.ok(start >= 0, `missing: ${startMarker}`)
  const end = server.indexOf(endMarker, start)
  assert.ok(end > start, `missing after it: ${endMarker}`)
  return server.slice(start, end)
}

test('the lane manager forks the proven session from the folder that session runs in', () => {
  const manager = block('const threadLanes = new ThreadLaneManager({', '\n})\n')
  assert.match(manager, /mainSessionId: \(\) => provenSessionId\(\),/)
  assert.match(manager, /agentFolder: CLAUDE_PROJECT_CWD,/)
  assert.match(manager, /configDir: CLAUDE_CONFIG_DIR,/)
  assert.match(manager, /stateDir: THREADS_STATE_DIR,/)
  assert.match(manager, /spawn: spawnStreamJson,/)
  assert.match(manager, /post: \(path, body\) => bgosPost\(path, body\),/)
  assert.match(server, /const THREADS_STATE_DIR = pathJoin\(agentStateDir\(homedir\(\), ASSISTANT_ID\)/)
})

test('the empty MCP config the lanes load names no server', () => {
  assert.match(block('function threadsEmptyMcpConfig(): string {', '\n}\n'), /writeFileSync\(path, '\{"mcpServers":\{\}\}\\n'\)/)
})

test('the voice_rpc handler gets the lanes, the aside runner from the same folder, and the progress route', () => {
  const rpc = block('const voiceRpc = new VoiceRpcHandler({', '\n})\n')
  assert.match(rpc, /turn: \(input\) => threadLanes\.turn\(input\),/)
  assert.match(rpc, /close: \(input\) => threadLanes\.close\(input\),/)
  assert.match(rpc, /runAside\(input, \{[\s\S]*mainSessionId: \(\) => provenSessionId\(\),[\s\S]*mainFolder: CLAUDE_PROJECT_CWD,/)
  assert.match(rpc, /bgosPost\(`integrations\/voice-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/progress`, body\)/)
})

test('every (re)connect reconciles the pending threads, on the lock holder only', () => {
  const connect = block("realtimeSocket.on('connect', () => {", '\n  })\n')
  assert.match(connect, /if \(channelArmed && threadsDeclared\(\)\) \{\n\s*void threadLanes\n\s*\.reconcile\(\(\) => bgosGet\('integrations\/threads\/pending'\)\)/)
})

test('closed thread worktrees are swept every hour', () => {
  assert.match(server, /void threadLanes\n\s*\.sweepClosed\(Date\.now\(\)\)[\s\S]{0,400}\}, 60 \* 60_000\)\.unref\(\)/)
})

test('a daemon shutdown stops every lane, on both exit paths', () => {
  const shutdown = block('const shutdown = (cause: ShutdownCause | string, code: number): void => {', 'process.exit(code)')
  assert.match(shutdown, /threadLanes\.stopAll\(\)/)
  const onExit = block("process.on('exit', () => {", '\n  })\n')
  assert.match(onExit, /threadLanes\.stopAll\(\)/)
})
