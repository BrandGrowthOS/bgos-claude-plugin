/**
 * Source guard: changes_rpc is wired into server.ts the way its tests assume
 * (HOAI P7 stage 3, C-31). The memory-wiring.test.ts pattern.
 *
 * lib/git-changes.ts and lib/changes-rpc.ts are tested on their own; what they
 * cannot see is how server.ts hands them the world. Four of those hand offs
 * would ship GREEN and wrong:
 *
 * 1. The lane. The answers must go to integrations/changes-rpc/:rpcId/ack and
 *    /result. A copy of the memory_rpc block posting to memory-rpc would have
 *    the backend drop every answer as "late/unknown" and the owner's Changes
 *    panel would say the agent is asleep.
 * 2. The folder. The agent folder is LAUNCH_CWD, under its own name
 *    CHANGES_WORKDIR so the counted identity literal `cwd: LAUNCH_CWD` stays at
 *    six (test/agent-credentials.test.ts). process.cwd() is the plugin cache
 *    on a marketplace install: a panel built from it shows the plugin's own
 *    repository while every test stays green.
 * 3. The home check, wired from the binding, the whole line.
 * 4. The drain. A daemon draining for an update must not act on a frame it is
 *    about to hand to its successor, like every neighbouring handler.
 *
 * Read through an import.meta.url URL and normalised from CRLF to LF first, so
 * the assertions describe the code and not the checkout.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const REGISTRATION = "realtimeSocket.on('changes_rpc', whenArmed('changes_rpc',"
const MEMORY_REGISTRATION = "realtimeSocket.on('memory_rpc', whenArmed('memory_rpc',"

/** The changes_rpc socket handler, from its registration to the next registration. */
function handlerSlice(): string {
  const at = server.indexOf(REGISTRATION)
  assert.ok(at > 0, 'changes_rpc is not registered')
  const next = server.indexOf('realtimeSocket.on(', at + REGISTRATION.length)
  return server.slice(at, next > at ? next : at + 1200)
}

/** The ChangesRpcHandler construction, from `new ChangesRpcHandler(` to its closing `})`. */
function constructionSlice(): string {
  const at = server.indexOf('new ChangesRpcHandler(')
  assert.ok(at > 0, 'server.ts never constructs a ChangesRpcHandler')
  const end = server.indexOf('\n})\n', at)
  assert.ok(end > at, 'the ChangesRpcHandler construction is not closed at the top level')
  return server.slice(at, end)
}

test('the handler answers on the changes lane', () => {
  const built = constructionSlice()
  assert.match(built, /bgosPost\(`integrations\/changes-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/ack`/)
  assert.match(built, /bgosPost\(\s*`integrations\/changes-rpc\/\$\{encodeURIComponent\(rpcId\)\}\/result`/)
  assert.doesNotMatch(built, /memory-rpc|voice-rpc|export-pack/)
  const handler = handlerSlice()
  assert.ok(handler.includes('normalizeChangesRpc('), 'the frame is normalised before it is handled')
  assert.ok(
    handler.includes('trackMessageOperation(() => changesRpc.handle(frame))'),
    'the frame is handed to the handler as a tracked operation',
  )
})

test('the folder is the launch folder under its own name, never the process folder', () => {
  assert.match(server, /\nconst CHANGES_WORKDIR = LAUNCH_CWD\n/, 'the folder is the launch folder, named for this lane')
  const built = constructionSlice()
  assert.match(built, /\n\s*workdir: \(\) => CHANGES_WORKDIR,\n/)
  assert.ok(!built.includes('process.cwd()'), 'process.cwd() is the plugin cache on a marketplace install')
  assert.ok(!built.includes('cwd: LAUNCH_CWD'), 'the counted identity literal stays at six')
  // The collector runs real Git through the node adapter, over the real file system.
  assert.ok(built.includes('collectChanges('), 'the handler reads through the collector')
  assert.ok(built.includes('createNodeRunGit('), 'Git runs through the stream capped node adapter')
  assert.ok(built.includes('nodeChangesFs'), 'the untracked files are read from disk')
  // Nothing is read before the home folder is confirmed. The WHOLE wired line,
  // anchored: a substring check would stay green with the predicate inverted,
  // and the handler tests inject their own predicate.
  assert.match(
    built,
    /\n\s*homeConfirmed: \(\) => HOME_CONFIRMED,\n/,
    'home check is exactly the boot home check',
  )
  // And that check is the lib's, over this daemon's own binding (fc75c7c3:
  // an elimination start with no home to check against has not passed it).
  assert.match(server, /\nconst HOME_CONFIRMED = homeCheckPassed\(HOME_BINDING\)\n/)
  assert.match(built, /\n\s*assistantId: \(\) => String\(ASSISTANT_ID \?\? ''\),\n/, 'the agent is this daemon own')
})

test('a draining daemon takes no changes frame', () => {
  const head = handlerSlice().slice(0, 220)
  assert.ok(head.includes('if (updateDrainMode) return'), 'the changes_rpc handler must open with the drain guard, like its neighbours')
})

test('it is registered right after memory_rpc', () => {
  const memory = server.indexOf(MEMORY_REGISTRATION)
  const changes = server.indexOf(REGISTRATION)
  assert.ok(memory > 0, 'memory_rpc is registered')
  assert.ok(changes > memory, 'changes_rpc comes after memory_rpc')
  const between = server.slice(memory, changes)
  assert.equal((between.match(/realtimeSocket\.on\(/g) ?? []).length, 1, 'nothing is registered between the two')
})
