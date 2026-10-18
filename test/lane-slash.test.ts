/**
 * PERSON LANES, the commands of a person's lane (shared agents Phase 3, P5;
 * design section 6; lib/lane-slash.ts, lib/lane-controls.ts, lane-server.ts).
 *
 *   - `/new`, `/model x` and `/effort x` are performed by the lane daemon,
 *     never handed to the model: `/new` asks for a restart on a FRESH pin
 *     (the memory folder is not touched) and tells the person; `/model x`
 *     only for a model on the owner's list (K7), else nothing changes and
 *     the person is told.
 *   - Every other command resolves against the LANE catalog only: the
 *     owner's `~/.claude/commands` are never read for a lane, so a name only
 *     the owner has is answered as unavailable, with no body.
 *   - The `/memory`, `/model`, `/permissions` and `/hooks` built ins are
 *     reworded for a lane: none tells the model to read or edit a settings
 *     file, a CLAUDE.md or the owner's project.
 *   - The command events a lane hands the model keep every meta value a
 *     string (the wake card contract) and the lane stamp.
 *
 * Run with: npx tsx --test test/lane-slash.test.ts
 */
import { test as nodeTest } from 'node:test'

// Lanes are not offered on Windows (lib/lane-cli-probe.mjs refuses win32), and the
// command tests write 0600 files in a scratch lane, so the file is skipped there.
const SKIP_ON_WINDOWS = process.platform === 'win32' ? 'lanes are not offered on Windows' : false
const test = (name: string, fn: () => unknown) => nodeTest(name, { skip: SKIP_ON_WINDOWS }, fn as never)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lanePaths } from '../lib/lane-core.mjs'
import { readLaneChoices, readLaneRestartRequest } from '../lib/lane-policy.mjs'
import { laneChoiceQuestionFor, performLaneCommand, requestLaneRestart, type RestartAsk } from '../lib/lane-controls.ts'
import { buildLaneCommandEvent, inboxForNewConversation, inboxNoteHandled, inboxPollFrom, normaliseLaneDelivery, readLaneInbox } from '../lib/lane-daemon.ts'
import { LANE_COMMAND_REGISTRY, LANE_COMMANDS, routeLaneSlash } from '../lib/lane-slash.ts'
import { BUILTIN_COMMANDS } from '../lib/slash-catalog.ts'

const ROOT = join(import.meta.dirname, '..')
const LANE = { userId: 'user_ana', assistantId: '1076' }

