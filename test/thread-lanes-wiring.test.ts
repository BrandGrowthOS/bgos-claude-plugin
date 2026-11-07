/**
 * server.ts wires the thread lanes and By the way (Threads phase 1) with real
 * dependencies: the session this daemon has proven, the folder its session
 * runs in, the agent's own state dir, the voice_rpc ops, a reconcile on every
 * (re)connect and arm, the hourly sweep, and a bounded stop of every lane and
 * By the way fork on shutdown. A
 * source read, like the other wiring tests: server.ts boots a whole daemon.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8').replace(/\r\n/g, '\n')

function block(startMarker: string, endMarker: string): string {
  const start = server.indexOf(startMarker)
  assert.ok(start >= 0, `missing: ${startMarker}`)
  const end = server.indexOf(endMarker, start)
  assert.ok(end > start, `missing after it: ${endMarker}`)
  return server.slice(start, end)
}

/** Run the real startup function without booting the daemon or contacting its API. */
function reconcileStartup() {
  let resolveProbe: (answer: { ok: boolean }) => void = () => {}
  let answer: { ok: boolean } | null = null
  const probe = new Promise<{ ok: boolean }>((resolve) => { resolveProbe = resolve })
  const requests: Array<{ path: string; options: unknown; assistantIds: string[] }> = []
  const scope = {
    channelArmed: true,
    updateDrainMode: false,
    threadsDeclared: () => answer?.ok === true,
    threadsCliGate: { ready: () => probe },
    ASSISTANT_ID: 7,
    threadsPendingPath: (ids: string[]) => `integrations/threads/pending?assistantIds=${ids.join(',')}`,
    bgosGet: async (path: string, options: unknown) => ({ path, options }),
    threadLanes: {
      reconcile: async (fetch: () => Promise<{ path: string; options: unknown }>, options: { assistantIds: string[] }) => {
        requests.push({ ...await fetch(), assistantIds: options.assistantIds })
        return 1
      },
    },
    log: () => {},
  }
  const source = block('function reconcilePendingThreads(why: string): void {', '\n}\n') + '\n}'
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const reconcile = new Function('scope', `with (scope) { ${js}; return reconcilePendingThreads }`)(scope) as (why: string) => void
  return {
    scope, requests, reconcile,
    ready(ok: boolean) { answer = { ok }; resolveProbe(answer) },
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
  }
}

test('arming before the CLI probe finishes reconciles pending threads once the answer arrives', async () => {
  const r = reconcileStartup()
  r.reconcile('armed')
  assert.deepEqual(r.requests, [], 'the pending CLI does not start threads')
  r.ready(true)
  await r.settle()
  assert.deepEqual(r.requests, [{ path: 'integrations/threads/pending?assistantIds=7', options: { headers: { 'Cache-Control': 'no-cache' } }, assistantIds: ['7'] }])
})

test('a failed probe or a channel that lost its lock starts no pending threads', async () => {
  for (const ok of [false, true]) {
    const r = reconcileStartup()
    r.reconcile('armed')
    if (ok) r.scope.channelArmed = false
    r.ready(ok)
    await r.settle()
    assert.deepEqual(r.requests, [])
  }
})

test('a read of pending threads waits behind an update that drained first: nothing starts, and the reconnect reads again', async () => {
  const r = reconcileStartup()
  r.reconcile('armed')
  ;(r.scope as any).updateDrainMode = true
  r.ready(true)
  await r.settle()
  assert.deepEqual(r.requests, [])
})

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

test('pending threads are reconciled with the served agent ids and the server real answer, on connect AND when the channel arms', () => {
  const fn = block('function reconcilePendingThreads(why: string): void {', '\n}\n')
  assert.match(fn, /if \(!channelArmed\) return/)
  assert.match(fn, /const assistantIds = \[String\(ASSISTANT_ID\)\]/)
  assert.match(fn, /\.reconcile\(\(\) => bgosGet\(threadsPendingPath\(assistantIds\), \{ headers: \{ 'Cache-Control': 'no-cache' \} \}\), \{ assistantIds \}\)/)
  assert.doesNotMatch(server, /bgosGet\('integrations\/threads\/pending'\)/, 'never the call with no agent ids')
  const connect = block("realtimeSocket.on('connect', () => {", '\n  })\n')
  assert.match(connect, /reconcilePendingThreads\('ws connect'\)/)
  // Both arms: the first connect after a boot comes before channelArmed.
  assert.match(server, /handleUnboundBeforeArm\(\)\n\s*reconcilePendingThreads\('re-armed'\)/)
  assert.match(server, /handleUnboundBeforeArm\(\)\n\s*\/\/[^\n]*\n\s*reconcilePendingThreads\('armed'\)/)
})

