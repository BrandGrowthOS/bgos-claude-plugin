import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const sourceFiles = ['server.ts', 'lib/message-edits.ts', 'lib/poll-core.ts', 'lib/stream-apply.ts', 'test/message-edits.test.ts']
const originals = new Map(sourceFiles.map(path => [path, readFileSync(join(root, path), 'utf8')]))
const hash = value => createHash('sha256').update(value).digest('hex')
for (const [path, text] of originals) console.log(`${hash(text)}  ${path}`)
const messageDelete = ['server.ts', 'humanMessageEdits.deleteMessage(view.messageId)', 'void view.messageId']
const cases = [
  ['R1 replay', 'lib/message-edits.ts', 'const current = await reconcile?.(view)', 'const current = view', 'review R1: a replayed unversioned B'],
  ['R1 two trackers / legitimate revert', 'lib/message-edits.ts', 'const current = await reconcile?.(view)', 'const current = view', 'review R1: two trackers'],
  ['R1 stale poll', 'lib/message-edits.ts', 'const current = await reconcile?.(view)', 'const current = view', 'review R1: a stale unversioned poll'],
  ['R1 stable revision', 'lib/message-edits.ts', 'if (revision !== null && entry.revision !== null && revision < entry.revision) return false', 'if (false) return false', 'review R1: stable message revisions'],
  ['R2 socket barrier', 'server.ts', "if (transport !== 'poll' && !await waitForHumanEditCatchup(view.chatId)) return false", 'if (false) return false', 'review R2: a socket correction waits'],
  ['R2 poll ordering', 'lib/poll-core.ts', 'for (const row of pending) plan.push({ row, edit: true })\n  return plan', 'for (const row of pending) plan.push({ row, edit: true })\n  return plan.sort((a, b) => Number(b.edit) - Number(a.edit))', 'review R2: poll catch-up delivers B'],
  ['R3 message tombstone', ...messageDelete, 'review R3: a confirmed message deletion'],
  ['R3 chat tombstone', 'server.ts', 'humanMessageEdits.deleteChat(chatId)', 'void chatId', 'review R3: a deleted chat'],
  ['R3 pending original', ...messageDelete, 'review R3: deletion clears a pending edit'],
  ['R3 awaited read', ...messageDelete, 'review R3: deletion during an authoritative read'],
  ['R3 awaited edit transport', 'server.ts', 'if (humanMessageEdits.isDeleted(edited)) return', 'if (false) return', 'review R3: deletion during a transport handoff'],
  ['R3 legacy deletion', 'server.ts', "realtimeSocket.on('message_deleted',", "realtimeSocket.on('message_deleted_disabled',", 'review R3: a legacy socket deletion'],
  ['R3 awaited poll original', 'server.ts', 'log(`Failed to deliver inbound to Claude: ${err}`)\n      })\n      if (humanMessageEdits.isDeleted({ chatId, messageId: msg.message.id })) continue', 'log(`Failed to deliver inbound to Claude: ${err}`)\n      })', 'review R3: deleting during the original poll'],
  ['R3 awaited stream original', 'server.ts', 'await humanHandoff\n      if (humanMessageEdits.isDeleted(view)) return', 'await humanHandoff', 'review R3: deleting during the original stream'],
  ['R2 same-epoch periodic barrier', 'server.ts', 'if (pending?.size) await Promise.all([...pending])', 'if (false) await Promise.all([...pending])', 'review R2: an already-running periodic read'],
  ['R1 pending revision ordering', 'lib/message-edits.ts', 'if (revision >= pendingRevision) return view', 'if (false) return view', 'review R1: pending revisions cannot'],
  ['R1 pending revision carried', 'lib/message-edits.ts', '...(pendingRevision !== null ? { revision: pendingRevision } : {})', '...{}', 'review R1: pending revisions cannot'],
  ['R1 pre-read pending authority', 'lib/message-edits.ts', 'const current = await reconcile(view)', 'const current = this.latest(view)', 'review R1: a pending unversioned replay cannot'],
  ['R1 during-preparation authority', 'lib/message-edits.ts', 'const current = await reconcile(view)', 'const current = this.latest(view)', 'review R1: an unversioned replay received during'],
  ['R1 delayed socket original authority', 'lib/message-edits.ts', 'const current = await reconcile(view)', 'const current = this.latest(view)', 'review R1: pending unversioned replay is reconciled before'],
  ['Privacy edit guard', 'server.ts', "if (consumedAsLoginCode({\n      chatId: edited.chatId,", "if (false && consumedAsLoginCode({\n      chatId: edited.chatId,", 'review privacy: an edited sign-in code'],
  ['Privacy prepared poll guard', 'server.ts', 'if (latestPrepared.text !== text)', 'if (false)', 'review privacy: a pending sign-in code during poll'],
  ['Privacy prepared stream guard', 'server.ts', 'if (view.text !== textBeforePreparation)', 'if (false)', 'review privacy: a pending sign-in code during stream'],
  ['Privacy pending meeting guard', 'server.ts', "if (consumedAsLoginCode({\n          chatId,\n          messageId,\n          payload,\n          text,", "if (false && consumedAsLoginCode({\n          chatId,\n          messageId,\n          payload,\n          text,", 'review privacy: a pending meeting sign-in'],
  ['R3 deferred poll callback', 'server.ts', 'humanMessageEdits.isDeleted({ chatId, messageId: msg.message.id }) ? Promise.resolve() : mcp.notification', 'false ? Promise.resolve() : mcp.notification', 'review R3: a deferred poll callback'],
  ['R3 deferred stream callback', 'server.ts', 'humanMessageEdits.isDeleted(view) ? Promise.resolve() : mcp.notification', 'false ? Promise.resolve() : mcp.notification', 'review R3: a deferred stream callback'],
  ['R3 deferred socket callback', 'server.ts', 'humanMessageEdits.isDeleted({ chatId, messageId }) ? Promise.resolve() : mcp.notification', 'false ? Promise.resolve() : mcp.notification', 'review R3: a deferred socket callback'],
  ['R1 preserve stream source row', 'server.ts', 'const view = rawView\n  const chatId = view.chatId', 'const view = humanMessageEdits.latest(rawView) ?? rawView\n  const chatId = view.chatId', 'review R1: stream originals preserve the raw row'],
  ['R1 preserve polled source row', 'server.ts', 'humanMessageEdits.resolveOriginal(preparedView, readHumanEdit)', 'humanMessageEdits.resolveOriginal(humanMessageEdits.latest(preparedView), readHumanEdit)', 'review R1: a replay arriving during the poll fetch'],
  ['R1 pending body behind empty original', 'server.ts', "if (decision.action === 'advance_only' && decision.reason === 'empty_non_system' &&", "if (false && decision.action === 'advance_only' && decision.reason === 'empty_non_system' &&", 'review R1: an empty stale stream original'],
]
const cache = join(root, 'node_modules/.cache/editdrop-review')
mkdirSync(cache, { recursive: true })
for (const [label, file, from, to, name] of cases) {
  const source = originals.get(file)
  assert.equal(source.split(from).length, 2, `${label}: one mutation site`)
  const dir = mkdtempSync(join(cache, 'mutant-'))
  try {
    cpSync(join(root, 'lib'), join(dir, 'lib'), { recursive: true })
    mkdirSync(join(dir, 'test'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(dir, 'server.ts'), originals.get('server.ts'))
    writeFileSync(join(dir, 'test/message-edits.test.ts'), originals.get('test/message-edits.test.ts'))
    writeFileSync(join(dir, file), source.replace(from, to))
    console.log(`\nMUTATION ${label}\nFILE ${file}\nREPLACE ${from}\nWITH ${to}`)
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=4', '--test-timeout=10000', `--test-name-pattern=^${name}`, join(dir, 'test/message-edits.test.ts')], { cwd: root, encoding: 'utf8', timeout: 20000 })
    const output = result.stdout + result.stderr
    process.stdout.write(output)
    assert.equal(result.status, 1, `${label}: mutant must fail`)
    assert.match(output, /AssertionError/, `${label}: assertion-based failure`)
    assert.doesNotMatch(output, /test timed out|TypeError:|ReferenceError:/, `${label}: no timeout or harness error`)
    console.log(`KILLED ${label}; exit=${result.status}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
for (const [path, text] of originals) assert.equal(readFileSync(join(root, path), 'utf8'), text, path)
console.log(`\nALL ${cases.length} REVIEW MUTANTS KILLED; source unchanged`)
