/**
 * Source guard: memory_rpc is wired into server.ts the way its tests assume
 * (HOAI P7 stage 2, C-39).
 *
 * lib/memory.ts and lib/memory-rpc.ts are tested on their own; what they cannot
 * see is how server.ts hands them the world. Three of those hand offs would
 * ship GREEN and wrong:
 *
 * 1. The lane. The answers must go to integrations/memory-rpc/:rpcId/ack and
 *    /result. A copy of the voice_rpc block posting to voice-rpc would have
 *    the backend drop every answer as "late/unknown" and the owner's Memory
 *    screen would time out.
 * 2. The folder. The agent folder is LAUNCH_CWD and the config dir is
 *    CLAUDE_CONFIG_DIR. process.cwd() is the plugin cache on a marketplace
 *    install, so a handler built from it edits a folder no agent reads while
 *    every test stays green. The home check is wired from the binding.
 * 3. The drain. A daemon draining for an update must not act on a frame it is
 *    about to hand to its successor, like every neighbouring handler.
 *
 * The repo idiom for a source scan: read through an import.meta.url URL and
 * normalise CRLF to LF first, so the assertions describe the code and not the
 * checkout.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const REGISTRATION = "realtimeSocket.on('memory_rpc', whenArmed('memory_rpc',"

/** The memory_rpc socket handler, from its registration to the next registration. */
function handlerSlice(): string {
  const at = server.indexOf(REGISTRATION)
  assert.ok(at > 0, 'memory_rpc is not registered')
  const next = server.indexOf('realtimeSocket.on(', at + REGISTRATION.length)
  return server.slice(at, next > at ? next : at + 1200)
}

/** The MemoryRpcHandler construction, from `new MemoryRpcHandler(` to its closing `})`. */
function constructionSlice(): string {
  const at = server.indexOf('new MemoryRpcHandler(')
  assert.ok(at > 0, 'server.ts never constructs a MemoryRpcHandler')
  const end = server.indexOf('\n})\n', at)
  assert.ok(end > at, 'the MemoryRpcHandler construction is not closed at the top level')
  return server.slice(at, end)
}

test('the handler answers on the memory lane', () => {
  const built = constructionSlice()
  assert.match(built, /bgosPost\(`integrations\/memory-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/ack`/)
  assert.match(built, /bgosPost\(\s*`integrations\/memory-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`/)
  assert.doesNotMatch(built, /voice-rpc|export-pack/)
  const handler = handlerSlice()
  assert.ok(handler.includes('normalizeMemoryRpc('), 'the frame is normalised before it is handled')
  assert.ok(
    handler.includes('trackMessageOperation(() => memoryRpc.handle(frame))'),
    'the frame is handed to the handler as a tracked operation',
  )
})

test('the memory folder is found from the launch folder and the config dir, never the process folder', () => {
  const built = constructionSlice()
  assert.ok(built.includes('LAUNCH_CWD'), 'the agent folder is the launch folder')
  assert.ok(built.includes('CLAUDE_CONFIG_DIR'), 'the config dir is the one the daemon resolved')
  assert.ok(!built.includes('process.cwd()'), 'process.cwd() is the plugin cache on a marketplace install')
  assert.ok(!built.includes("'.claude'"), 'the config dir is never a hardcoded ~/.claude')
  // The trash lives in this agent's plugin state folder, outside the memory folder.
  assert.match(built, /pluginStateDirFor\(/)
  assert.ok(built.includes("'memory-trash'"))
  // Nothing is read or written before the home folder is confirmed. The WHOLE
  // wired line, anchored (review fix P8): a substring check stayed green with
  // the predicate inverted (`|| !homeDirRecorded`) or a `|| true` tail, and the
  // handler tests inject their own predicate, so this is the only guard on it.
  assert.match(
    built,
    /\n\s*homeConfirmed: \(\) => HOME_BINDING\.action === 'allow' \|\| homeDirRecorded,\n/,
    'home check is exactly: allow, or recorded',
  )
  assert.ok(built.includes('ASSISTANT_ID'))
})

test('a draining daemon takes no memory frame', () => {
  const head = handlerSlice().slice(0, 220)
  assert.ok(head.includes('if (updateDrainMode) return'), "the memory_rpc handler must open with the drain guard, like its neighbours")
})