test('a lane gets Bash only where the host has the CLI sandbox', () => {
  const manager = block('const threadLanes = new ThreadLaneManager({', '\n})\n')
  assert.match(manager, /shellSandbox: \(\) =>\s*laneShellSandboxAvailable\(/)
  // Gate review finding 4: Linux writes packed-only branches out loose, through git's own lock convention.
  assert.match(manager, /platform: process\.platform,/)
  // Follow up to finding 6: the agent's own email files stay readable, the plugin state follows its variable.
  assert.match(manager, /emailFilesDir: pathJoin\(EMAIL_FILES_ROOT, String\(ASSISTANT_ID\)\),/)
  assert.match(manager, /pluginStateDir: process\.env\.BGOS_PLUGIN_STATE_DIR\?\.trim\(\) \|\| undefined,/)
  // Gate review finding 3: a lane left from before a crash is found by pid and start stamp.
  assert.match(manager, /stamp: \(pid\) => processStamp\(pid\),/)
  assert.match(manager, /runsIn: \(pid, dir\) => processRunsIn\(pid, dir\),/)
  assert.match(manager, /kill: \(pid, signal\) => killProcessGroup\(pid, signal\),/)
  assert.match(manager, /createExclusive: \(path, data\) => writeFileSync\(path, data, \{ flag: 'wx' \}\),/)
  assert.match(manager, /rename: \(from, to\) => renameSync\(from, to\),/)
})

test('closed thread worktrees are swept every hour', () => {
  assert.match(server, /void threadLanes\n\s*\.sweepClosed\(Date\.now\(\)\)[\s\S]{0,400}\}, 60 \* 60_000\)\.unref\(\)/)
})

test('a daemon shutdown stops every lane and By the way fork with a bounded wait, on both exit paths', () => {
  const shutdown = block('const shutdown = (cause: ShutdownCause | string, code: number): void => {', "process.on('exit', () => {")
  assert.match(shutdown, /const threadChildrenDown = stopThreadChildren\(\)\n\s*if \(threadChildrenDown\) \{\n\s*void threadChildrenDown\.then\(\(\) => \{\n\s*browserHost\?\.stop\(\)\n\s*process\.exit\(code\)/)
  const stop = block('function stopThreadChildren(): Promise<void> | null {', '\n}\n')
  // Group lanes (lib/group-lanes.ts) stop with them.
  assert.match(stop, /if \(threadLanes\.liveChildren\(\) === 0 && groupLanes\.liveChildren\(\) === 0 && asideForks\.size\(\) === 0\) return null/)
  assert.match(stop, /Promise\.allSettled\(\[threadLanes\.stopAll\(\), groupLanes\.stopAll\(\), asideForks\.stopAll\(\)\]\)/)
  assert.match(stop, /threadLanes\.killAll\(\)\n\s*groupLanes\.killAll\(\)\n\s*asideForks\.killAll\(\)/)
  assert.match(server, /const THREAD_CHILDREN_STOP_WAIT_MS = 3_000/)
  const onExit = block("process.on('exit', () => {", '\n  })\n')
  assert.match(onExit, /threadLanes\.stopAll\(\)/)
  assert.match(onExit, /asideForks\.killAll\(\)/)
  const rpc = block('const voiceRpc = new VoiceRpcHandler({', '\n})\n')
  assert.match(rpc, /forks: asideForks,/)
})

test('threads are declared only where the claude lanes spawn passes the threads CLI probe, and a refusal names the real cause', () => {
  const declared = block('function threadsDeclared(): boolean {', '\n}\n')
  assert.match(declared, /process\.platform !== 'win32' && threadsCli\(\)\.ok/)
  // Follow up to finding 2: one background gate, never a probe on the event loop.
  assert.match(block('function threadsCli(): ThreadsCliAnswer {', '\n}\n'), /return threadsCliGate\.current\(\)/)
  const gate = block('const threadsCliGate = new ThreadsCliGate({', '\n})\n')
  assert.match(gate, /claudePath: \(\) => resolveClaude\(\),/)
  assert.match(gate, /'threads-cli-probe\.json'/)
  assert.match(server, /\n  void threadsCliGate\.ready\(\)\n/, 'started after the startup guard')
  assert.doesNotMatch(server, /threadsCliSupport\(|probeThreadsCli\(/, 'the blocking probe is never called')
  const manager = block('const threadLanes = new ThreadLaneManager({', '\n})\n')
  assert.match(manager, /cliProblem: async \(\) => threadsCliProblem\(await threadsCliGate\.ready\(\), 'turn'\),/)
  const rpc = block('const voiceRpc = new VoiceRpcHandler({', '\n})\n')
  assert.match(rpc, /cliProblem: async \(\) => threadsCliProblem\(await threadsCliGate\.ready\(\), 'aside'\),/)
})
