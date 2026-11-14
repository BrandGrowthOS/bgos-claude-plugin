/**
 * The source contract for the restart line in server.ts (board row b7276b5a). lib/restart-notice.mjs
 * has the rules (test/restart-notice.test.ts runs them); this pins how the daemon uses them:
 *   - it takes the notice ONCE, on its first arm as the pairing lock holder, on its own boot clock, and
 *     before the boot sweep can send the first card;
 *   - the line rides the next channel card at the one place every card passes (the mcp.notification
 *     wrapper), in its text only, the card rekeyed for the private turn tracker and the line put back
 *     when the card does not go out;
 *   - nothing is posted to chat.
 *
 * Run: npx tsx --test test/restart-notice.wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const NO_WIRING =
  'server.ts never reads restart-notice.json: a session the owner, the Helper or the watcher restarted ' +
  'resumes with nothing that says so, and answers "no" when asked if it was restarted (KC, 2026-11-13)'

const count = (needle: string) => server.split(needle).length - 1

test('server.ts takes the notice from lib/restart-notice.mjs', () => {
  assert.match(server, /from '\.\/lib\/restart-notice\.mjs'/, NO_WIRING)
  for (const name of ['takeRestartNotice', 'restartLine', 'createRestartLineSlot', 'applyRestartLine']) {
    assert.match(server, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./lib/restart-notice\\.mjs'`), `${name} is not imported`)
  }
})

test('the notice is taken once, by the first arm (the pairing lock holder), on the daemon\'s own boot clock, before the boot sweep', () => {
  assert.equal(count('takeRestartNotice({'), 1, `${NO_WIRING} (or it is taken in more than one place)`)
  const at = server.indexOf('takeRestartNotice({')
  const firstArm = server.indexOf('firstArmInFlight = true\n')
  const sweep = server.indexOf("await phase('boot poll sweep'")
  assert.ok(firstArm > 0 && sweep > firstArm, 'the first arm or its boot sweep moved')
  assert.ok(at > firstArm && at < sweep, 'taken on the first arm, before the boot sweep sends anything')
  const call = server.slice(at, server.indexOf('})', at))
  assert.match(call, /bootedAtMs: DAEMON_START_MS/)
  assert.match(call, /stateDir: restartNoticeDir/)
  assert.match(server, /const restartNoticeDir = agentStateDir\(homedir\(\), ASSISTANT_ID\)/, 'beside the agent state (~/.bgos-agent/<id>), where the watcher writes it')
  // The line goes into the slot and nowhere else: never a chat post.
  const block = server.slice(at, sweep)
  assert.match(block, /restartLineSlot\.set\(restartLine\(/)
  for (const post of ['bgosPost(', 'bgosPeerPost(', 'postConnectionNotice', 'sendMessage(']) {
    assert.equal(block.includes(post), false, `the restart line is never posted to chat (${post})`)
  }
})

test('the line rides the next channel card at the one wrapper every card passes, text only, rekeyed, and put back when the card fails', () => {
  assert.equal(count('applyRestartLine('), 1, 'one place adds the line')
  const wrapperAt = server.indexOf('mcp.notification = ((notification: Parameters<typeof mcp.notification>[0]) => {')
  assert.ok(wrapperAt > 0, 'the innermost mcp.notification wrapper moved')
  const wrapper = server.slice(wrapperAt, server.indexOf('}) as typeof mcp.notification', wrapperAt))
  const apply = wrapper.indexOf('applyRestartLine(')
  assert.ok(apply > 0, 'the line is added inside the wrapper')
  // After the group step (a swallowed card never takes it), inside the channel card branch, before
  // the private turn raw card tag and record (so they see the text that goes out).
  assert.ok(wrapper.indexOf('if (group?.swallow) return Promise.resolve()') < apply)
  const branch = wrapper.indexOf("if (notification?.method === 'notifications/claude/channel') {")
  assert.ok(branch > 0 && branch < apply)
  assert.ok(apply < wrapper.indexOf('privateTurns.tagRawCard('))
  assert.match(wrapper, /applyRestartLine\(params, restartLineSlot\)/)
  assert.match(wrapper, /privateTurns\.rekeyCard\(restart\.before, restart\.after\)/)
  assert.match(wrapper, /if \(restart\) sent\.catch\(restart\.restore\)/)
  assert.equal(count('const restartLineSlot = createRestartLineSlot()'), 1)
})
