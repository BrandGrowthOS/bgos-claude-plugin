/**
 * The binding of a sign in to the person who STARTED it (lib/auth-login.ts,
 * LoginState.starterUserId) rests on one fact about server.ts that no
 * behavioural test can reach: handleLoginCommand's `act` calls
 * `loginController.command(` as its synchronous first step.
 *
 * WHY. LoginController.command learns who is asking from
 * currentDaemonCommandVerdict (lib/daemon-command-sender.ts), and
 * runDaemonCommand makes that verdict readable ONLY while `act` runs
 * synchronously: it is set immediately before `act` is called and cleared the
 * moment `act` returns its promise (read the comment above
 * currentDaemonCommandVerdict). server.ts's act does not hand the verdict's
 * sender on yet, because server.ts is PR #262's until 0.72.0. So if that act
 * ever awaited something, chained a `.then`, queued a microtask or a timer, or
 * moved the call anywhere else before calling loginController.command, the
 * verdict would already be cleared when the controller reads it, and a
 * sign in a person the owner allowed had started would bind to the OWNER
 * (resolveStarter's fallback). That person's card would then name the
 * account the agent is signed in as, and their own code would be withheld.
 * A run with the owner looks exactly the same either way, which is why it is
 * pinned here, as text.
 *
 * What this cannot catch: anything that depends on runtime values, and a
 * controller that stopped reading the verdict before its own first await
 * (that half is behavioural: test/auth-login.test.ts drives the real seam
 * with an act that is server.ts's act exactly, and asserts the starter).
 *
 * WHEN THIS FAILS, the fix is not to loosen it. Keep the call as act's
 * synchronous first step, or, once server.ts is free to change, pass the
 * starter explicitly (`starter: verdict.sender`), which
 * LoginController.command already accepts and prefers. Then this pin and
 * currentDaemonCommandVerdict can go together.
 *
 * MUTATION PROOF (2026-10-20, each on a copy of server.ts in a scratch
 * folder, never on this checkout's server.ts): act turned into a block that
 * awaits `Promise.resolve()` before the call, and act turned into
 * `Promise.resolve().then(() => loginController.command(...))`: each turned
 * the first test red with WHY below (and the second, whose starting act was
 * gone). The second test runs those two mutations, and three more, on the
 * real source on every run, so the pin cannot quietly stop catching them.
 *
 * Run: npx tsx --test test/login-starter-binding.pin.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const WHY =
  "handleLoginCommand's act must call loginController.command( as its synchronous first step: LoginController.command " +
  'reads who started the sign in from currentDaemonCommandVerdict, which runDaemonCommand clears the moment act returns ' +
  'its promise (see the comment above currentDaemonCommandVerdict in lib/daemon-command-sender.ts). Deferred, a sign in ' +
  "a person the owner allowed started binds to the owner. To change act, pass `starter: verdict.sender` explicitly instead."

/** What is wrong with handleLoginCommand's act in this source text; empty when nothing is. */
function loginActProblems(src: string): string[] {
  const start = src.indexOf('async function handleLoginCommand(')
  if (start < 0) return ['server.ts has no handleLoginCommand']
  const end = src.indexOf('\n}\n', start)
  if (end < 0) return ['handleLoginCommand has no end']
  const body = src.slice(start, end)
  const problems: string[] = []
  const acts = body.match(/\bact:/g) ?? []
  if (acts.length !== 1) problems.push(`handleLoginCommand passes act ${acts.length} times, not once`)
  const actAt = start + Math.max(body.indexOf('act:'), 0)
  const act = src.slice(actAt, end)
  if (!/^act:\s*(?:async\s*)?\(verdict\)\s*=>\s*loginController\.command\(/.test(act)) {
    problems.push('act is not an arrow whose body IS the loginController.command( call')
  }
  const deferrals: Array<[RegExp, string]> = [
    [/\bawait\b/, 'an await'],
    [/\.then\s*\(/, 'a .then'],
    [/\b(?:setTimeout|setImmediate|queueMicrotask|nextTick)\b/, 'a timer or a microtask'],
    [/\byield\b/, 'a yield'],
  ]
  for (const [re, what] of deferrals) if (re.test(act)) problems.push(`act contains ${what}`)
  const calls = [...src.matchAll(/loginController\.command\(/g)].map((m) => m.index ?? -1)
  if (calls.length !== 1) problems.push(`loginController.command( appears ${calls.length} times in server.ts, not once`)
  else if (calls[0]! < actAt || calls[0]! > end) problems.push("the one loginController.command( call is not inside handleLoginCommand's act")
  return problems
}

test("handleLoginCommand's act calls loginController.command( as its synchronous first step (shape pin)", () => {
  assert.deepEqual(loginActProblems(SERVER), [], WHY)
})

test('the pin above turns red on every way of deferring the call, measured on the real source', () => {
  const ACT = 'act: (verdict) =>\n      loginController.command(chatId, commandArgs, {'
  assert.ok(SERVER.includes(ACT), "the mutations below start from the act as it stands; update them with it")
  const mutations: Array<[string, string]> = [
    ['an await before the call', SERVER.replace(ACT, 'act: async (verdict) => {\n      await Promise.resolve()\n      return loginController.command(chatId, commandArgs, {')],
    ['a .then before the call', SERVER.replace(ACT, 'act: (verdict) =>\n      Promise.resolve().then(() => loginController.command(chatId, commandArgs, {')],
    ['a microtask', SERVER.replace(ACT, 'act: (verdict) =>\n      queueMicrotask(() => loginController.command(chatId, commandArgs, {')],
    ['an await in its arguments', SERVER.replace(ACT, 'act: async (verdict) =>\n      loginController.command(chatId, await Promise.resolve(commandArgs), {')],
    [
      'the call moved out of act',
      `${SERVER.replace(ACT, 'act: (verdict) =>\n      startLoginLater(chatId, commandArgs, {')}\nfunction startLoginLater(chatId: string, commandArgs: string, opts: object): Promise<void> {\n  return Promise.resolve().then(() => loginController.command(chatId, commandArgs, opts))\n}\n`,
    ],
  ]
  for (const [label, mutated] of mutations) {
    assert.notEqual(mutated, SERVER, `${label}: the mutation applied`)
    assert.ok(loginActProblems(mutated).length > 0, `${label}: the pin must turn red`)
  }
})