function slash(commandName: string, commandArgs = '', text = `/${commandName}${commandArgs ? ` ${commandArgs}` : ''}`) {
  return { messageType: 'slash_command', commandName, commandArgs, text }
}

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'lane-slash-'))
  const paths = lanePaths({ home, assistantId: '1076', userId: 'user_ana' })
  mkdirSync(paths.memoryDir, { recursive: true })
  mkdirSync(paths.peopleDir, { recursive: true })
  const notices: Array<{ name: string; chatIds: string[] }> = []
  const restarts: RestartAsk[] = []
  const deps = {
    paths,
    notice: (name: string, chatIds: string[]) => notices.push({ name, chatIds }),
    requestRestart: (next: RestartAsk) => { restarts.push(next); requestLaneRestart(paths.restartRequestPath, next) },
    log: () => {},
  }
  return { home, paths, notices, restarts, deps, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('/new, /model x and /effort x are the daemon\'s; /model and /effort alone are a question', () => {
  assert.deepEqual(routeLaneSlash(slash('new')), { kind: 'new', commandArgs: '' })
  assert.deepEqual(routeLaneSlash(slash('model', 'sonnet')), { kind: 'model', commandArgs: 'sonnet' })
  assert.deepEqual(routeLaneSlash(slash('effort', 'high')), { kind: 'effort', commandArgs: 'high' })
  assert.deepEqual(routeLaneSlash(slash('model')), { kind: 'model', commandArgs: '' })
  // Typed as plain text (the picker shows the owner's catalog, which has no /new).
  assert.deepEqual(routeLaneSlash({ text: '/new' }), { kind: 'new', commandArgs: '' })
  assert.deepEqual(routeLaneSlash({ text: '  /model opus ' }), { kind: 'model', commandArgs: 'opus' })
  assert.deepEqual(routeLaneSlash({ text: 'please /new' }), { kind: 'not_slash' })
  assert.deepEqual(routeLaneSlash({ text: '/help' }), { kind: 'not_slash' }, 'plain text other than the three is a turn')
  assert.deepEqual(routeLaneSlash({ text: 'hello' }), { kind: 'not_slash' })
})

test('the owner\'s commands never reach a lane: a name only the owner has is unavailable, with no body', () => {
  const route = routeLaneSlash(slash('deploy-prod', 'now'))
  assert.equal(route.kind, 'directive')
  if (route.kind !== 'directive') return
  assert.equal(route.delivery.registeredCommand, null)
  assert.match(route.delivery.content, /No matching command is registered/)
  assert.doesNotMatch(route.delivery.content, /registered_command_instructions/)
  for (const owner of ['init', 'mcp', 'agents', 'doctor', 'plan', 'compact', 'login', 'status']) {
    const r = routeLaneSlash(slash(owner))
    assert.equal(r.kind === 'directive' && r.delivery.registeredCommand, null, `/${owner} is not a lane command`)
  }
})

test('lane-server.ts never reads a command folder, never builds the owner\'s catalog', () => {
  const source = readFileSync(join(ROOT, 'lane-server.ts'), 'utf8')
  for (const forbidden of ['walkCommandsDir', 'discoverSlashCommands', 'walkPluginCommands', "'commands'", 'catalogForCapabilities', 'mergeSlashCommandCatalog', 'BUILTIN_COMMANDS', 'routeSlashCommand(']) {
    assert.ok(!source.includes(forbidden), `lane-server.ts must not use ${forbidden}`)
  }
  assert.ok(source.includes('routeLaneSlash('), 'every lane delivery is routed by the lane catalog')
  const lib = readFileSync(join(ROOT, 'lib', 'lane-slash.ts'), 'utf8')
  assert.ok(!/readdir|readFile|homedir|\.claude/.test(lib.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'the lane catalog reads no file')
})

test('the built ins that pointed at the owner\'s files are reworded for a lane', () => {
  const owner = new Map(BUILTIN_COMMANDS.map((c) => [c.command, c.prompt ?? '']))
  for (const name of ['/memory', '/permissions', '/hooks']) {
    const lane = LANE_COMMANDS.find((c) => c.command === name)
    assert.ok(lane?.prompt, `${name} is in the lane catalog`)
    assert.notEqual(lane!.prompt, owner.get(name), `${name} is reworded`)
    assert.doesNotMatch(lane!.prompt!, /\.claude\/settings|settings\.local\.json|CLAUDE\.md in the working directory|\.claude\/rules/, `${name} names no owner file to read`)
    assert.match(lane!.prompt!, /(do not read or edit any settings file|no CLAUDE\.md or settings file)/i)
  }
  assert.equal(LANE_COMMANDS.find((c) => c.command === '/model')?.prompt, undefined, '/model is the daemon\'s, not a prompt that edits a launcher file')
  assert.deepEqual([...LANE_COMMAND_REGISTRY.keys()], ['help', 'new', 'memory', 'model', 'effort', 'permissions', 'hooks'])
  const memory = routeLaneSlash(slash('memory'))
  assert.equal(memory.kind, 'directive')
  if (memory.kind === 'directive') assert.match(memory.delivery.content, /memory folder your instructions for this lane name/)
})

test('/help lists the lane catalog, not the owner\'s', () => {
  const help = routeLaneSlash(slash('help'))
  assert.equal(help.kind, 'directive')
  if (help.kind !== 'directive') return
  assert.match(help.delivery.content, /\/new - Start a new conversation with me/)
  assert.doesNotMatch(help.delivery.content, /\/init|\/doctor|\/agents/)
})

test('/new: a restart NOW on a FRESH pin, the memory folder untouched, and the person told', () => {
  const s = scratch()
  try {
    writeFileSync(join(s.paths.memoryDir, 'MEMORY.md'), '- [Fact](fact.md) - kept\n')
    assert.equal(performLaneCommand({ kind: 'new', commandArgs: '' }, '5', s.deps), 'new_session')
    assert.deepEqual(s.notices, [{ name: 'new_session', chatIds: ['5'] }])
    assert.deepEqual(readLaneRestartRequest(readFileSync(s.paths.restartRequestPath, 'utf8')), { reasons: ['new'], when: 'now', fresh: true, chatId: '5' })
    assert.equal(readFileSync(join(s.paths.memoryDir, 'MEMORY.md'), 'utf8'), '- [Fact](fact.md) - kept\n')
  } finally {
    s.cleanup()
  }
})

test('/model: only a model on the owner\'s list, recorded and restarted onto; off the list nothing changes', () => {
  const s = scratch()
  try {
    // No list: only the agent's own default.
    assert.equal(performLaneCommand({ kind: 'model', commandArgs: 'opus' }, '5', s.deps), 'refused')
    assert.deepEqual(s.notices.at(-1), { name: 'choice_refused', chatIds: ['5'] })
    assert.equal(existsSync(s.paths.choicesPath), false)
    assert.equal(s.restarts.length, 0)
    writeFileSync(s.paths.allowedChoicesPath, JSON.stringify({ models: ['sonnet', 'opus'], efforts: ['low', 'high'] }))
    assert.equal(performLaneCommand({ kind: 'model', commandArgs: 'haiku' }, '5', s.deps), 'refused')
    assert.equal(performLaneCommand({ kind: 'model', commandArgs: 'opus' }, '5', s.deps), 'changed')
    assert.deepEqual(readLaneChoices(readFileSync(s.paths.choicesPath, 'utf8')), { model: 'opus', effort: null, chatId: '5' })
    assert.deepEqual(s.restarts.at(-1), { reasons: ['model'], when: 'now', fresh: false, chatId: '5' })
    assert.deepEqual(s.notices.at(-1), { name: 'model_changed', chatIds: ['5'] })
    assert.equal(performLaneCommand({ kind: 'effort', commandArgs: 'high' }, '5', s.deps), 'changed')
    assert.deepEqual(readLaneChoices(readFileSync(s.paths.choicesPath, 'utf8')), { model: 'opus', effort: 'high', chatId: '5' })
    const before = s.restarts.length
    assert.equal(performLaneCommand({ kind: 'effort', commandArgs: 'high' }, '5', s.deps), 'unchanged', 'no restart for the same choice')
    assert.equal(s.restarts.length, before)
    assert.equal(performLaneCommand({ kind: 'model', commandArgs: 'default' }, '5', s.deps), 'changed')
    assert.deepEqual(readLaneChoices(readFileSync(s.paths.choicesPath, 'utf8')), { model: null, effort: 'high', chatId: '5' })
    assert.ok(!s.paths.choicesPath.startsWith(s.paths.workDir), 'the choice is out of the model\'s reach')
  } finally {
    s.cleanup()
  }
})

test('/model alone: a question carrying what this lane was launched with and the owner\'s list', () => {
  const s = scratch()
  try {
    writeFileSync(s.paths.allowedChoicesPath, JSON.stringify({ models: ['sonnet'], efforts: [] }))
    const env = { HOAI_LANE_LAUNCH_POLICY: '{"v":1}', HOAI_LANE_LAUNCH_MODEL: 'sonnet' }
    const q = laneChoiceQuestionFor('model', s.paths, env)
    assert.match(q.content, /You use the model "sonnet"/)
    assert.match(q.content, /allows these for this person: "sonnet"/)
    for (const v of Object.values(q.meta)) assert.equal(typeof v, 'string')
    assert.match(laneChoiceQuestionFor('effort', s.paths, env).content, /allows no other effort level/)
  } finally {
    s.cleanup()
  }
})

test('a handled command is remembered as delivered and never as waiting for a reply', () => {
  const state = readLaneInbox({ cursor: 3, delivered: [3], pending: [{ id: 3, chatId: '5' }] })
  const next = inboxNoteHandled(state, { messageId: 4 })
  assert.ok(next.delivered.includes(4))
  assert.deepEqual(next.pending, [{ id: 3, chatId: '5' }])
  assert.deepEqual(inboxNoteHandled(next, { messageId: 3 }).pending, [], 'a handled id is never pending')
})

test('/new: the old conversation\'s waiting turns are never re-offered into the new one (live run finding)', () => {
  const state = readLaneInbox({ cursor: 9, delivered: [1, 8, 9], pending: [{ id: 1, chatId: '5' }, { id: 8, chatId: '5' }, { id: 9, chatId: '5' }] })
  const fresh = inboxForNewConversation(inboxNoteHandled(state, { messageId: 10 }))
  assert.deepEqual(fresh.pending, [])
  assert.deepEqual(fresh.delivered, [1, 8, 9, 10], 'still delivered: none is handed over again')
  assert.equal(fresh.cursor, 9)
  assert.equal(inboxPollFrom(fresh), 9, 'the next poll starts past them')
  const source = readFileSync(join(ROOT, 'lane-server.ts'), 'utf8')
  const handled = source.slice(source.indexOf("if ((route.kind === 'new')"), source.indexOf('performLaneCommand('))
  assert.match(handled, /if \(route\.kind === 'new'\) \{[\s\S]*?inbox = inboxForNewConversation\(inbox\)[\s\S]*?inFlightChats\.clear\(\)[\s\S]*?\}\n\s*saveInbox\(\)/)
})

test('the wake card contract: a lane command event is all string, sparse or full, with the lane stamp', () => {
  const sparse = normaliseLaneDelivery({ id: 9, chat_id: 5, lane: 'person:user_ana', messageType: 'slash_command', commandName: 'memory' })!
  const route = routeLaneSlash(sparse.raw as Record<string, unknown>)
  assert.equal(route.kind, 'directive')
  if (route.kind !== 'directive') return
  for (const d of [sparse, normaliseLaneDelivery({ id: 10, chat_id: 5, lane: 'person:user_ana', sender_user_id: 'user_ana', created_at: '2026-10-18T00:00:00Z', senderType: 'user', text: '/memory', messageType: 'slash_command', commandName: 'memory', commandArgs: '' })!]) {
    const event = buildLaneCommandEvent(d, LANE, 'lane-socket', { content: route.delivery.content, meta: route.delivery.meta })
    for (const [key, value] of Object.entries(event.meta)) assert.equal(typeof value, 'string', `meta.${key} must be a string`)
    assert.equal(event.meta.lane, 'person:user_ana')
    assert.equal(event.meta.event_type, 'slash_command')
    assert.equal(event.meta.chat_id, '5')
    assert.equal(event.content, route.delivery.content)
  }
})
